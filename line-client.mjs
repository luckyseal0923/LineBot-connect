// LINE owns this fixed HTTPS endpoint. No caller-provided URL or redirects.
export function createLineBotLookup({ fetchImpl = fetch } = {}) {
 return async function lookup(accessToken) {
  if(typeof accessToken!=='string' || !accessToken || Buffer.byteLength(accessToken)>4096 || /[\r\n]/.test(accessToken)) return null;
  let response;
  try {response=await fetchImpl('https://api.line.me/v2/bot/info',{headers:{Authorization:`Bearer ${accessToken}`},redirect:'error',signal:AbortSignal.timeout(10000)});}catch{return null;}
  if(!response.ok)return null;
  let info;try{info=await response.json();}catch{return null;}
  if(typeof info.userId!=='string'||!/^U[0-9a-f]{32}$/.test(info.userId)||typeof info.displayName!=='string'||info.displayName.length<1||info.displayName.length>200)return null;
  return {userId:info.userId,displayName:info.displayName};
 };
}

export function createLineWebhookCheck({ fetchImpl = fetch } = {}) {
  return async function check(accessToken, expectedUrl) {
    if (!accessToken || /[\r\n]/.test(accessToken)) return 'unavailable';
    const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    const options = { headers, redirect: 'error', signal: AbortSignal.timeout(10000) };
    try {
      const config = await fetchImpl('https://api.line.me/v2/bot/channel/webhook/endpoint', options);
      if (config.status === 404) return 'not_configured';
      if (!config.ok) return 'unavailable';
      const { endpoint, active } = await config.json();
      if (typeof endpoint !== 'string' || typeof active !== 'boolean') return 'unavailable';
      if (new URL(endpoint).href !== expectedUrl) return 'url_mismatch';

      const test = await fetchImpl('https://api.line.me/v2/bot/channel/webhook/test', {
        ...options, method: 'POST', body: JSON.stringify({ endpoint: expectedUrl })
      });
      if (!test.ok) return 'unavailable';
      const { success } = await test.json();
      if (typeof success !== 'boolean') return 'unavailable';
      if (!success) return 'failed';
      return active ? 'verified' : 'verified_inactive';
    } catch {
      return 'unavailable';
    }
  };
}
