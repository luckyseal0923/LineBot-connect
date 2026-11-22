import { randomUUID,randomBytes,scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { generateSecret,generateURI,verify } from 'otplib';
import QRCode from 'qrcode';
const scrypt=promisify(scryptCallback);
// This object is for a trusted local onboarding process only. Never log the
// returned QR/URI, send it to an external QR generator, or expose it publicly.
export async function createAdminEnrollment({db,vault,username,password,clock=()=>new Date(),makeSecret=generateSecret}){
 if(!db?.query||!vault?.seal||typeof username!=='string'||!/^[a-z0-9_]{3,32}$/.test(username)||typeof password!=='string'||password.length<14||Buffer.byteLength(password)>128)throw Error('Invalid enrollment');
 const id=randomUUID(),salt=randomBytes(16).toString('hex');
 const hash=(await scrypt(password,Buffer.from(salt,'hex'),64,{N:16384,r:8,p:1,maxmem:64*1024*1024})).toString('hex');
 const secret=makeSecret(),created=clock().getTime();let attempts=0,done=false;
 const uri=generateURI({issuer:'LINEBOT Connect',label:username,secret});
 const qr=await QRCode.toString(uri,{type:'utf8',errorCorrectionLevel:'M'});
 return {
  qr,
  async confirm(otp){
   if(done||clock().getTime()-created>10*60*1000||attempts++>=5)return false;
   if(typeof otp!=='string'||!/^\d{6}$/.test(otp))return false;
   const result=await verify({secret,token:otp,epoch:Math.floor(clock().getTime()/1000),epochTolerance:30});
   if(!result.valid)return false;
   done=true;
   await db.query('select linebot_private.enroll_initial_admin($1,$2,$3,$4,$5::jsonb,$6)',[id,username,salt,hash,JSON.stringify(vault.seal(id,secret)),result.timeStep]);
   return true;
  }
 };
}
