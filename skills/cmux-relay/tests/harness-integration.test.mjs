import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runRelay, fakeUserHome, fakeCmux, tmp } from './helpers.mjs';
import { readHeadless } from '../scripts/lib/headless.mjs';

const fake = `
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),prompt=args.find(a=>a.includes('dispatchId:'));
if(!prompt)process.exit(20);
const dispatchId=prompt.match(/dispatchId: ([a-z0-9-]+)/)[1];
const brief=prompt.match(/(\\/[^\\s]+\\/brief\\.md)/)?.[1];
const dir=brief?path.dirname(brief):prompt.match(/(\\/[^\\s]+)\\/report-[a-z0-9-]+\\.json/)[1];
const taskId=path.basename(dir),agent=path.basename(process.argv[1]);
fs.appendFileSync(process.env.FAKE_CALLS,JSON.stringify({args,taskId,dispatchId,agent})+'\\n');
const mode=process.env.FAKE_MODE;
if(mode==='hang')setInterval(()=>{},1000);
else if(mode==='no-report' || (mode==='stale-quota' && agent==='codex'))process.exit(0);
else if(mode==='process-fail')process.exit(7);
else if(mode==='stale-quota' && agent==='claude'){fs.writeFileSync(path.join(dir,'report-'+dispatchId+'.json'),JSON.stringify({taskId,dispatchId,status:'done',summary:'stale success'}));console.error('usage_limit_reached');process.exit(1);}
else if(mode==='quota' && agent==='claude'){console.error('usage_limit_reached');process.exit(1);}
else {
const briefText=fs.readFileSync(path.join(dir,'brief.md'),'utf8');
const stage=prompt.match(/stage는 (plan|work|review|verify)/)?.[1]||briefText.match(/Workflow stage: (plan|work|review|verify)/)?.[1]||'work';
const report={taskId:mode==='wrong-task'?'different-task':taskId,dispatchId,status:mode==='report-fail'?'failed':'done',summary:mode==='quota-in-summary'?'usage_limit_reached is a literal fixture string':'fake result',stage,confidence:'reported_done'};
if(mode==='wrong-task')fs.writeFileSync(path.join(dir,'report-'+dispatchId+'.json'),JSON.stringify(report));
const result=JSON.stringify(report);
if(agent==='claude')console.log(JSON.stringify({type:'result',session_id:'fake-session',result}));
else {console.log(JSON.stringify({type:'thread.started',thread_id:'fake-thread'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:result}}));}
if(mode==='failed-after-report')process.exit(7);
}
`;
function harness(t, mode='done', unicodeHome=false) {
  const base=tmp(),bin=path.join(base,'bin');fs.mkdirSync(bin);
  const home=path.join(base,unicodeHome?'릴레이-작업':'relay'),calls=path.join(base,'calls.jsonl'),brief=path.join(base,'brief.md');fs.writeFileSync(brief,'# fake task\n');
  for(const agent of ['claude','codex'])fs.writeFileSync(path.join(bin,agent),`#!${process.execPath}\n${fake}`,{mode:0o700});
  const ctx={home,userHome:fakeUserHome(),cmux:fakeCmux(),headlessEnv:{PATH:`${bin}:${process.env.PATH}`,FAKE_MODE:mode,FAKE_CALLS:calls},sleep:ms=>new Promise(r=>setTimeout(r,Math.min(ms,20)))};
  const run=(args)=>runRelay(args,ctx);
  const spawn=(task='probe',extra=[])=>run(['spawn','--task',task,'--backend','headless','--brief',brief,'--tier','E1','--tier-reason','integration task','--cwd',base,...extra]);
  const meta=(task='probe')=>JSON.parse(fs.readFileSync(path.join(home,'tasks',task,'meta.json'),'utf8'));
  const wait=(task='probe',extra=[])=>run(['wait',task,'--dispatch',meta(task).dispatches.at(-1).dispatchId,'--timeout','8',...extra]);
  t.after(async()=>{for(const task of fs.existsSync(path.join(home,'tasks'))?fs.readdirSync(path.join(home,'tasks')):[]){try{await run(['close',task]);}catch{}} await new Promise(r=>setTimeout(r,100));fs.rmSync(base,{recursive:true,force:true});fs.rmSync(ctx.userHome,{recursive:true,force:true});});
  return {base,home,ctx,run,spawn,wait,meta,calls:()=>fs.existsSync(calls)?fs.readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse):[]};
}
test('main headless auto route completes and send resumes the captured session',async t=>{
  const h=harness(t);const spawned=await h.spawn();assert.equal(spawned.code,0,JSON.stringify(spawned.last));assert.equal(spawned.last.pinned,false);
  const done=await h.wait('probe',['--keep-open']);assert.equal(done.code,0,JSON.stringify(done.last));
  const send=await h.run(['send','probe','--message','follow up']);assert.equal(send.code,0,JSON.stringify(send.last));
  assert.equal((await h.wait()).code,0);
  const second=h.calls()[1];assert.ok(second.args.includes('--resume')||second.args.includes('resume'));assert.ok(second.args.includes('fake-session')||second.args.includes('fake-thread'));
});
test('headless wait cannot convert missing report or nonzero process into success',async t=>{
  for(const [mode,expected] of [['no-report',5],['process-fail',4],['failed-after-report',4]]){const h=harness(t,mode);assert.equal((await h.spawn()).code,0);const result=await h.wait();assert.equal(result.code,expected,JSON.stringify(result.last));}
});
test('quota fallback records attempts and the succeeding official provider',async t=>{
  const h=harness(t,'quota');assert.equal((await h.spawn()).code,0);const result=await h.wait('probe',['--keep-open']);assert.equal(result.code,0,JSON.stringify(result.last));
  const state=readHeadless(path.join(h.home,'tasks/probe'),h.meta().dispatches[0].dispatchId);assert.ok(state.attempts.length>=2);assert.equal(state.attempts[0].agent,'claude');assert.equal(state.attempts.at(-1).agent,'codex');assert.ok(fs.existsSync(path.join(h.home,'quota-events.jsonl')));
});
test('headless failed report escalates once and close terminates a live worker',async t=>{
  const h=harness(t,'report-fail');assert.equal((await h.spawn()).code,0);assert.equal((await h.wait('probe',['--keep-open'])).code,4);
  h.ctx.headlessEnv.FAKE_MODE='done';const from=h.meta().dispatches[0].dispatchId;const escalated=await h.run(['escalate','probe','--from',from]);assert.equal(escalated.code,0,JSON.stringify(escalated.last));assert.equal((await h.wait()).code,0);
  assert.equal((await h.run(['escalate','probe','--from',from])).code,2);
  h.ctx.headlessEnv.FAKE_MODE='hang';assert.equal((await h.spawn('live')).code,0);assert.equal((await h.run(['close','live'])).code,0);
  for(let i=0;i<100 && readHeadless(path.join(h.home,'tasks/live'),h.meta('live').dispatches[0].dispatchId)?.status!=='exited';i++)await new Promise(r=>setTimeout(r,20));
  assert.equal(readHeadless(path.join(h.home,'tasks/live'),h.meta('live').dispatches[0].dispatchId).status,'exited');
});
test('ownership conflict is enforced until explicit close releases scope',async t=>{
  const h=harness(t);assert.equal((await h.spawn('owner',['--owns','src'])).code,0);
  const conflict=await h.spawn('blocked',['--owns','src/file.mjs']);assert.equal(conflict.last.error,'OWNERSHIP_CONFLICT');
  assert.equal((await h.run(['close','owner'])).code,0);assert.equal((await h.spawn('replacement',['--owns','src/file.mjs'])).code,0);assert.equal((await h.wait('replacement')).code,0);
});
test('workflow runs plan work review then requires approval before executing verification',async t=>{
  const h=harness(t);const start=await h.run(['workflow','start','--task','flow','--brief',path.join(h.base,'brief.md'),'--tier','E1','--tier-reason','integration workflow','--cwd',h.base,'--owns','src']);assert.equal(start.code,0,JSON.stringify(start.last));
  for(const expected of ['work','review','verify']){const r=await h.run(['workflow','advance','flow','--timeout','8']);assert.equal(r.last.stage,expected,JSON.stringify(r.last));}
  const marker=path.join(h.base,'verified');const command=`printf passed > '${marker}'`;
  const pending=await h.run(['workflow','advance','flow']);assert.equal(pending.code,3);assert.equal(fs.existsSync(marker),false);
  const denied=await h.run(['workflow','approve','flow','--command',command]);assert.equal(denied.last.error,'VERIFICATION_NOT_APPROVED');assert.equal(fs.existsSync(marker),false);
  const approved=await h.run(['workflow','approve','flow','--command',command,'--approval','User explicitly approves the fixture command']);assert.equal(approved.code,3);assert.equal(fs.existsSync(marker),false);
  const complete=await h.run(['workflow','advance','flow']);assert.equal(complete.code,0,JSON.stringify(complete.last));assert.equal(complete.last.status,'done');assert.equal(fs.readFileSync(marker,'utf8'),'passed');
  const receipts=JSON.parse(fs.readFileSync(path.join(h.home,'tasks/flow-verify/verification/receipts.json')));assert.equal(receipts[0].executed,true);assert.equal(receipts[0].approved,true);
});

test('quota retry cannot consume the previous attempt report',async t=>{
  const h=harness(t,'stale-quota');assert.equal((await h.spawn()).code,0);const result=await h.wait('probe',['--keep-open']);assert.equal(result.code,5,JSON.stringify(result.last));
});
test('literal quota text in a successful final report does not replay work',async t=>{
  const h=harness(t,'quota-in-summary');assert.equal((await h.spawn()).code,0);assert.equal((await h.wait('probe',['--keep-open'])).code,0);assert.equal(h.calls().length,1);
  const state=readHeadless(path.join(h.home,'tasks/probe'),h.meta().dispatches[0].dispatchId);assert.equal(state.attempts[0].quotaExceeded,false);
});
test('followup after Codex fallback resumes Codex without replaying Claude',async t=>{
  const h=harness(t,'quota');assert.equal((await h.spawn()).code,0);assert.equal((await h.wait('probe',['--keep-open'])).code,0);
  const before=h.calls().length;h.ctx.headlessEnv.FAKE_MODE='done';assert.equal((await h.run(['send','probe','--message','follow up after fallback'])).code,0);assert.equal((await h.wait()).code,0);
  const followups=h.calls().slice(before);assert.equal(followups.length,1);assert.equal(followups[0].agent,'codex');assert.ok(followups[0].args.includes('resume'));assert.ok(followups[0].args.includes('fake-thread'));
});
test('matching dispatch with wrong task identity cannot pass wait',async t=>{
  const h=harness(t,'wrong-task');assert.equal((await h.spawn()).code,0);const result=await h.wait('probe',['--keep-open']);assert.notEqual(result.code,0,JSON.stringify(result.last));assert.equal(result.code,5);
});

test('headless launch supports a Unicode relay home without shell source encoding',async t=>{
  const h=harness(t,'done',true);const spawned=await h.spawn();assert.equal(spawned.code,0,JSON.stringify(spawned.last));const result=await h.wait();assert.equal(result.code,0,JSON.stringify(result.last));assert.equal(h.calls().length,1);
});
test('historical remind and escalation cannot overlap a newer running dispatch',async t=>{
  const h=harness(t,'hang');assert.equal((await h.spawn()).code,0);
  const meta=h.meta(),active=meta.dispatches[0];
  const old={...active,dispatchId:'d0-old',tab:'historical',exitCode:5,source:'auto',tier:'E1'};
  meta.dispatches.unshift(old);meta.tabs.push({name:'historical',observe:'headless',ref:'headless:d0-old',dispatchId:'d0-old'});
  const dir=path.join(h.home,'tasks/probe');fs.writeFileSync(path.join(dir,'runner-d0-old.json'),JSON.stringify({status:'exited',exitCode:0,attempts:[]}));
  fs.writeFileSync(path.join(dir,'meta.json'),JSON.stringify(meta));
  const callsBefore=h.calls().length;
  const remind=await h.run(['send','probe','--remind','d0-old']);assert.equal(remind.last.error,'TASK_RUNNING',JSON.stringify(remind.last));
  old.exitCode=4;fs.writeFileSync(path.join(dir,'meta.json'),JSON.stringify(meta));
  const escalate=await h.run(['escalate','probe','--from','d0-old']);assert.equal(escalate.last.error,'TASK_RUNNING',JSON.stringify(escalate.last));
  assert.equal(h.meta().dispatches.length,2,'rejected retries must not append dispatches');
  // The one existing worker may start between reads; rejected operations must never launch another.
  assert.ok(h.calls().length<=Math.max(1,callsBefore));
});
