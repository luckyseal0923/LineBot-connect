import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';

const callbackPath = '/auth/google/callback';
const flowPattern = /^((?:admin_)?[A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})\.(\d{10})\.([A-Za-z0-9_-]{43})$/;
const fresh = () => randomBytes(32).toString('base64url');

function verifiedIdentity(claims, nonce) {
  if (claims?.nonce !== nonce || claims.email_verified !== true || typeof claims.sub !== 'string' ||
      !/^[!-~]{1,255}$/.test(claims.sub) || typeof claims.email !== 'string' ||
      claims.email.length > 254 || !/^[^\s@\0]+@[^\s@\0]+\.[^\s@\0]+$/.test(claims.email)) return null;
  const email = claims.email.toLowerCase();
  const name = typeof claims.name === 'string' ? claims.name.replaceAll('\0','').trim() : '';
  return {
    subject: claims.sub,
    email,
    displayName: [...(name || email)].slice(0,100).join(''),
    hostedDomain: typeof claims.hd === 'string' ? claims.hd.toLowerCase() : null
  };
}

export function createGoogleOAuth({ login, sessionCookie, successPath, errorPath, admin = false, redirectOrigin, key, allow, publicOrigin, clientId, clientSecret,
  fetchImpl = fetch, verifyIdToken, clock = Date.now }) {
  if (!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId || '') ||
      typeof clientSecret !== 'string' || !clientSecret || /[\r\n]/.test(clientSecret)) {
    throw new Error('Google sign-in credentials are incomplete');
  }
  const origin = new URL(publicOrigin);
  const redirectUri = new URL(callbackPath, redirectOrigin || origin).href;
  const secure = origin.protocol === 'https:' ? '; Secure' : '';
  const flowCookie = admin ? (secure ? '__Host-linebot_admin_google_flow' : 'linebot_admin_google_flow') : 'linebot_google_flow';
  const cookiePath = admin ? '/' : '/auth/google';
  const purpose = admin ? 'linebot-admin-google-flow:v1:' : 'linebot-google-flow:v1:';
  const google = new OAuth2Client({ clientId, transporterOptions: { timeout: 8000 } });
  const verify = verifyIdToken || (async idToken => (await google.verifyIdToken({ idToken, audience: clientId })).getPayload());
  const sign = payload => createHmac('sha256', key).update(purpose + payload).digest('base64url');
  const cookie = (value, maxAge) => flowCookie + '=' + value +
    '; Path=' + cookiePath + '; HttpOnly; SameSite=Lax' + secure + '; Max-Age=' + maxAge;
  const redirect = (res, to, cookies) => {
    res.writeHead(303, {
      Location: to, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'Set-Cookie': cookies
    });
    res.end();
  };
  const failure = (res, state) => redirect(res, errorPath + state, cookie('', 0));

  return async function signIn(req,res,path) {
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow:'GET', 'Cache-Control':'no-store' });
      res.end();
      return;
    }
    const query = new URL(req.url, origin).searchParams;
    const now = Math.floor(clock() / 1000);
    try {
      if (path === '/auth/google/start') {
        if (!await allow(admin ? 'admin-login' : 'login')) return failure(res, 'busy');
        const state = (admin ? 'admin_' : '') + fresh(), nonce = fresh(), verifier = fresh();
        const flow = [state,nonce,verifier,now + 600].join('.');
        const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        auth.search = new URLSearchParams({
          client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
          scope: 'openid email profile', prompt: 'select_account', state, nonce,
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256'
        });
        return redirect(res, auth.href, cookie(flow + '.' + sign(flow), 600));
      }

      const saved = (req.headers.cookie || '').split(/;\s*/).find(field => field.startsWith(flowCookie + '='));
      const match = flowPattern.exec(saved?.slice(flowCookie.length + 1) || '');
      if (!match || (match[1].length > 43) !== admin) return failure(res, 'expired');
      const [, state, nonce, verifier, expiry, mac] = match;
      if (!timingSafeEqual(Buffer.from(mac), Buffer.from(sign([state,nonce,verifier,expiry].join('.')))) ||
          query.get('state') !== state || Number(expiry) <= now) return failure(res, 'expired');
      if (query.has('error')) return failure(res, query.get('error') === 'access_denied' ? 'cancelled' : 'unavailable');
      const code = query.get('code');
      if (!code || code.length > 4096) return failure(res, 'expired');
      if (!await allow(admin ? 'admin-login' : 'login')) return failure(res, 'busy');

      const tokenResponse = await fetchImpl('https://oauth2.googleapis.com/token', {
        method:'POST', redirect:'error', signal:AbortSignal.timeout(8000),
        body:new URLSearchParams({
          code, client_id:clientId, client_secret:clientSecret, redirect_uri:redirectUri,
          grant_type:'authorization_code', code_verifier:verifier
        })
      });
      if (!tokenResponse.ok) return failure(res, 'unavailable');
      const tokens = await tokenResponse.json();
      if (typeof tokens.id_token !== 'string') return failure(res, 'unavailable');
      const identity = verifiedIdentity(await verify(tokens.id_token), nonce);
      if (!identity) return failure(res, 'identity');
      const result = await login(identity);
      if (result.status !== 'ok') return failure(res, 'disabled');
      return redirect(res, successPath, [cookie('',0), sessionCookie(origin, result.token)]);
    } catch {
      return failure(res, 'unavailable');
    }
  };
}
