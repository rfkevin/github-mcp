import { describe, expect, it, vi } from 'vitest';
import { claimMergeIntent, reconcileMergeIntent } from '../../../src/collab-store/gates/merge-intent';
const head='a'.repeat(40),base='b'.repeat(40);
const intent={cycle:'cycle',task:'l4',pr:167,head,base,now:100};
const fixture=(changes:number,row:{state:string;expires_at:number}|null=null)=>{
 const run=vi.fn(async()=>({meta:{changes}}));
 const first=vi.fn(async()=>row);
 const bind=vi.fn(()=>({run,first}));
 const prepare=vi.fn((_sql:string)=>({bind}));
 return {db:{prepare} as unknown as D1Database,prepare,bind};
};
describe('L4 D1 claim',()=>{
 it('rejects invalid input without writing',async()=>{
  const f=fixture(1);
  expect(await claimMergeIntent(f.db,{...intent,head:'bad'})).toBe(false);
  expect(f.prepare).not.toHaveBeenCalled();
 });
 it('single-use claim checks HALT and lease in atomic INSERT',async()=>{
  const f=fixture(1);
  expect(await claimMergeIntent(f.db,intent)).toBe(true);
  const sql=f.prepare.mock.calls[0][0];
  expect(sql).toContain('INSERT OR IGNORE');
  expect(sql).toContain('owner_flags');
  expect(sql).toContain('cc5_merge_leases');
  expect(sql).toContain('revoked=0');
  expect(await claimMergeIntent(fixture(0).db,intent)).toBe(false);
 });
 it('reconciliation observes merged, expired and uncertain without merge calls',async()=>{
  expect(await reconcileMergeIntent(fixture(1,{state:'claimed',expires_at:400}).db,intent,
    'c'.repeat(40),150)).toBe('merged');
  expect(await reconcileMergeIntent(fixture(1,{state:'claimed',expires_at:400}).db,intent,
    null,401)).toBe('expired');
  expect(await reconcileMergeIntent(fixture(1,{state:'claimed',expires_at:400}).db,intent,
    null,150)).toBe('uncertain');
 });
});
