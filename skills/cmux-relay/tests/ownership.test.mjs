import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withOwnership, releaseOwnership } from '../scripts/lib/ownership.mjs';
const fixture = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(),'relay-owns-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); const cwd=path.join(dir,'repo');fs.mkdirSync(cwd);return {dir,cwd,ctx:{home:path.join(dir,'home'),runGit:()=>''}}; };
const reserve=(ctx,cwd,taskId,owns,fn=()=>true,extra={})=>withOwnership(ctx,{taskId,cwd,owns,...extra},fn);

test('reserves explicit paths; rejects parents and descendants while accepting siblings',async t=>{
 const {ctx,cwd}=fixture(t);
 await reserve(ctx,cwd,'first',['src/a']);
 await assert.rejects(reserve(ctx,cwd,'second',['src']),{code:'OWNERSHIP_CONFLICT'});
 await assert.rejects(reserve(ctx,cwd,'third',['src/a/deep']),e=>e.code==='OWNERSHIP_CONFLICT'&&e.message.includes('first')&&e.message.includes('src/a'));
 await reserve(ctx,cwd,'fourth',['src/ab']);
 assert.equal(releaseOwnership(ctx.home,'first'),true);
 await reserve(ctx,cwd,'fifth',['src/a']);
});
test('rejects traversal, glob, absolute and escaping symlinks; resolves aliases',async t=>{
 const {ctx,cwd,dir}=fixture(t);fs.mkdirSync(path.join(cwd,'real'));fs.symlinkSync(path.join(cwd,'real'),path.join(cwd,'alias'));fs.symlinkSync(dir,path.join(cwd,'outside'));fs.symlinkSync(path.join(dir,'missing'),path.join(cwd,'dangling'));
 for(const p of ['../x','a/../x','/etc','src/*','outside/new','dangling/new']) await assert.rejects(reserve(ctx,cwd,'invalid',[p]),{code:'OWNERSHIP_INVALID'});
 await reserve(ctx,cwd,'first',['alias/new']);
 await assert.rejects(reserve(ctx,cwd,'second',['real/new']),{code:'OWNERSHIP_CONFLICT'});
});
test('failed callbacks release new claims but cannot delete preexisting same task',async t=>{
 const {ctx,cwd}=fixture(t);
 await assert.rejects(reserve(ctx,cwd,'failed',['src'],()=>{throw Error('callback failure')}),/callback failure/);
 assert.equal(fs.existsSync(path.join(ctx.home,'ownership/failed.json')),false);
 await reserve(ctx,cwd,'existing',['src']);
 await assert.rejects(reserve(ctx,cwd,'existing',['other']),{code:'TASK_EXISTS'});
 assert.equal(fs.existsSync(path.join(ctx.home,'ownership/existing.json')),true);
});
test('concurrent reservations only admit one; lock lifetime excludes callback',async t=>{
 const {ctx,cwd}=fixture(t);let resolve;const pending=new Promise(r=>{resolve=r});
 const a=reserve(ctx,cwd,'one',['src'],()=>pending);
 await assert.rejects(reserve(ctx,cwd,'two',['src']),{code:'OWNERSHIP_CONFLICT'});
 await reserve(ctx,cwd,'three',['other']);resolve('ok');assert.equal(await a,'ok');
 fs.mkdirSync(path.join(ctx.home,'ownership.lock'));
 await assert.rejects(reserve(ctx,cwd,'four',['else']),{code:'OWNERSHIP_BUSY'});
});
test('dry-run and legacy empty owns do not mutate; dry-run detects conflicts',async t=>{
 const {ctx,cwd}=fixture(t);
 assert.equal(await reserve(ctx,cwd,'dry',['src'],()=>42,{dryRun:true}),42);
 assert.equal(fs.existsSync(ctx.home),false);
 await reserve(ctx,cwd,'legacy',[]);
 assert.equal(fs.existsSync(ctx.home),false);
 await reserve(ctx,cwd,'actual',['src']);
 await assert.rejects(reserve(ctx,cwd,'dry',['src'],()=>true,{dryRun:true}),{code:'OWNERSHIP_CONFLICT'});
});
test('worktrees share git common-dir ownership scope',async t=>{
 const {ctx,cwd,dir}=fixture(t);const other=path.join(dir,'worktree');const common=path.join(cwd,'.git');fs.mkdirSync(other);fs.mkdirSync(common);
 ctx.runGit=args=>args.at(-1)==='--git-common-dir'?common:args[1];
 await reserve(ctx,cwd,'first',['src/a']);
 await assert.rejects(reserve(ctx,other,'second',['src/a']),{code:'OWNERSHIP_CONFLICT'});
 await reserve(ctx,other,'third',['src/b']);
});

test('retains a new claim when a live-child launch failure requires recovery',async t=>{
 const {ctx,cwd}=fixture(t);const error=Object.assign(new Error('discovery failed'),{retainOwnership:true});
 await assert.rejects(reserve(ctx,cwd,'recoverable',['src'],()=>{throw error}),/discovery failed/);
 assert.equal(fs.existsSync(path.join(ctx.home,'ownership/recoverable.json')),true);
 await assert.rejects(reserve(ctx,cwd,'competing',['src']),{code:'OWNERSHIP_CONFLICT'});
 assert.equal(releaseOwnership(ctx.home,'recoverable'),true);
});

test('non-Git nested cwd reservations refer to the same physical files', async t => {
 const {ctx,cwd}=fixture(t); const nested=path.join(cwd,'src'); fs.mkdirSync(nested);
 await reserve(ctx,cwd,'parent',['src/a.mjs']);
 await assert.rejects(reserve(ctx,nested,'nested',['a.mjs']),{code:'OWNERSHIP_CONFLICT'});
 await reserve(ctx,nested,'sibling',['b.mjs']);
});
