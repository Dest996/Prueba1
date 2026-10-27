import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {resetAdminPassword} from '../scripts/configure-admin.js';
import {verifyPassword} from '../auth.js';
test('local admin recovery changes only the admin password and revokes its sessions',async()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec("CREATE TABLE users(id TEXT,role TEXT,password_hash TEXT,active INTEGER);CREATE TABLE sessions(user_id TEXT);CREATE TABLE notes(transcript TEXT);INSERT INTO users VALUES ('owner','admin','old-admin-hash',1),('member','user','member-hash',1);INSERT INTO sessions VALUES ('owner'),('member');INSERT INTO notes VALUES ('Original preserved');");
    await assert.rejects(()=>resetAdminPassword(db,'short'));
    assert.equal(db.prepare("SELECT password_hash FROM users WHERE id='owner'").get().password_hash,'old-admin-hash');
    await resetAdminPassword(db,'new-owner-password');
    assert.ok(await verifyPassword('new-owner-password',db.prepare("SELECT password_hash FROM users WHERE id='owner'").get().password_hash));
    assert.equal(db.prepare("SELECT password_hash FROM users WHERE id='member'").get().password_hash,'member-hash');
    assert.deepEqual(db.prepare('SELECT user_id FROM sessions').all().map(s=>s.user_id),['member']);
    assert.equal(db.prepare('SELECT transcript FROM notes').get().transcript,'Original preserved');
  }finally{db.close();}
});
