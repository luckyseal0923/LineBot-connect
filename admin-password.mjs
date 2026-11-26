import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
const digest = value => createHash('sha256').update(value).digest('hex');
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
let running = 0;
async function derive(password, salt) {
 if (running >= 2) throw Error('busy');
 running++;
 try { return await scrypt(password, Buffer.from(salt, 'hex'), 64, { N:16384, r:8, p:1, maxmem:64*1024*1024 }); }
 finally { running--; }
}
export function createAdminPassword({ db, clock = () => new Date() }) {
 if (!db?.query) throw Error('Missing admin database');
 return {
  async login({ username, password }) {
   if (typeof username !== 'string' || !/^[a-z0-9_]{3,32}$/.test(username) || typeof password !== 'string' || Buffer.byteLength(password) > 128) return null;
   const row = (await db.query('select * from linebot_private.admin_auth where username=$1', [username])).rows[0];
   const hash = await derive(password, row?.password_salt || '00000000000000000000000000000000');
   const saved = row ? Buffer.from(row.password_hash, 'hex') : Buffer.alloc(64);
   const match = saved.length === hash.length && timingSafeEqual(hash, saved), now = clock();
   if (!row || row.google_email || !row.enabled || (row.locked_until && new Date(row.locked_until) > now)) {
    await db.query('insert into linebot_private.admin_login_audit(admin_id,outcome) values ($1,$2)', [row?.id || null, 'denied']);
    return null;
   }
   if (!match) {
    await db.query(`update linebot_private.admin_auth set failed_attempts=failed_attempts+1,
     locked_until=case when failed_attempts+1>=5 then $2::timestamptz+interval '15 minutes' else locked_until end where id=$1`, [row.id, now]);
    await db.query('insert into linebot_private.admin_login_audit(admin_id,outcome) values ($1,$2)', [row.id, 'denied']);
    return null;
   }
   const updated = await db.query(`update linebot_private.admin_auth set failed_attempts=0,locked_until=null
    where id=$1 and enabled=true and (locked_until is null or locked_until<=$2) returning id`, [row.id, now]);
   if (!updated.rows.length) return null;
   await db.query('insert into linebot_private.admin_login_audit(admin_id,outcome) values ($1,$2)', [row.id, 'success']);
   const token = randomBytes(32).toString('base64url');
   await db.query('insert into linebot_private.admin_sessions(token_hash,admin_id,expires_at) values ($1,$2,$3)', [digest(token),row.id,new Date(now.getTime()+15*60*1000)]);
   return token;
  },
  async loginWithGoogle({email,subject,hostedDomain}) {
   // The caller has verified Google's signature, audience, email and nonce.
   // For non-Gmail addresses require a Google Workspace-managed identity.
   if (!email.endsWith('@gmail.com') && !hostedDomain) return {status:'denied'};
   const token=randomBytes(32).toString('base64url');
   const expiry=new Date(clock().getTime()+15*60*1000);
   const {rows}=await db.query(`with allowed as (
     update linebot_private.admin_auth set google_subject=$2
     where enabled and google_email=$1 and (google_subject is null or google_subject=$2)
     returning id
   ), audit as (
     insert into linebot_private.admin_login_audit(admin_id,outcome)
     select (select id from allowed),case when exists(select 1 from allowed) then 'success' else 'denied' end
   ) insert into linebot_private.admin_sessions(token_hash,admin_id,expires_at)
     select $3,id,$4 from allowed returning admin_id`,[email,subject,digest(token),expiry]);
   return rows.length ? {status:'ok',token} : {status:'denied'};
  },
  async session(token) {
   if (typeof token !== 'string' || !tokenPattern.test(token)) return null;
   const result = await db.query(`select a.id,a.google_email is not null as google from linebot_private.admin_sessions s join linebot_private.admin_auth a on a.id=s.admin_id
    where s.token_hash=$1 and s.expires_at>$2 and a.enabled=true`, [digest(token),clock()]);
   const admin=result.rows[0];
   return !admin ? null : admin.google ? {id:admin.id,googleVerified:true} : {id:admin.id,passwordVerified:true};
  },
  async logout(token) { if (typeof token === 'string' && tokenPattern.test(token)) await db.query('delete from linebot_private.admin_sessions where token_hash=$1',[digest(token)]); }
 };
}
