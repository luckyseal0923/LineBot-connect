import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { createAccounts } from '../accounts.mjs';
import { createLinebotServer } from '../app-server.mjs';
import { createBotStore } from '../bot-store.mjs';
import { createExternalIntegrations } from '../external-integrations.mjs';
import { createCredentialVault } from '../line-webhook.mjs';
import { createNotifications } from '../notifications.mjs';
import { createPlatformServices } from '../platform-services.mjs';
import { createRequestLimiter } from '../request-limiter.mjs';
import { createLoanSource } from './loan-source.mjs';
import { createSourceSetup } from './source-setup.mjs';

const migrations = [
  '005_independent_accounts', '006_runtime_grants', '007_review_retention', '011_multiple_bots',
  '012_notifications', '013_admin_monitoring', '014_line_quota', '015_external_integrations', '017_platform_services'
];

function listen(server, port) {
  return new Promise((done, fail) => {
    server.listen(port, '127.0.0.1', done).once('error', fail);
  });
}

export async function startPilot({ port = 39261, sourcePort = 39262 } = {}) {
  const origin = 'http://127.0.0.1:' + port;
  // A different host keeps the station's session cookie away from the source.
  const sourceOrigin = 'http://localhost:' + sourcePort;
  const db = new PGlite();
  let hub, loanSource, worker, dispatch;

  async function close() {
    clearInterval(worker);
    await Promise.all([hub, loanSource].map(server => server?.listening
      ? new Promise(done => {
          server.close(done);
          server.closeAllConnections();
        })
      : undefined));
    await dispatch;
    await db.close();
  }

  try {
    await db.exec(`create role anon; create role authenticated; create role linebot_runtime;
      create role linebot_reviewer; create role linebot_admin_auth; create role linebot_enroller;
      set linebot.isolated_test='yes';`);
    for (const name of migrations) {
      await db.exec(await readFile(new URL('../db/' + name + '.sql', import.meta.url), 'utf8'));
    }

    const key = randomBytes(32);
    const vault = createCredentialVault(key);
    const recipientVault = createCredentialVault(key, { context: 'line-recipient' });
    const tokenVault = createCredentialVault(key, { context: 'channel-access-token' });
    const accounts = createAccounts({ db });
    const bots = createBotStore({ db, vault, tokenVault });
    const platforms = createPlatformServices({ db });
    const allow = createRequestLimiter({ db });

    async function seedAccount(username, displayName) {
      const password = randomBytes(32).toString('base64url');
      await accounts.register({ username, displayName, password });
      const { rows } = await db.query(
        "update linebot_private.accounts set status='active' where username=$1 returning id", [username]
      );
      return { id: rows[0].id, username, password };
    }

    async function seedPlatform(account, name, botName, letter, recipients) {
      const botId = randomUUID();
      await db.query(`insert into linebot_private.bot_credentials
        (id,account_id,bot_user_id,bot_name,encrypted_secret,encrypted_access_token,enabled)
        values($1,$2,$3,$4,'{}',$5,true)`,
      [botId, account.id, 'U' + letter.repeat(32), botName, JSON.stringify(tokenVault.seal(account.id, 'simulated-token'))]);
      const platformId = (await platforms.create(account.id, name)).id;
      await platforms.attach(account.id, platformId, botId);
      const targets = [];
      for (const [label, targetLetter] of recipients) {
        const id = randomUUID();
        const lineId = 'U' + targetLetter.repeat(32);
        await db.query(`insert into linebot_private.recipients
          (id,account_id,bot_id,line_hash,encrypted_line_id,label) values($1,$2,$3,$4,$5,$6)`,
        [id, account.id, botId, targetLetter, JSON.stringify(recipientVault.seal(account.id, lineId)), label]);
        targets.push({ id, label, lineId });
      }
      return { id: platformId, targets };
    }

    const owner = await seedAccount('pilot_owner', '試辦開發者');
    const supported = await seedPlatform(owner, '教具借用平台', '教具通知 Bot', 'a', [['教具管理員', 'b'], ['教學備援窗口', 'c']]);
    const other = await seedPlatform(owner, '課程報名平台', '課程通知 Bot', 'd', [['課程承辦人', 'e']]);
    const observer = await seedAccount('pilot_observer', '另一位試辦開發者');
    const observerPlatform = await seedPlatform(observer, '教學成果平台', '成果通知 Bot', 'f', [['成果承辦人', '9']]);
    await db.exec('set role linebot_runtime');

    const inbox = new Map();
    const simulatedLine = async (url, options) => {
      if (url !== 'https://api.line.me/v2/bot/message/push') throw new Error('Unexpected demo destination');
      const payload = JSON.parse(options.body);
      inbox.set(options.headers['X-Line-Retry-Key'], { text: payload.messages[0].text, to: payload.to });
      return new Response(JSON.stringify({ sentMessages: [{ id: String(inbox.size) }] }), { status: 200 });
    };
    const integrations = createExternalIntegrations({
      db, key, recipientVault, tokenVault, allow, fetchImpl: simulatedLine,
      messageVault: createCredentialVault(key, { context: 'integration-message', maxBytes: 8000 })
    });
    const notifications = createNotifications({
      db, key, recipientVault, tokenVault, fetchImpl: simulatedLine, includeIntegrations: true
    });
    const source = {
      name: '教具借用平台', event: '借用核准', platformId: supported.id, origin: sourceOrigin,
      secret: randomBytes(32).toString('base64url')
    };
    const demoSession = async selection => {
      const account = selection === 'observer' ? observer : owner;
      const { token } = await accounts.login(account);
      if (!token) throw new Error('Demo login failed');
      return { token, platformId: account === observer ? observerPlatform.id : supported.id };
    };
    const sourceSetup = createSourceSetup({
      accounts, platforms, notifications, integrations, db, allow, origin, source, demoSession
    });
    loanSource = createLoanSource({
      origin: sourceOrigin, hubOrigin: origin, hubHref: origin + '/#connect?platform=' + supported.id,
      serviceSecret: source.secret, inbox
    });
    hub = createLinebotServer({
      accounts, bots, vault, allow, publicOrigin: origin, notifications, integrations, platforms,
      sourceSetup, lookupBot: async () => null, eventStore: async () => {}
    });
    await listen(loanSource, sourcePort);
    await listen(hub, port);
    worker = setInterval(() => {
      if (dispatch) return;
      dispatch = integrations.runNext()
        .catch(() => console.error('Demo dispatch failed'))
        .finally(() => { dispatch = undefined; });
    }, 200);

    return { origin, sourceOrigin, close, supported, other, observerPlatform, inbox };
  } catch (error) {
    await close();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pilot = await startPilot();
  console.log('試辦入口 ' + pilot.origin + '/independent-api/source-setup/preview');
  console.log('示範來源 ' + pilot.sourceOrigin);
  process.once('SIGINT', pilot.close);
  process.once('SIGTERM', pilot.close);
}
