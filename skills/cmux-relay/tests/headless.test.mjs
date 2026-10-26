import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHeadless, readHeadless, stopHeadless } from '../scripts/lib/headless.mjs';
async function setup(t, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-headless-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const agent of ['claude', 'codex']) fs.writeFileSync(path.join(dir, agent), `#!${process.execPath}\n${source}`, { mode: 0o700 });
  const request = { taskId: 'test', dispatchId: 'd1-test', dir, cwd: dir, preset: 'safe', prompt: 'do work', candidates: [{ agent: 'claude', model: 'sonnet', effort: 'high' }, { agent: 'codex', model: 'gpt', effort: 'high' }] };
  startHeadless({ headlessEnv: { PATH: `${dir}:${process.env.PATH}` } }, request);
  return { dir, request };
}
async function finished(dir) {
  for (let i = 0; i < 200; i++) { const state = readHeadless(dir, 'd1-test'); if (state?.status === 'exited') return state; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('runner timed out');
}
test('detached launch captures official final result and session', async t => {
  const { dir } = await setup(t, `console.log(JSON.stringify({type:'result',session_id:'session-1',result:JSON.stringify({taskId:'test',dispatchId:'d1-test',status:'done',summary:'ok'})}));`);
  const state = await finished(dir);
  assert.equal(state.exitCode, 0); assert.equal(state.sessionId, 'session-1'); assert.equal(state.attempts.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'report-d1-test.json'))).status, 'done');
  assert.equal(fs.statSync(state.attempts[0].stdoutFile).mode & 0o777, 0o600);
});
test('only quota failures retry next candidate', async t => {
  const { dir } = await setup(t, `if(process.argv[1].endsWith('/claude')) {console.error('usage_limit_reached');process.exit(1);} console.log('done');`);
  const state = await finished(dir); assert.equal(state.attempts.length, 2); assert.equal(state.attempts[0].quotaExceeded, true); assert.equal(state.exitCode, 0);
});
test('ordinary failure never retries or creates report', async t => {
  const { dir } = await setup(t, `console.error('permission denied');process.exit(2);`);
  const state = await finished(dir); assert.equal(state.attempts.length, 1); assert.equal(state.exitCode, 2); assert.equal(fs.existsSync(path.join(dir, 'report-d1-test.json')), false);
});
test('stop validates identity and forwards termination', async t => {
  const { dir } = await setup(t, `setInterval(()=>{},1000);`);
  for(let i=0;i<100 && !readHeadless(dir,'d1-test').attempts.length;i++) await new Promise(r=>setTimeout(r,20));
  assert.equal(stopHeadless(dir,'d1-test').stopped, true);
  const state = await finished(dir); assert.equal(state.stopped,true); assert.equal(state.exitCode,143);
});
test('stale identity cannot signal a live arbitrary process', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'relay-stale-'));
  try {fs.writeFileSync(path.join(dir,'runner-d1-test.json'),JSON.stringify({status:'running',pid:process.pid,token:'wrong',requestFile:'wrong'})); assert.equal(stopHeadless(dir,'d1-test').reason,'identity-mismatch');} finally {fs.rmSync(dir,{recursive:true});}
});
test('pinned requests do not fall back after quota exhaustion', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pinned-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'claude'), `#!${process.execPath}\nconsole.error('usage_limit_reached');process.exit(1);`, { mode: 0o700 });
  startHeadless({headlessEnv:{PATH:`${dir}:${process.env.PATH}`}}, {taskId:'test',dispatchId:'d1-test',dir,cwd:dir,preset:'safe',prompt:'work',pinned:true,candidates:[{agent:'claude',model:'sonnet',effort:'high'},{agent:'codex',model:'gpt',effort:'high'}]});
  const state = await finished(dir);
  assert.equal(state.attempts.length,1); assert.equal(state.attempts[0].quotaExceeded,true);
});
test('stop drains same-group descendants before publishing exited', async t => {
  const descendant = `const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync('descendant-marker','x'),20);`;
  const { dir } = await setup(t, `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});fs.writeFileSync('descendant-pid',String(child.pid));setInterval(()=>{},1000);`);
  const marker = path.join(dir, 'descendant-marker');
  let descendantPid;
  t.after(() => { if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL'); } catch {} } });
  for (let i=0; i<150 && !fs.existsSync(marker); i++) await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(fs.existsSync(marker), 'descendant must run and install its TERM handler before stop');
  descendantPid = Number(fs.readFileSync(path.join(dir,'descendant-pid'),'utf8'));
  const before = fs.statSync(marker).size;
  assert.equal(stopHeadless(dir,'d1-test').stopped,true);
  const state=await finished(dir);
  assert.equal(state.stopped,true);assert.equal(state.status,'exited');
  const atExit=fs.statSync(marker).size;
  assert.ok(atExit>before,'TERM-resistant descendant must remain active until forced group shutdown');
  await new Promise(resolve=>setTimeout(resolve,200));
  assert.equal(fs.statSync(marker).size,atExit,'exited state must guarantee descendants cannot keep writing');
});

test('quota text in an agent message does not replay an unrelated process failure', async t => {
 const {dir}=await setup(t, `console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'usage_limit_reached is a fixture'}}));console.error('permission denied');process.exit(2);`);
 const state=await finished(dir);assert.equal(state.attempts.length,1);assert.equal(state.attempts[0].quotaExceeded,false);assert.equal(state.exitCode,2);
});
test('structured official quota errors retry even when CLI process returns zero', async t => {
 const {dir}=await setup(t, `if(process.argv[1].endsWith('/claude')){console.log(JSON.stringify({type:'result',is_error:true,subtype:'error_during_execution',errors:['usage_limit_reached']}));}else console.log('done');`);
 const state=await finished(dir);assert.equal(state.attempts.length,2);assert.equal(state.attempts[0].quotaExceeded,true);assert.equal(state.attempts[0].exitCode,1);assert.equal(state.exitCode,0);
});
test('normal successful exit drains descendants before publishing exited', async t => {
  const descendant = `const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync('normal-descendant-marker','x'),20);`;
  const report = JSON.stringify({ taskId:'test',dispatchId:'d1-test',status:'done',summary:'leader complete' });
  const { dir } = await setup(t, `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});fs.writeFileSync('normal-descendant-pid',String(child.pid));const timer=setInterval(()=>{if(fs.existsSync('normal-descendant-marker')){clearInterval(timer);console.log(JSON.stringify({type:'result',result:${JSON.stringify(report)}}));process.exit(0);}},20);`);
  const marker=path.join(dir,'normal-descendant-marker');
  let descendantPid;
  t.after(()=>{if(descendantPid){try{process.kill(descendantPid,'SIGKILL');}catch{}}});
  for(let i=0;i<150 && !fs.existsSync(marker);i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(fs.existsSync(marker),'descendant must write before leader exits');
  descendantPid=Number(fs.readFileSync(path.join(dir,'normal-descendant-pid'),'utf8'));
  const state=await finished(dir);assert.equal(state.exitCode,0);assert.equal(state.status,'exited');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'report-d1-test.json'))).status,'done');
  const atExit=fs.statSync(marker).size;await new Promise(resolve=>setTimeout(resolve,200));
  assert.equal(fs.statSync(marker).size,atExit,'successful exit must leave no descendants writing');
});
