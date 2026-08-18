import { describe, expect, it } from 'vitest';

import { ConfirmationStore, confirmationPrompt } from '../src/confirm.js';

describe('ConfirmationStore', () => {
  it('issues a token that can be consumed exactly once', () => {
    const store = new ConfirmationStore();
    const token = store.issue('set_document:pad');
    expect(store.consume('set_document:pad', token)).toBe(true);
    expect(store.consume('set_document:pad', token)).toBe(false);
  });

  it('binds the token to its resource', () => {
    const store = new ConfirmationStore();
    const token = store.issue('set_document:pad-a');
    expect(store.consume('set_document:pad-b', token)).toBe(false);
    // Bound resource still works afterwards — the failed attempt must not
    // consume it.
    expect(store.consume('set_document:pad-a', token)).toBe(true);
  });

  it('rejects a missing or wrong token', () => {
    const store = new ConfirmationStore();
    store.issue('r');
    expect(store.consume('r', undefined)).toBe(false);
    expect(store.consume('r', 'ffff')).toBe(false);
  });

  it('expires tokens after the TTL', () => {
    const store = new ConfirmationStore(-1);
    const token = store.issue('r');
    expect(store.consume('r', token)).toBe(false);
  });

  it('bounds the number of pending tokens', () => {
    const store = new ConfirmationStore();
    const first = store.issue('r0');
    for (let i = 1; i <= 100; i++) store.issue(`r${i}`);
    // r0 was evicted as the oldest entry.
    expect(store.consume('r0', first)).toBe(false);
  });

  it('reports the TTL in minutes', () => {
    expect(new ConfirmationStore(5 * 60 * 1000).ttlMinutes).toBe(5);
  });
});

describe('confirmationPrompt', () => {
  it('carries the token and the consequence', () => {
    const text = confirmationPrompt('replace pad "x"', 'abcd', 5, 'Gone.');
    expect(text).toContain('confirm_token="abcd"');
    expect(text).toContain('Gone.');
    expect(text).toContain('5 minutes');
  });
});
