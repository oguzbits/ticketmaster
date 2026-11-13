import { TestBed } from '@angular/core/testing';
import { ROLE } from '@app/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { accessTokenFor, tokensFor } from '../../testing/tokens';
import { SessionStore } from './session.store';

const store = () => TestBed.inject(SessionStore);

describe('SessionStore', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is logged out at first, then holds the tokens and the role from the access token', () => {
    expect(store().isLoggedIn()).toBe(false);
    expect(store().role()).toBeNull();

    store().set(tokensFor(ROLE.ORGANIZER));

    expect(store().isLoggedIn()).toBe(true);
    expect(store().role()).toBe(ROLE.ORGANIZER);
    expect(store().session()?.refreshToken).toBe(tokensFor(ROLE.ORGANIZER).refreshToken);
  });

  it('clear() logs out', () => {
    store().set(tokensFor(ROLE.ADMIN));
    store().clear();
    expect(store().isLoggedIn()).toBe(false);
  });

  it('refuses a token without a known role instead of guessing one', () => {
    const tokens = { ...tokensFor(ROLE.CUSTOMER), accessToken: accessTokenFor(['offline_access']) };
    expect(() => store().set(tokens)).toThrow();
    expect(store().isLoggedIn()).toBe(false);
  });

  it('survives a reload (sessionStorage) and forgets after clear()', () => {
    store().set(tokensFor(ROLE.CUSTOMER));
    TestBed.resetTestingModule();
    expect(store().role()).toBe(ROLE.CUSTOMER);

    store().clear();
    TestBed.resetTestingModule();
    expect(store().isLoggedIn()).toBe(false);
  });

  it('ignores stored data that does not match the session shape', () => {
    sessionStorage.setItem('session', '{"accessToken":1}');
    expect(store().isLoggedIn()).toBe(false);
  });

  it('keeps working in memory when the storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });

    expect(store().isLoggedIn()).toBe(false);
    store().set(tokensFor(ROLE.CUSTOMER));
    expect(store().role()).toBe(ROLE.CUSTOMER);
    store().clear();
    expect(store().isLoggedIn()).toBe(false);
  });
});
