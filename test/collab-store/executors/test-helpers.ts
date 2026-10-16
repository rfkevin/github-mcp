import { expect } from 'vitest';
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
