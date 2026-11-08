import { describe, expect, it } from 'vitest';
import { grantForLaunch } from '../../../src/collab-store/agentrun/coordinator-launch';
import type { AgentRunObjectEnv } from '../../../src/collab-store/agentrun/object';

const grant = {cycle:'cc8-systeme-unique',task:'S7-compare-gemini-1',participant:'gemini',
  branch:'mcp/105856986/gemini-api-s7-compare-1',
  paths:['test/collab-store/agentrun/s7-compare-gemini-1.spec.ts']};
const config = {AGENT_RUNS_ENABLED:'true',AGENT_RUN_GITHUB_WRITES:'true',
  AGENT_RUN_PARTICIPANTS:'vibe,gemini',AGENT_RUN_GITHUB_WRITERS:'vibe,gemini',
  AGENT_RUN_GITHUB_TASKS:JSON.stringify([grant])} as AgentRunObjectEnv;
const get = (env:AgentRunObjectEnv=config,pid='gemini')=>
  grantForLaunch(env,'cc8-systeme-unique','S7-compare-gemini-1',pid);

describe('CC8 S7 direct API bridge — deny by default', () => {
  it('requires exact owner grant for participant, task and isolated branch',()=>{
    expect(get()).toEqual(grant);
    expect(()=>get(config,'vibe')).toThrow();
    expect(()=>get({...config,AGENT_RUN_GITHUB_TASKS:'[]'})).toThrow();
    expect(()=>get({...config,AGENT_RUN_GITHUB_TASKS:JSON.stringify([{...grant,branch:'main'}])})).toThrow();
  });
  it('refuses disabled API writing or any paid implement budget',()=>{
    expect(()=>get({...config,AGENT_RUNS_ENABLED:'false'})).toThrow();
    expect(()=>get({...config,AGENT_RUN_GITHUB_WRITERS:''})).toThrow();
    expect(()=>get({...config,AGENT_RUN_COST_CENTS_IMPLEMENT:'1'} as AgentRunObjectEnv)).toThrow();
  });
});
