// A conservative global limit avoids trusting client-controlled proxy headers.
// It also protects the shared database and the bounded password hashing pool.
export function createRequestLimiter({ db }) {
  if (!db?.query) throw new Error('Missing limiter database');
  return async function allow(scope) {
    const limits = {
      register: [20,3600], login: [120,60], pairing: [60,60], notify: [60,60], 'webhook-check': [40,60],
      'external-api': [360,60], 'external-submit': [30,60], 'integration-manage': [60,60], 'platform-manage': [60,60]
    };
    const scopedLimits = {
      'pair-user': [5,600], 'pair-bot': [100,600], 'recipient-join': [120,60], pairing: [5,60], notify: [10,60], 'webhook-check': [12,3600],
      support: [8,600], 'developer-profile': [10,60], 'external-account': [10,60], 'external-integration': [5,60], 'integration-manage': [12,60], 'platform-manage': [12,60]
    };
    const scoped = /^([a-z-]+):[0-9a-f-]{36}$/.exec(scope) || /^(pair-user):[0-9a-f]{64}$/.exec(scope);
    const limit = scoped ? scopedLimits[scoped[1]] : limits[scope];
    if (!Array.isArray(limit)) throw new Error('Invalid limit scope');
    const [max, seconds] = limit;
    const result=await db.query(`insert into linebot_private.request_limits(scope,window_start,hits) values ($1,now(),1)
      on conflict(scope) do update set window_start=case when linebot_private.request_limits.window_start <= now()-($2::int * interval '1 second') then now() else linebot_private.request_limits.window_start end,
      hits=case when linebot_private.request_limits.window_start <= now()-($2::int * interval '1 second') then 1 else linebot_private.request_limits.hits+1 end
      returning hits`,[scope,seconds]);
    return result.rows[0].hits <= max;
  };
}
