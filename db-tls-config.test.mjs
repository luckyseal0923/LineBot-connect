import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { createVerifiedDatabaseConfig,requireEncryptedDatabaseConnection } from './db-tls-config.mjs';

test('database client requires a pinned CA and cannot silently disable TLS',async()=>{
 const pem=await readFile(new URL('./test-fixtures/db-test-ca.pem',import.meta.url));
 const ca=pem.toString('base64');
 const url='postgresql://test:fake@linebot-pg-relay-private:5432/postgres';
 const cfg=createVerifiedDatabaseConfig(url,ca,{max:2});
 const pool=new pg.Pool(cfg);
 assert.equal(pool.options.ssl.rejectUnauthorized,true);
 assert.equal(pool.options.ssl.ca,pem.toString());
 assert.equal(pool.options.sslnegotiation,'postgres');
 assert.throws(()=>createVerifiedDatabaseConfig(url,''));
 assert.throws(()=>createVerifiedDatabaseConfig(url,Buffer.from('not a certificate').toString('base64')));
 for(const option of ['sslmode=disable','sslmode=no-verify','sslrootcert=bad','host=other'])
  assert.throws(()=>createVerifiedDatabaseConfig(url+'?'+option,ca));
 assert.throws(()=>createVerifiedDatabaseConfig('postgresql://test:fake@other:5432/postgres',ca));
 await pool.end();
});

test('startup refuses a database session that is not encrypted',async()=>{
 await requireEncryptedDatabaseConnection({query:async()=>({rows:[{ssl:true}]})});
 await assert.rejects(requireEncryptedDatabaseConnection({query:async()=>({rows:[{ssl:false}]})}));
 await assert.rejects(requireEncryptedDatabaseConnection({query:async()=>({rows:[]})}));
});
