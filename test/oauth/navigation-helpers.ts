import { expect } from 'vitest';
export async function navigationTarget(response: Response): Promise<string> {
  expect(response.status).toBe(200);
  expect(response.headers.get('Location')).toBeNull();
  const html = await response.clone().text();
  const target = /id="continue" href="([^"]+)"/.exec(html)?.[1];
  expect(target).toBeTruthy();
  return target!.replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)));
}
