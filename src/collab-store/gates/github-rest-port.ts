/** CC-5 L4 GitHub REST implementation. Inject authenticated GitHub request; no token here. */
import type { MergeGitHubPort } from './github-merge-executor';
export interface GitHubRestRequest {
  <T>(path: string, init?: { method: 'POST'|'PATCH'|'DELETE'; body?: string }): Promise<T>;
}
const SHA=/^[a-f0-9]{40}$/;
const REF=/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/;
export function createGitHubRestPort(request: GitHubRestRequest, repository: string,
  pr: number, integrationBranch: string, attemptId: string): MergeGitHubPort {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository) ||
      !Number.isSafeInteger(pr) || pr<=0 || !REF.test(integrationBranch) ||
      !/^[a-z0-9-]{8,64}$/.test(attemptId)) throw new Error('L4_REST_TARGET_INVALID');
  const root='/repos/'+repository;
  const temp='cc5-l4/'+attemptId;
  const refPath=(branch:string)=>root+'/git/refs/heads/'+branch.split('/').map(encodeURIComponent).join('/');
  const readBranch=async (branch:string)=>{
    const ref=await request<{object:{sha:string}}>(refPath(branch));
    if (!SHA.test(ref.object.sha)) throw new Error('L4_INVALID_REF_SHA');
    return ref.object.sha;
  };
  return {
    async createTemporaryBranch(base) {
      if (!SHA.test(base)) throw new Error('L4_INVALID_BASE');
      await request(root+'/git/refs',{method:'POST',body:JSON.stringify({ref:'refs/heads/'+temp,sha:base})});
      return temp;
    },
    async mergeIntoTemporary(branch,head) {
      if (branch!==temp || !SHA.test(head)) throw new Error('L4_TEMP_MISMATCH');
      const result=await request<{sha:string}>(root+'/merges',{method:'POST',
        body:JSON.stringify({base:temp,head,commit_message:'CC-5 L4 merge PR #'+pr})});
      if (!result || !SHA.test(result.sha)) throw new Error('L4_MERGE_RESULT_UNKNOWN');
      return result.sha;
    },
    async readHeads() {
      const [pull,base]=await Promise.all([
        request<{head:{sha:string}}>(root+'/pulls/'+pr),
        readBranch(integrationBranch)]);
      if (!SHA.test(pull.head.sha)) throw new Error('L4_INVALID_HEAD');
      return {head:pull.head.sha,base};
    },
    async fastForwardBase(sha) {
      if (!SHA.test(sha)) throw new Error('L4_INVALID_MERGE_SHA');
      try {
        await request(refPath(integrationBranch),{method:'PATCH',body:JSON.stringify({sha,force:false})});
      } catch(error) {
        if ((error as {status?:number}).status===422) throw new Error('BASE_CHANGED');
        throw error;
      }
    },
    async deleteTemporaryBranch(branch) {
      if (branch!==temp) throw new Error('L4_TEMP_MISMATCH');
      await request(refPath(temp),{method:'DELETE'});
    },
  };
}
