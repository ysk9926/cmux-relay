import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runRelay, fakeCmux, fakeUserHome, tmp, SKILL_DIR, CMUX_ENV } from './helpers.mjs';
import { readMeta, writeMeta } from '../scripts/lib/store.mjs';
import { cmuxQuotaFallback } from '../scripts/lib/fallback.mjs';

function fixture(t) {
  const base=tmp(),cwd=path.join(base,'repo');fs.mkdirSync(cwd);
  const brief=path.join(base,'brief.md');fs.writeFileSync(brief,'# Recovery regression\n');
  const ctx={home:path.join(base,'relay'),userHome:fakeUserHome(),cmux:fakeCmux(),skillDir:SKILL_DIR,env:CMUX_ENV,runGit:()=>'',now:()=>new Date(),sleep:async()=>{}};
  t.after(()=>{fs.rmSync(base,{recursive:true,force:true});fs.rmSync(ctx.userHome,{recursive:true,force:true});});
  const spawn=(extra=[])=>runRelay(['spawn','--task','recovery','--brief',brief,'--tier','E1','--tier-reason','bounded regression','--cwd',cwd,'--placement','workspace','--owns','src',...extra],ctx);
  const meta=()=>readMeta(ctx.home,'recovery');
  const claim=()=>path.join(ctx.home,'ownership/recovery.json');
  return {base,cwd,ctx,spawn,meta,claim};
}

test('subdirectory worktree preserves execution cwd and Git-relative ownership scope',async t=>{
 const h=fixture(t);const git=args=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
 git(['init',h.cwd]);git(['-C',h.cwd,'config','user.name','Relay Fixture']);git(['-C',h.cwd,'config','user.email','fixture@example.invalid']);
 const sub=path.join(h.cwd,'packages/a');fs.mkdirSync(sub,{recursive:true});fs.writeFileSync(path.join(sub,'tracked.txt'),'fixture');
 git(['-C',h.cwd,'add','.']);git(['-C',h.cwd,'commit','-m','fixture']);h.ctx.runGit=git;
 const result=await h.spawn(['--cwd',sub,'--worktree']);assert.equal(result.code,0,JSON.stringify(result.last));
 const expected=path.join(h.ctx.home,'worktrees/recovery/packages/a');assert.equal(h.meta().cwd,expected);assert.equal(fs.existsSync(path.join(expected,'tracked.txt')),true);
 const claim=JSON.parse(fs.readFileSync(h.claim(),'utf8'));assert.deepEqual(claim.paths,['packages/a/src']);
 assert.equal(h.ctx.cmux.calls.find(c=>c[0]==='createWorkspace')[1].cwd,expected);
});

test('spawn discovery failure retains ownership and a tab that explicit close can recover',async t=>{
 const h=fixture(t);h.ctx.cmux.listWorkspaces=()=>[];
 const result=await h.spawn();assert.equal(result.last.error,'WORKSPACE_NOT_FOUND');assert.equal(fs.existsSync(h.claim()),true);
 assert.equal(h.meta().tabs.length,1);assert.match(h.meta().tabs[0].ref,/^workspace:/);assert.equal(h.meta().dispatches.length,1);
 const close=await runRelay(['close','recovery'],h.ctx);assert.equal(close.code,0,JSON.stringify(close.last));assert.equal(close.last.closed.length,1);assert.equal(fs.existsSync(h.claim()),false);
});

test('quota fallback discovery failure persists provisional child for close and retains claim',async t=>{
 const h=fixture(t);assert.equal((await h.spawn()).code,0);
 h.ctx.cmux.listWorkspaces=()=>[];h.ctx.cmux.readScreen=()=>"You've hit your usage limit";
 const meta=h.meta(),dispatch=meta.dispatches[0];assert.equal(dispatch.pinned,false);assert.ok(dispatch.candidates.length>1);
 await assert.rejects(cmuxQuotaFallback(h.ctx,'recovery',meta,meta.tabs[0],dispatch,{exitCode:5,reason:'no-report'}),{code:'WORKSPACE_NOT_FOUND'});
 const recovered=h.meta();assert.equal(recovered.tabs.length,2);assert.equal(recovered.dispatches[0].tab,recovered.tabs[1].name);assert.equal(recovered.dispatches[0].agent,'codex');assert.equal(fs.existsSync(h.claim()),true);
 const close=await runRelay(['close','recovery'],h.ctx);assert.equal(close.code,0,JSON.stringify(close.last));assert.equal(close.last.closed.length,2);assert.equal(fs.existsSync(h.claim()),false);
});

test('escalation discovery failure persists provisional child for close and retains claim',async t=>{
 const h=fixture(t);assert.equal((await h.spawn()).code,0);
 const meta=h.meta(),from=meta.dispatches[0].dispatchId;meta.dispatches[0].exitCode=4;writeMeta(h.ctx.home,'recovery',meta);h.ctx.cmux.listWorkspaces=()=>[];
 const result=await runRelay(['escalate','recovery','--from',from],h.ctx);assert.equal(result.last.error,'WORKSPACE_NOT_FOUND');
 const recovered=h.meta();assert.equal(recovered.tabs.length,2);assert.equal(recovered.dispatches.length,2);assert.equal(recovered.dispatches[0].escalatedTo,recovered.dispatches[1].dispatchId);assert.equal(recovered.dispatches[1].tab,recovered.tabs[1].name);assert.equal(fs.existsSync(h.claim()),true);
 const close=await runRelay(['close','recovery'],h.ctx);assert.equal(close.code,0,JSON.stringify(close.last));assert.equal(close.last.closed.length,2);assert.equal(fs.existsSync(h.claim()),false);
});

test('closed failed tasks refuse escalation before any new child is launched',async t=>{
 const h=fixture(t);assert.equal((await h.spawn()).code,0);
 const meta=h.meta(),from=meta.dispatches[0].dispatchId;meta.dispatches[0].exitCode=4;writeMeta(h.ctx.home,'recovery',meta);
 assert.equal((await runRelay(['close','recovery'],h.ctx)).code,0);const count=h.ctx.cmux.created.length;
 const result=await runRelay(['escalate','recovery','--from',from],h.ctx);assert.equal(result.last.error,'TASK_CLOSED');assert.equal(h.ctx.cmux.created.length,count);assert.equal(fs.existsSync(h.claim()),false);
});

test('stale quota waiters never relaunch an existing candidate or a closed task', async t => {
 const h=fixture(t);assert.equal((await h.spawn()).code,0);h.ctx.cmux.readScreen=()=>"You've hit your usage limit";
 const stale=h.meta(),d=stale.dispatches[0],tab=stale.tabs[0];
 assert.equal(await cmuxQuotaFallback(h.ctx,'recovery',stale,tab,d,{exitCode:5}),true);
 const count=h.ctx.cmux.created.length;
 assert.equal(await cmuxQuotaFallback(h.ctx,'recovery',stale,tab,d,{exitCode:5}),true);
 assert.equal(h.ctx.cmux.created.length,count);assert.equal(h.meta().tabs.length,2);
 assert.equal((await runRelay(['close','recovery'],h.ctx)).code,0);
 assert.equal(await cmuxQuotaFallback(h.ctx,'recovery',stale,tab,d,{exitCode:5}),false);
 assert.equal(h.ctx.cmux.created.length,count);
});
