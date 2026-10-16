import { expect, vi } from 'vitest';
import { StateContractError } from '../../../src/collab/contracts';

export function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Échoue si fn ne jette pas, ou si le code d'erreur diffère. */
export function expectCode(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, 'exception attendue pour code ' + code).toBeInstanceOf(StateContractError);
  expect((thrown as StateContractError).code).toBe(code);
}

/** Promise qui ne se résout jamais — pour tests timeout. */
export function hangFetch(): typeof fetch {
  return (() => new Promise<Response>(() => { /* hang */ })) as typeof fetch;
}

/** Await + code StateContractError + absence de chaînes interdites dans le message. */
export async function expectRejectCode(
  promise: Promise<unknown>,
  code: string,
  forbidden: string[] = [],
): Promise<void> {
  try {
    await promise;
    expect.fail('erreur attendue code ' + code);
  } catch (error) {
    expect(error).toBeInstanceOf(StateContractError);
    expect((error as StateContractError).code).toBe(code);
    const msg = String((error as Error).message);
    for (const token of forbidden) {
      expect(msg).not.toContain(token);
    }
  }
}

/** Mock fetch qui compte les appels et renvoie un statut HTTP. */
export function countingStatusFetch(status: number): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchImpl = vi.fn(async () => {
    calls += 1;
    return okJson({ error: { message: 'upstream' } }, status);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}
