import { createHash,randomBytes,scrypt as scryptCallback,timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { verify } from 'otplib';
const scrypt=promisify(scryptCallback);
const digest=value=>createHash('sha256').update(value).digest('hex');
const tokenPattern=/^[A-Za-z0-9_-]{43}$/;
let running=0;
async function derive(password,salt){
 if(running>=2)throw Error('busy');running++;
 try{return await scrypt(password,Buffer.from(salt,'hex'),64,{N:16384,r:8,p:1,maxmem:64*1024*1024});}finally{running--;}
}
export function createAdminMfa({db,vault,clock=()=>new Date()}){
 if(!db?.query||!vault?.open)throw Error('Missing admin MFA dependencies');
 return {
  async login({username,password,otp}){
   if(typeof username!=='string'||!/^[a-z0-9_]{3,32}$/.test(username)||typeof password!=='string'||Buffer.byteLength(password)>128||typeof otp!=='string'||!/^\d{6}$/.test(otp))return null;
   const row=(await db.query('select * from linebot_private.admin_auth where username=$1',[username])).rows[0];
   const hash=await derive(password,row?.password_salt||'00000000000000000000000000000000');
   const saved=row?Buffer.from(row.password_hash,'hex'):Buffer.alloc(64);
   const match=saved.length===hash.length&&timingSafeEqual(hash,saved);
   const now=clock();
   if(!row||!row.enabled||(row.locked_until&&new Date(row.locked_until)>now))return null;
   let totp=null;
   try {if(match) totp=await verify({secret:vault.open(row.id,row.encrypted_totp),token:otp,epoch:Math.floor(now.getTime()/1000),epochTolerance:30,...(Number(row.last_totp_step)>=0?{afterTimeStep:Number(row.last_totp_step)}:{})});}catch{}
   if(!match||!totp?.valid){
    await db.query(`update linebot_private.admin_auth set failed_attempts=failed_attempts+1,
      locked_until=case when failed_attempts+1>=5 then $2::timestamptz+interval '15 minutes' else locked_until end where id=$1`,[row.id,now]);return null;
   }
   // Atomic compare-and-set prevents two simultaneous logins using one code.
   const updated=await db.query(`update linebot_private.admin_auth set last_totp_step=$2,failed_attempts=0,locked_until=null
      where id=$1 and enabled=true and last_totp_step<$2 and (locked_until is null or locked_until<=$3) returning id`,[row.id,totp.timeStep,now]);
   if(!updated.rows.length)return null;
   const token=randomBytes(32).toString('base64url');
   await db.query('insert into linebot_private.admin_sessions(token_hash,admin_id,expires_at) values ($1,$2,$3)',[digest(token),row.id,new Date(now.getTime()+15*60*1000)]);
   return token;
  },
  async session(token){
   if(typeof token!=='string'||!tokenPattern.test(token))return null;
   const result=await db.query(`select a.id from linebot_private.admin_sessions s join linebot_private.admin_auth a on a.id=s.admin_id
     where s.token_hash=$1 and s.expires_at>$2 and a.enabled=true`,[digest(token),clock()]);
   return result.rows[0]?{id:result.rows[0].id,mfaVerified:true}:null;
  },
  async logout(token){if(typeof token==='string'&&tokenPattern.test(token))await db.query('delete from linebot_private.admin_sessions where token_hash=$1',[digest(token)]);}
 };
}
