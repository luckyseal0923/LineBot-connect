// A conservative global limit avoids trusting client-controlled proxy headers.
// It also protects the shared database and the bounded password hashing pool.
export function createRequestLimiter({ db }) {
  if (!db?.query) throw new Error('Missing limiter database');
  return async function allow(scope) {
    const limits = { register: [20,3600], login: [120,60] };
    if (!Object.hasOwn(limits,scope)) throw new Error('Invalid limit scope');
    const [max, seconds]=limits[scope];
    const result=await db.query(`insert into linebot_private.request_limits(scope,window_start,hits) values ($1,now(),1)
      on conflict(scope) do update set window_start=case when linebot_private.request_limits.window_start <= now()-($2::int * interval '1 second') then now() else linebot_private.request_limits.window_start end,
      hits=case when linebot_private.request_limits.window_start <= now()-($2::int * interval '1 second') then 1 else linebot_private.request_limits.hits+1 end
      returning hits`,[scope,seconds]);
    return result.rows[0].hits <= max;
  };
}
