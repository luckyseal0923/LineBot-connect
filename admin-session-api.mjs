// Intended for the dedicated admin service only, with HTTPS and protected DB.
export function createAdminSessionApi({mfa,allow,publicOrigin}){
 if(!mfa?.login||!mfa?.session||!mfa?.logout||typeof allow!=='function')throw Error('Missing admin session dependencies');
 const origin=new URL(publicOrigin);
 if(origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password||(origin.protocol!=='https:'&&!(origin.protocol==='http:'&&['127.0.0.1','localhost'].includes(origin.hostname))))throw Error('Invalid origin');
 const secure=origin.protocol==='https:'?'; Secure':'';
 const readToken=req=>/(?:^|;\s*)linebot_admin=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie||'')?.[1];
 const send=(res,status,body,extra={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra});res.end(JSON.stringify(body));};
 return {
  authorize: req=>mfa.session(readToken(req)),
  async handle(req,res){
   const path=new URL(req.url,origin).pathname;if(!path.startsWith('/admin-session/'))return false;
   if(req.method!=='POST'){send(res,405,{error:'不支援的操作'});return true;}
   if(req.headers.origin!==origin.origin){send(res,403,{error:'來源不正確'});return true;}
   try{
    if(path==='/admin-session/login'){
     if(!await allow('admin-login')){send(res,429,{error:'嘗試次數過多，請稍後再試。'});return true;}
     let n=0;const chunks=[];for await(const chunk of req){n+=chunk.length;if(n>4096){send(res,413,{error:'資料過大'});return true;}chunks.push(chunk);}
     let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{send(res,400,{error:'資料格式不正確'});return true;}
     const token=await mfa.login(data);if(!token){send(res,401,{error:'帳號、密碼或動態碼不正確。'});return true;}
     send(res,200,{message:'登入成功'},{'Set-Cookie':`linebot_admin=${token}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=900`});return true;
    }
    if(path==='/admin-session/logout'){
     await mfa.logout(readToken(req));send(res,200,{message:'已登出'},{'Set-Cookie':`linebot_admin=; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=0`});return true;
    }
    send(res,404,{error:'找不到功能'});return true;
   }catch{send(res,503,{error:'管理服務暫時無法使用。'});return true;}
  }
 };
}
