import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../src/mcp/context';
import { WriteCoordinator } from '../../src/writes/coordinator';
import { GitHubApiError } from '../../src/github/types';
import { registerApplyChangesTool } from '../../src/mcp/tools/github/apply-changes';
import { toolRegistry } from './tool-registry';
const HEAD='a'.repeat(40), A='b'.repeat(40), B='c'.repeat(40), NEXT='d'.repeat(40), SOURCE='e'.repeat(40);
function fixture() {
  const files = new Map([['a.txt',{path:'a.txt',sha:A,size:7,content:'old one'}],['b.txt',{path:'b.txt',sha:B,size:2,content:'B\n'}]]);
  const reads = { repositories:{listInstallationRepositories:vi.fn(async()=>['o/r']),getRepository:vi.fn(async()=>({full_name:'o/r',default_branch:'master',archived:false}))},
    branches:{getBranchHead:vi.fn(async()=>HEAD)}, commits:{getCommit:vi.fn(async()=>({sha:SOURCE}))},
    files:{getTextFile:vi.fn(async(_r:string,p:string,ref:string)=>{ if(ref===SOURCE) return {path:p,sha:SOURCE,size:8,content:'restored'}; const f=files.get(p); if(!f) throw new GitHubApiError(404,'/file','missing'); return f; })} };
  const writes = { branches:{createWorkingBranch:vi.fn()}, changes:{applyChangeSet:vi.fn(async()=>({branch:'mcp/123/fix',commitSha:NEXT,changedPaths:['a.txt'],deletedPaths:[]}))},
    pullRequests:{createPullRequest:vi.fn(),getPullRequest:vi.fn()},issues:{createComment:vi.fn()},commits:{createComment:vi.fn()} };
  const coordinator = new WriteCoordinator('123', reads as any, writes as any);
  const tools = toolRegistry(registerApplyChangesTool,{actor:'123',reads,writeCoordinator:coordinator} as unknown as ToolContext);
  const apply=(operations:unknown[])=>tools.get('github_apply_changes')!({repository:'o/r',branch:'mcp/123/fix',expectedHeadSha:HEAD,message:'Batch',agentLabel:'Codex',operations});
  return {apply,reads,writes};
}
describe('github_apply_changes',()=>{
  it('combine replace append et create dans un seul commit',async()=>{ const {apply,writes}=fixture();
    const result=await apply([{type:'replace',path:'a.txt',expectedSha:A,oldText:'old',newText:'new'},{type:'append',path:'b.txt',expectedSha:B,text:'end'},{type:'create',path:'c.txt',content:'created'}]);
    expect(result.structuredContent).toMatchObject({applied:true,atomic:true,operationCount:3,commitSha:NEXT});
    expect(writes.changes.applyChangeSet).toHaveBeenCalledOnce();
    expect(writes.changes.applyChangeSet.mock.calls[0][2]).toEqual(expect.arrayContaining([
      {path:'a.txt',content:'new one',expectedSha:A},{path:'b.txt',content:'B\nend',expectedSha:B},{path:'c.txt',content:'created'}]));
  });
  it('applique plusieurs replace du même fichier dans l ordre',async()=>{ const {apply,writes}=fixture();
    await apply([{type:'replace',path:'a.txt',expectedSha:A,oldText:'old',newText:'new'},{type:'replace',path:'a.txt',expectedSha:A,oldText:'one',newText:'two'}]);
    expect(writes.changes.applyChangeSet.mock.calls[0][2][0]).toEqual({path:'a.txt',content:'new two',expectedSha:A});
  });
  it('collecte les préconditions invalides et n écrit rien',async()=>{ const {apply,writes}=fixture();
    const result=await apply([{type:'replace',path:'a.txt',expectedSha:A,oldText:'missing',newText:'x'},{type:'create',path:'b.txt',content:'x'}]);
    expect(result.structuredContent).toMatchObject({applied:false,atomic:true,errors:[{index:1,path:'b.txt',code:'FILE_CHANGED'}]});
    expect((result.structuredContent.errors as any[]).some(e=>e.code==='TEXT_NOT_FOUND')).toBe(true);
    expect(writes.changes.applyChangeSet).not.toHaveBeenCalled();
  });
  it('refuse restore ou create combiné sur le même chemin',async()=>{ const {apply,writes}=fixture();
    const restore=await apply([{type:'restore',path:'a.txt',expectedSha:A,sourceRef:'good'},{type:'append',path:'a.txt',expectedSha:A,text:'x'}]);
    expect(restore.structuredContent).toMatchObject({applied:false,errors:[{code:'RESTORE_COMBINATION_DENIED'}]});
    const create=await apply([{type:'create',path:'x.txt',content:'x'},{type:'append',path:'x.txt',expectedSha:A,text:'y'}]);
    expect(create.structuredContent).toMatchObject({applied:false,errors:[{code:'CREATE_COMBINATION_DENIED'}]});
    expect(writes.changes.applyChangeSet).not.toHaveBeenCalled();
  });
  it('refuse un head périmé avant les fichiers',async()=>{ const {apply,reads,writes}=fixture(); reads.branches.getBranchHead.mockResolvedValue(NEXT);
    expect(await apply([{type:'append',path:'a.txt',expectedSha:A,text:'x'}])).toMatchObject({structuredContent:{error:{code:'HEAD_CHANGED'}}});
    expect(reads.files.getTextFile).not.toHaveBeenCalled(); expect(writes.changes.applyChangeSet).not.toHaveBeenCalled();
  });
});
