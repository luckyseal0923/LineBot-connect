import pg from 'pg';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { createCredentialVault } from './line-webhook.mjs';
import { createAdminEnrollment } from './admin-enrollment.mjs';
import { createEnrollmentDb } from './admin-enrollment-db.mjs';
import { createVerifiedDatabaseConfig } from './db-tls-config.mjs';
// This must be run by the owner directly in a private, non-recorded terminal.
// Never run from an automated terminal that records or shares its screen.
if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('A private interactive terminal is required');
const {LINEBOT_ENROLL_DATABASE_URL,LINEBOT_ADMIN_ENCRYPTION_KEY}=process.env;
if(!LINEBOT_ENROLL_DATABASE_URL||!/^[A-Za-z0-9+/]{43}=$/.test(LINEBOT_ADMIN_ENCRYPTION_KEY||''))throw Error('Enrollment configuration is incomplete');
let muted=false;const output=new Writable({write(chunk,encoding,callback){if(!muted)process.stdout.write(chunk,encoding);callback();}});
const rl=readline.createInterface({input:process.stdin,output,terminal:true});
const ask=(label,hidden=false)=>new Promise(resolve=>{muted=hidden;if(hidden)process.stdout.write(label);rl.question(hidden?'':label,value=>{muted=false;if(hidden)process.stdout.write('\n');resolve(value);});});
const db=createEnrollmentDb(()=>new pg.Client(createVerifiedDatabaseConfig(LINEBOT_ENROLL_DATABASE_URL,process.env.LINEBOT_DB_CA_CERT_BASE64,{connectionTimeoutMillis:5000,statement_timeout:5000,application_name:'linebot_initial_enrollment'})));
try{
 const username=await ask('管理員帳號（小寫英文、數字、底線）: ');
 const password=await ask('管理員密碼（至少 14 字元）: ',true);
 const repeat=await ask('再次輸入密碼: ',true);
 if(password!==repeat)throw Error('密碼不一致');
 const vault=createCredentialVault(Buffer.from(LINEBOT_ADMIN_ENCRYPTION_KEY,'base64'),{context:'admin-totp'});
 const enrollment=await createAdminEnrollment({db,vault,username,password});
 process.stdout.write('\n請使用驗證器 App 掃描（勿截圖或分享）：\n'+enrollment.qr+'\n');
 process.stdout.write('無法掃描時，請在驗證器 App 選手動輸入設定金鑰：'+enrollment.manualKey+'\n請勿複製、截圖或分享此金鑰。\n');
 for(let i=0;i<5;i++){
  const otp=await ask('輸入驗證器六位動態碼: ',true);
  if(await enrollment.confirm(otp)){process.stdout.write('管理員已建立，請等待下一組動態碼登入。\n');break;}
  if(i===4)throw Error('驗證失敗，請重新開始');
  process.stdout.write('驗證碼不正確，請重試。\n');
 }
} finally {rl.close();}
