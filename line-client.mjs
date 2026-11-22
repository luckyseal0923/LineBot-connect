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
