import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createAccounts } from './accounts.mjs';
import { createLinebotServer } from './app-server.mjs';
import { createGoogleSignIn } from './google-signin.mjs';

test('Google sign-in enforces browser state, creates a scoped developer session and applies the review policy', async () => {
  const db = new PGlite();
  let server;
  try {
    await db.exec("create role anon; create role authenticated; create role linebot_runtime; create role linebot_reviewer; create role linebot_admin_auth; set linebot.isolated_test='yes'");
    const migrations = ['005_independent_accounts','006_runtime_grants','007_review_retention','011_multiple_bots',
      '012_notifications','013_admin_monitoring','025_google_signin'];
    for (const file of migrations) await db.exec(await readFile(new URL('./db/' + file + '.sql',import.meta.url), 'utf8'));

    const accounts = createAccounts({ db });
    const origin = 'http://127.0.0.1:39198';
    const clientId = 'linebot-test.apps.googleusercontent.com';
    let googleRequest, claims, searches = 0, now = Date.now();
    const allow = async () => true;
    const oauth = createGoogleSignIn({ accounts, key:randomBytes(32), allow, publicOrigin:origin,
      clientId, clientSecret:'isolated-fixture', clock:() => now,
      fetchImpl: async (url, options) => {
        searches++;
        assert.equal(url, 'https://oauth2.googleapis.com/token');
        assert.equal(options.body.get('redirect_uri'), origin + '/auth/google/callback');
        assert.equal(options.body.get('grant_type'), 'authorization_code');
        assert.equal(createHash('sha256').update(options.body.get('code_verifier')).digest('base64url'), googleRequest.get('code_challenge'));
        return Response.json({ id_token:'verified-in-fixture' });
      },
      verifyIdToken: async token => {
        assert.equal(token, 'verified-in-fixture');
        return claims;
      }
    });
    server = createLinebotServer({ accounts, bots:{findByWebhook:async()=>null}, vault:{open(){}},
      allow, lookupBot:async()=>null, publicOrigin:origin, googleSignIn:oauth });
    server.listen(39198,'127.0.0.1');
    await once(server,'listening');
    await db.exec('set role linebot_runtime');
    const send = (path, options = {}) => fetch(origin + path, { redirect:'manual', ...options });
    assert.deepEqual(await (await send('/independent-api/status')).json(), {enabled:true,googleLogin:true});
    for (const action of ['login','register']) {
      assert.equal((await send('/independent-api/' + action,{method:'POST',headers:{Origin:origin},body:'{}'})).status, 410);
    }
    async function begin() {
      const response = await send('/auth/google/start');
      assert.equal(response.status, 303);
      const location = new URL(response.headers.get('location'));
      assert.equal(location.origin, 'https://accounts.google.com');
      googleRequest = location.searchParams;
      assert.equal(googleRequest.get('client_id'), clientId);
      assert.equal(googleRequest.get('code_challenge_method'), 'S256');
      assert.equal(googleRequest.get('scope'), 'openid email profile');
      const cookie = response.headers.get('set-cookie');
      assert.match(cookie,/HttpOnly; SameSite=Lax/);
      return cookie.split(';')[0];
    }
    function callback(cookie, state = googleRequest.get('state')) {
      return send('/auth/google/callback?code=fixture&state=' + state, {headers:{Cookie:cookie}});
    }
    async function googleLogin(claimOverrides) {
      const cookie = await begin();
      claims = {nonce:googleRequest.get('nonce'),email_verified:true,name:'Google 測試開發者',...claimOverrides};
      return callback(cookie);
    }
    async function session(response) {
      assert.equal(response.status,303);
      assert.equal(response.headers.get('location'),'/#platforms');
      const value = response.headers.getSetCookie().find(cookie => cookie.startsWith('linebot_sid='));
      assert.match(value,/HttpOnly; SameSite=Strict/);
      return (await send('/independent-api/me',{headers:{Cookie:value.split(';')[0]}})).json();
    }

    let flow = await begin();
    assert.match((await callback(flow, 'unmatched')).headers.get('location'), /google=expired$/);
    assert.match((await callback(flow.replace(/.$/, end => end === 'a' ? 'b' : 'a'))).headers.get('location'), /google=expired$/);
    now += 601_000;
    assert.match((await callback(flow)).headers.get('location'), /google=expired$/);
    assert.equal(searches,0);
    assert.match((await googleLogin({sub:'bad-nonce', email:'fixture@w.tmu.edu.tw', nonce:'unrelated'})).headers.get('location'), /google=identity$/);
    assert.match((await googleLogin({sub:'unverified', email:'fixture@w.tmu.edu.tw', email_verified:false})).headers.get('location'), /google=identity$/);

    const hospital = {sub:'hospital', email:'TEST@W.TMU.EDU.TW', hd:'tmu.edu.tw'};
    const approved = await session(await googleLogin(hospital));
    assert.equal(approved.status,'active');
    const returning = await session(await googleLogin(hospital));
    assert.equal(returning.username,approved.username);

    const external = {sub:'external',email:'fixture@example.com'};
    const pending = await session(await googleLogin(external));
    assert.equal(pending.status,'pending');
    const unmanaged = await session(await googleLogin({sub:'unmanaged',email:'fixture@w.tmu.edu.tw'}));
    assert.equal(unmanaged.status,'pending');
    const otherDomain = await session(await googleLogin({sub:'other-domain',email:'fixture@tmu.edu.tw',hd:'tmu.edu.tw'}));
    assert.equal(otherDomain.status,'pending');
    const lookalike = await session(await googleLogin({sub:'lookalike',email:'fixture@w.tmu.edu.tw.example.com',hd:'w.tmu.edu.tw'}));
    assert.equal(lookalike.status,'pending');

    await db.exec('reset role; set role linebot_reviewer');
    const { rows: [unreviewed] } = await db.query('select google_email from linebot_private.accounts where username=$1',[pending.username]);
    assert.equal(unreviewed.google_email, external.email);
    const audit = await db.query("select * from linebot_private.admin_review_audit where actor='google'");
    assert.equal(audit.rows.length,1);
    assert.equal(audit.rows[0].username,approved.username);
    await db.query('select linebot_private.review_account($1,$2,$3)',[pending.username,'active','approved during isolated test']);
    await db.query('select linebot_private.review_account($1,$2,$3)',[approved.username,'disabled','disabled during isolated test']);
    await db.exec('reset role; set role linebot_runtime');
    assert.equal((await session(await googleLogin(external))).status,'active');
    assert.match((await googleLogin(hospital)).headers.get('location'),/google=disabled$/);
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await db.close();
  }
});
