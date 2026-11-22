import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createEnrollmentDb } from './admin-enrollment-db.mjs';

test('enrollment opens its database only for the final write and closes it',async()=>{
 let created=0,closed=0,writes=0;
 const db=createEnrollmentDb(()=>{created++;return {on(){},async connect(){},async query(sql){if(sql.startsWith('select current_user'))return {rows:[{name:'linebot_enroller'}]};writes++;return {rows:[]};},async end(){closed++;}};});
 assert.equal(created,0);
 await db.query('select linebot_private.enroll_initial_admin($1)', ['example']);
 assert.equal(created,1);assert.equal(writes,1);assert.equal(closed,1);
});

test('enrollment refuses an elevated or unexpected database role',async()=>{
 let closed=0,writes=0;
 const db=createEnrollmentDb(()=>({on(){},async connect(){},async query(sql){if(sql.startsWith('select current_user'))return {rows:[{name:'linebot_enroller',rolsuper:true}]};writes++;},async end(){closed++;}}));
 await assert.rejects(db.query('select anything'),/Unsafe enrollment database role/);
 assert.equal(writes,0);assert.equal(closed,1);
});
