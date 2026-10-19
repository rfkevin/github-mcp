import { describe, expect, it, vi } from 'vitest';
import { createGitHubMergeExecutor, type MergeGitHubPort } from '../../../src/collab-store/gates/github-merge-executor';
import type { ControllerSnapshot } from '../../../src/collab-store/controller/rules';
import type { MergeCandidate } from '../../../src/collab-store/gates';
const head='a'.repeat(40),base='b'.repeat(40),sha='c'.repeat(40);
const snapshot: ControllerSnapshot={cycle_id:'cycle',revision:1,phase:'P6',halted:false,
  auto_advance:'none',outputs_satisfied:false,tasks:[{task_id:'l4',status:'review',revision:1,
  owner:'gpt6',reviewer:'claude',tester:'vibe',dependencies:[],
  submission:{head,base,seq:1},verdicts:[
    {participant:'claude',verdict:'positive',head,base,seq:2},
    {participant:'vibe',verdict:'positive',head,base,seq:3}]}]};
const candidate: MergeCandidate={cycleId:'cycle',taskId:'l4',head,base,integrationBase:base,
  prDraft:false,prMergeable:true,ciChecks:[{name:'ci',status:'completed',conclusion:'success'}],
  expectedChecks:['ci'],changedPaths:['src/collab-store/gates/index.ts'],protectedPaths:['.github'],
  lease:{cycleId:'cycle',taskId:'l4',head,base,expiresAt:1000,revoked:false},now:100};
function fixture() {
  const readHeads=vi.fn(async()=>({head,base}));
  const createTemporaryBranch=vi.fn(async()=> 'cc5-temp-unique');
  const mergeIntoTemporary=vi.fn(async()=>sha);
  const fastForwardBase=vi.fn(async()=>undefined);
  const deleteTemporaryBranch=vi.fn(async()=>undefined);
  const github: MergeGitHubPort = {readHeads,createTemporaryBranch,mergeIntoTemporary,fastForwardBase,deleteTemporaryBranch};
  const db={prepare:vi.fn(()=>({bind:()=>({run:async()=>({meta:{changes:1}})})})),batch:vi.fn(async()=>[])} as unknown as D1Database;
  const inspect=vi.fn(async()=>({snapshot,candidate}));
  const intent={cycle:'cycle',task:'l4',pr:167,head,base,now:100};
  return {github,db,inspect,intent,readHeads,fastForwardBase,mergeIntoTemporary};
}
const verify=(s:ControllerSnapshot,c:MergeCandidate)=>!s.halted&&!c.lease?.revoked;
describe('L4 base CAS executor',()=>{
  it('is disabled without owner activation',async()=>{
    const f=fixture();const writer=createGitHubMergeExecutor(f);
    await expect(writer.mergeUnderFence({head,base},verify)).rejects.toThrow('L4_MERGE_DISABLED');
    expect(f.fastForwardBase).not.toHaveBeenCalled();
  });
  it('claims then merges temporary branch and fast-forwards',async()=>{
    const f=fixture();const writer=createGitHubMergeExecutor({...f,enabled:true});
    await expect(writer.mergeUnderFence({head,base},verify)).resolves.toEqual({merged:true,mergeSha:sha});
    expect(f.github.createTemporaryBranch).toHaveBeenCalledWith(base);
    expect(f.fastForwardBase).toHaveBeenCalledWith(sha);
  });
  it('rejects a changed base before any merge',async()=>{
    const f=fixture();f.readHeads.mockResolvedValueOnce({head,base:'d'.repeat(40)});
    const writer=createGitHubMergeExecutor({...f,enabled:true});
    await expect(writer.mergeUnderFence({head,base},verify)).rejects.toThrow('BASE_OR_HEAD_CHANGED');
    expect(f.mergeIntoTemporary).not.toHaveBeenCalled();
  });
  it('rejects a base advance after temporary merge, immediately before PATCH',async()=>{
    const f=fixture();f.readHeads.mockResolvedValueOnce({head,base})
      .mockResolvedValueOnce({head,base:'d'.repeat(40)});
    const writer=createGitHubMergeExecutor({...f,enabled:true});
    await expect(writer.mergeUnderFence({head,base},verify)).rejects.toThrow('L4_PRE_PATCH_DENIED');
    expect(f.mergeIntoTemporary).toHaveBeenCalledTimes(1);
    expect(f.fastForwardBase).not.toHaveBeenCalled();
  });
  it('rejects HALT between claim and PATCH',async()=>{
    const f=fixture();f.inspect.mockResolvedValueOnce({snapshot,candidate})
      .mockResolvedValueOnce({snapshot:{...snapshot,halted:true},candidate});
    await expect(createGitHubMergeExecutor({...f,enabled:true})
      .mergeUnderFence({head,base},verify)).rejects.toThrow('L4_PRE_PATCH_DENIED');
    expect(f.fastForwardBase).not.toHaveBeenCalled();
  });
  it('rejects revoked lease between claim and PATCH',async()=>{
    const f=fixture();f.inspect.mockResolvedValueOnce({snapshot,candidate})
      .mockResolvedValueOnce({snapshot,candidate:{...candidate,lease:{...candidate.lease!,revoked:true}}});
    await expect(createGitHubMergeExecutor({...f,enabled:true})
      .mergeUnderFence({head,base},verify)).rejects.toThrow('L4_PRE_PATCH_DENIED');
    expect(f.fastForwardBase).not.toHaveBeenCalled();
  });
});
