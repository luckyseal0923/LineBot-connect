import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
const tokenDigest = token => createHash('sha256').update(token).digest('hex');
const validUser = value => typeof value === 'string' && /^[a-z0-9_]{3,32}$/.test(value);
const validPassword = value => typeof value === 'string' && value.length >= 8 && Buffer.byteLength(value) <= 128;
const dummySalt = '00000000000000000000000000000000';
const dummyHash = Buffer.alloc(64);
let hashing=0;
async function derive(password, salt) {
  // Bound expensive hashing so a burst cannot exhaust the shared host.
  if (hashing >= 2) throw new Error('busy');
  hashing++;
  try { return await scrypt(password, Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }); }
  finally { hashing--; }
}

// All methods require an app-only DB role. Do not use the shared service role.
export function createAccounts({ db, clock = () => new Date() }) {
  if (!db?.query) throw new Error('Missing account database');
  return {
    async register({ username, displayName, password }) {
      if (!validUser(username) || !validPassword(password) || typeof displayName !== 'string' || !displayName.trim() || displayName.trim().length > 100) return { status: 'invalid' };
      const salt = randomBytes(16).toString('hex');
      const hash = (await derive(password, salt)).toString('hex');
      const result = await db.query(`insert into linebot_private.accounts (username,display_name,password_salt,password_hash)
        values ($1,$2,$3,$4) on conflict (username) do nothing returning id,webhook_key`, [username, displayName.trim(), salt, hash]);
      return result.rows.length ? { status: 'created' } : { status: 'unavailable' };
    },
    async login({ username, password }) {
      if (!validUser(username) || typeof password !== 'string' || Buffer.byteLength(password) > 128) return { status: 'invalid' };
      const result = await db.query('select id,password_salt,password_hash,status,locked_until from linebot_private.accounts where username=$1', [username]);
      const account = result.rows[0];
      const actual = await derive(password, account?.password_salt || dummySalt);
      const expected = account ? Buffer.from(account.password_hash, 'hex') : dummyHash;
      const matches = expected.length === actual.length && timingSafeEqual(actual, expected);
      const now = clock();
      if (!account || account.status === 'disabled') return { status: 'invalid' };
      if (account.locked_until && new Date(account.locked_until) > now) return { status: 'invalid' };
      if (!matches) {
        await db.query(`update linebot_private.accounts set failed_attempts=failed_attempts+1,
          locked_until=case when failed_attempts+1 >= 5 then $2::timestamptz + interval '15 minutes' else locked_until end
          where id=$1`, [account.id, now]);
        return { status: 'invalid' };
      }
      await db.query('update linebot_private.accounts set failed_attempts=0,locked_until=null where id=$1', [account.id]);
      const token = randomBytes(32).toString('base64url');
      await db.query('insert into linebot_private.sessions (token_hash,account_id,expires_at) values ($1,$2,$3)', [tokenDigest(token), account.id, new Date(now.getTime()+8*60*60*1000)]);
      return { status: 'ok', token };
    },
    async me(token) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const result = await db.query(`select a.id,a.username,a.display_name,a.webhook_key,a.status from linebot_private.sessions s
        join linebot_private.accounts a on a.id=s.account_id where s.token_hash=$1 and s.expires_at>$2 and a.status in ('pending','active')`, [tokenDigest(token), clock()]);
      return result.rows[0] || null;
    },
    async logout(token) {
      if (typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)) await db.query('delete from linebot_private.sessions where token_hash=$1', [tokenDigest(token)]);
    }
  };
}
