import { X509Certificate } from 'node:crypto';

// Connect through the private TCP relay while validating the PostgreSQL server.
// Do not allow a connection-string option to replace the verified TLS object.
export function createVerifiedDatabaseConfig(connectionString, encodedCa, options = {}) {
 let url;
 try { url = new URL(connectionString); } catch { throw Error('Invalid database URL'); }
 if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== 'linebot-pg-relay-private' || url.port !== '5432' || url.search || url.hash) throw Error('Unsafe database URL');
 if (typeof encodedCa !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encodedCa) || encodedCa.length > 16384) throw Error('Missing database CA certificate');
 const bytes = Buffer.from(encodedCa, 'base64');
 if (bytes.toString('base64') !== encodedCa) throw Error('Invalid database CA encoding');
 const ca = bytes.toString('utf8');
 try { new X509Certificate(ca); } catch { throw Error('Invalid database CA certificate'); }
 return { ...options, connectionString, ssl: { ca, rejectUnauthorized: true }, sslnegotiation: 'postgres' };
}

export async function requireEncryptedDatabaseConnection(db) {
 const row=(await db.query('select ssl from pg_catalog.pg_stat_ssl where pid=pg_catalog.pg_backend_pid()')).rows[0];
 if (row?.ssl !== true) throw Error('Database connection is not encrypted');
}
