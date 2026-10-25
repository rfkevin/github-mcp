import { describe, expect, it } from 'vitest';
import {
  authorizationKey,
  normalizeAccessChannel,
  sameAuthorization,
} from '../../../src/collab-store/identity/channel-parity';

describe('CC-7 L1 — parité des canaux (S1)', () => {
  it('authorizationKey ignore le canal', () => {
    expect(authorizationKey('grok', 'chat')).toBe('grok');
    expect(authorizationKey('grok', 'api')).toBe('grok');
    expect(authorizationKey('grok', 'unknown')).toBe('grok');
    expect(authorizationKey('grok')).toBe(authorizationKey('grok', 'api'));
  });

  it('sameAuthorization est vrai pour le même participant quel que soit le canal', () => {
    expect(sameAuthorization('claude', 'claude', 'chat', 'api')).toBe(true);
    expect(sameAuthorization('claude', 'grok', 'chat', 'chat')).toBe(false);
  });

  it('normalizeAccessChannel est fail-closed vers unknown', () => {
    expect(normalizeAccessChannel('chat')).toBe('chat');
    expect(normalizeAccessChannel('api')).toBe('api');
    expect(normalizeAccessChannel('webhook')).toBe('unknown');
    expect(normalizeAccessChannel(null)).toBe('unknown');
  });
});
