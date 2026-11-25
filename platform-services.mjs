import { randomUUID } from 'node:crypto';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const safeName = name => typeof name === 'string' ? name.trim() : '';
const lineSetupLimits = {
  accountName: 80,
  organization: 120,
  region: 80,
  contactEmail: 254,
  industry: 80,
  subIndustry: 80,
  purpose: 240,
  providerName: 100
};

function cleanLineSetup(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const cleaned = {};
  for (const [field, value] of Object.entries(details)) {
    if (!Object.hasOwn(lineSetupLimits, field) || typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (trimmed.length > lineSetupLimits[field] || trimmed.includes('\0')) return null;
    if (trimmed) cleaned[field] = trimmed;
  }
  if (cleaned.contactEmail && !/^[^\s@]+@[^\s@]+$/.test(cleaned.contactEmail)) return null;
  return cleaned;
}

export function createPlatformServices({db}) {
  if (!db?.query) throw Error('Missing platform database');
  return {
    async list(accountId) {
      const {rows} = await db.query(`select p.id,p.name,p.bot_id as "botId",b.bot_name as "botName",b.enabled as "botEnabled"
        from linebot_private.platform_services p left join linebot_private.bot_credentials b on b.id=p.bot_id and b.account_id=p.account_id
        where p.account_id=$1 order by p.created_at,p.id`,[accountId]);
      return rows;
    },
    async create(accountId, name) {
      name=safeName(name); if(!name || name.length>80) return {error:'invalid'};
      const {rows}=await db.query(`insert into linebot_private.platform_services(id,account_id,name)
        select $2,id,$3 from linebot_private.accounts where id=$1 and status='active' returning id`,[accountId,randomUUID(),name]);
      return rows[0] || {error:'unavailable'};
    },
    async rename(accountId,id,name) {
      name=safeName(name);if(!uuid.test(id||'')||!name||name.length>80)return {error:'invalid'};
      const {rows}=await db.query('update linebot_private.platform_services set name=$3 where id=$2 and account_id=$1 returning id',[accountId,id,name]);
      return rows[0] || {error:'unavailable'};
    },
    async getLineSetup(accountId, id) {
      if (!uuid.test(id || '')) return { error: 'invalid' };
      const { rows } = await db.query(
        'select line_setup as "lineSetup" from linebot_private.platform_services where account_id=$1 and id=$2',
        [accountId, id]
      );
      return rows[0] || { error: 'unavailable' };
    },
    async saveLineSetup(accountId, id, input) {
      if (!uuid.test(id || '')) return { error: 'invalid' };
      const lineSetup = cleanLineSetup(input);
      if (!lineSetup) return { error: 'invalid' };
      const { rows } = await db.query(
        'update linebot_private.platform_services set line_setup=$3::jsonb where account_id=$1 and id=$2 returning line_setup as "lineSetup"',
        [accountId, id, JSON.stringify(lineSetup)]
      );
      return rows[0] || { error: 'unavailable' };
    },
    async attach(accountId,id,botId) {
      if(!uuid.test(id||'')||!uuid.test(botId||''))return {error:'invalid'};
      try {
        const {rows}=await db.query(`update linebot_private.platform_services p set bot_id=$3
          where p.account_id=$1 and p.id=$2 and p.bot_id is null
          and exists(select 1 from linebot_private.bot_credentials b where b.id=$3 and b.account_id=$1)
          returning p.id`,[accountId,id,botId]);
        return rows[0] || {error:'unavailable'};
      } catch(error) { if(error.code==='23505')return {error:'bot_in_use'}; throw error; }
    }
  };
}
