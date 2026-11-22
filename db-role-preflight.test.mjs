import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { PGlite } from '@electric-sql/pglite';
import { checkDatabaseRole } from './db-role-preflight.mjs';
test('preflight catches unrelated schema privileges and elevated roles',async()=>{
 const db=new PGlite();
 try{
  await db.exec('create role linebot_runtime;create role extra_role;create schema other_platform;create table other_platform.records(v text);revoke all on schema other_platform from public;set role linebot_runtime;');
  assert.deepEqual(await checkDatabaseRole(db,'linebot_runtime'),{safe:true,otherObjects:0,otherSecurityDefinerFunctions:0});
  assert.deepEqual(await checkDatabaseRole(db,'linebot_reviewer'),{safe:false,reason:'unsafe_role'});
  await db.exec('reset role;grant usage on schema other_platform to linebot_runtime;grant select on other_platform.records to linebot_runtime;set role linebot_runtime;');
  assert.equal((await checkDatabaseRole(db,'linebot_runtime')).safe,false);
  await db.exec('reset role;grant extra_role to linebot_runtime;set role linebot_runtime;');
  assert.deepEqual(await checkDatabaseRole(db,'linebot_runtime'),{safe:false,reason:'unsafe_role'});
 }finally{await db.close();}
});
