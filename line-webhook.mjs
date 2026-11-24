import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// These primitives are deliberately separate from the live server until the
// account and credential repositories are deployed and reviewed together.
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertIdentity(userId) {
  if (typeof userId !== 'string' || !idPattern.test(userId)) throw new Error('Invalid owner');
}
export function createCredentialVault(key, { context = 'channel-secret', maxBytes = 4096 } = {}) {
  if (!['channel-secret', 'line-event', 'line-recipient', 'channel-access-token', 'admin-totp', 'integration-message'].includes(context) || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576) throw new Error('Invalid vault configuration');
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('A 32-byte key is required');
  const vaultKey = Buffer.from(key);
  return {
    seal(userId, secret) {
      assertIdentity(userId);
      if (typeof secret !== 'string' || secret.length < 1 || Buffer.byteLength(secret) > maxBytes) throw new Error('Invalid secret');
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', vaultKey, iv);
      cipher.setAAD(Buffer.from(`linebot-${context}:v1:${userId.toLowerCase()}`));
      const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      return { version: 1, iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
    },
    open(userId, value) {
      assertIdentity(userId);
      if (!value || value.version !== 1 || typeof value.iv !== 'string' || typeof value.ciphertext !== 'string' || typeof value.tag !== 'string') throw new Error('Invalid encrypted secret');
      const iv = Buffer.from(value.iv, 'base64'), tag = Buffer.from(value.tag, 'base64'), ciphertext = Buffer.from(value.ciphertext, 'base64');
      if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 1 || ciphertext.length > maxBytes) throw new Error('Invalid encrypted secret');
      const decipher = createDecipheriv('aes-256-gcm', vaultKey, iv);
      decipher.setAAD(Buffer.from(`linebot-${context}:v1:${userId.toLowerCase()}`));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    }
  };
}
export function verifyLineSignature(rawBody, signature, channelSecret) {
  if (!Buffer.isBuffer(rawBody) || typeof signature !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(signature) || typeof channelSecret !== 'string' || !channelSecret) return false;
  const given = Buffer.from(signature, 'base64');
  const expected = createHmac('sha256', channelSecret).update(rawBody).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}
export function createWebhookHandler({ findBot, vault, handleEvents }) {
  if (typeof findBot !== 'function' || !vault?.open) throw new Error('Missing webhook dependencies');
  return async function handleWebhook({ webhookKey, rawBody, signature }) {
    if (!idPattern.test(webhookKey || '') || !Buffer.isBuffer(rawBody)) return { status: 400 };
    if (rawBody.length > 1024 * 1024) return { status: 413 };
    let bot;
    try { bot = await findBot(webhookKey); } catch { return { status: 503 }; }
    if (!bot || bot.enabled !== true) return { status: 404 };
    let secret;
    try { secret = vault.open(bot.userId, bot.encryptedSecret); } catch { return { status: 503 }; }
    if (!verifyLineSignature(rawBody, signature, secret)) return { status: 401 };
    let payload;
    try { payload = JSON.parse(rawBody.toString('utf8')); } catch { return { status: 400 }; }
    if (!payload || !Array.isArray(payload.events)) return { status: 400 };
    // Prevent a secret from a different channel being paired with the token.
    if (bot.botUserId && payload.destination !== bot.botUserId) return { status: 403 };
    if (payload.events.length) {
      // Do not acknowledge events that have not been durably handled.
      if (typeof handleEvents !== 'function') return { status: 503 };
      try { await handleEvents(bot.userId, payload.events, bot.id); } catch { return { status: 503 }; }
    }
    return { status: 200 };
  };
}
