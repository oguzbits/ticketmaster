import type { UserDirectory } from '../domain/ticket.js';

/** Addresses by user ID; a user without one, or a failing lookup, throws like the real directory. */
export class FakeUserDirectory implements UserDirectory {
  readonly addresses = new Map<string, string>();
  /** How many lookups still fail (the directory is down). */
  failures = 0;

  emailOf(userId: string): Promise<string> {
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new Error('directory is down'));
    }
    const address = this.addresses.get(userId);
    return address === undefined
      ? Promise.reject(new Error(`user ${userId} has no email`))
      : Promise.resolve(address);
  }
}
