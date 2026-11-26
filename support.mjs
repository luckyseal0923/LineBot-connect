const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const maxBytes = 2 * 1024 * 1024;

function unpackImage(image) {
  if (image == null) return { type: null, bytes: null };
  if (typeof image.data !== 'string' || !image.data.length ||
      image.data.length > 4 * Math.ceil(maxBytes / 3)) return null;
  const bytes = Buffer.from(image.data, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== image.data) return null;
  const png = bytes.length >= 33 && bytes.subarray(0,8).toString('hex') === '89504e470d0a1a0a' && bytes.toString('ascii',12,16) === 'IHDR';
  const jpeg = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.readUInt16BE(bytes.length-2) === 0xffd9;
  if (image.type === 'image/png' && png || image.type === 'image/jpeg' && jpeg) return { type:image.type, bytes };
  return null;
}

export async function supportRequest({db, req, res, send, url, user, allow}) {
  const platform = url.searchParams.get('platform');
  const admin = !user;
  const imageRoute = url.pathname.endsWith('/image');
  if (!admin && !uuid.test(platform || '')) return send(res,400,{error:'請先選擇網站。'});
  const values = admin ? [] : [user.id,platform];
  const where = admin ? 'true' : 's.account_id=$1 and s.platform_id=$2';
  if (req.method === 'GET' && imageRoute) {
    const id = url.searchParams.get('id');
    if (!uuid.test(id || '')) return send(res,400,{error:'圖片編號有誤。'});
    values.push(id);
    const {rows:[row]} = await db.query(`select image_type,image_bytes from linebot_private.support_messages s where ${where} and id=$${values.length} and image_type is not null`,values);
    if (!row) return send(res,404,{error:'找不到圖片。'});
    res.writeHead(200,{'Content-Type':row.image_type,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"});
    return res.end(row.image_bytes);
  }
  if (req.method === 'GET') {
    const offset = Number(url.searchParams.get('offset') || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) return send(res,400,{error:'頁碼有誤。'});
    values.push(offset);
    const source = admin ? 'linebot_private.support_inbox' : 'linebot_private.support_messages';
    const sender = admin ? ',s.display_name,s.google_email' : '';
    const { rows } = await db.query(`select s.id,s.subject,s.body,s.created_at,s.platform_name,s.image_type,s.mail_state${sender}
      from ${source} s where ${where} order by s.created_at desc,s.id desc limit 21 offset $${values.length}`,values);
    return send(res,200,{messages:rows.slice(0,20),more:rows.length>20});
  }
  if (req.method !== 'POST' || admin || imageRoute) return send(res,405,{error:'操作方式不正確。'});
  if (!await allow('support:'+user.id)) return send(res,429,{error:'送出次數過多，請稍後再試。'});
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2850000) return send(res,413,{error:'圖片上限為 2 MB。'});
    parts.push(chunk);
  }
  let data;
  try { data=JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return send(res,400,{error:'資料格式不正確。'}); }
  const subject = typeof data?.subject==='string' ? data.subject.trim() : '';
  const body = typeof data?.body==='string' ? data.body.trim() : '';
  const image = unpackImage(data?.image);
  if (!uuid.test(data?.id || '') || !subject || subject.length>120 || !body || body.length>4000 || /\x00/.test(subject+body) || !image)
    return send(res,400,{error:'請確認主旨、內容及 PNG 或 JPG 圖片格式。'});
  const inserted=await db.query(`insert into linebot_private.support_messages(id,account_id,platform_id,platform_name,subject,body,image_type,image_bytes)
    select $1,$2,p.id,coalesce(p.name,'未命名網站'),$4,$5,$6,$7 from linebot_private.platform_services p where p.id=$3 and p.account_id=$2 and p.deleted_at is null
    on conflict(id) do nothing returning id`,[data.id,user.id,platform,subject,body,image.type,image.bytes]);
  if (!inserted.rows.length) {
    const existing=await db.query('select id from linebot_private.support_messages where id=$1 and account_id=$2 and platform_id=$3 and subject=$4 and body=$5 and image_type is not distinct from $6 and image_bytes is not distinct from $7',[data.id,user.id,platform,subject,body,image.type,image.bytes]);
    if (!existing.rows.length) return send(res,409,{error:'網站或求助內容已變更，請重新送出。'});
  }
  return send(res,201,{id:data.id});
}
