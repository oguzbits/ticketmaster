import { describe, expect, it } from 'vitest';

import { SPEC_NOW } from '../../../testing/time.js';
import { HmacAdmissionTokenAdapter } from './hmac-admission-token.js';

const SECRET = 'test-waiting-room-signing-secret-0123456789';
const OTHER_SECRET = 'other-waiting-room-signing-secret-0123456789';
const EVENT_ID = '00000000-0000-4000-8000-000000000001';
const USER_ID = '00000000-0000-4000-8000-000000000002';
const ADMITTED_UNTIL = new Date(SPEC_NOW.getTime() + 60_000);

describe('HmacAdmissionTokenAdapter', () => {
  const adapter = new HmacAdmissionTokenAdapter(SECRET);

  it('issues a token that verifies for matching event, user and active window', async () => {
    const token = await adapter.issue(
      { eventId: EVENT_ID, userId: USER_ID, admittedUntil: ADMITTED_UNTIL },
      SPEC_NOW
    );

    expect(await adapter.verify(token, { eventId: EVENT_ID, userId: USER_ID }, SPEC_NOW)).toBe(
      true
    );
  });

  it('rejects wrong user, wrong event, tampered signature, wrong secret and expired token', async () => {
    const token = await adapter.issue(
      { eventId: EVENT_ID, userId: USER_ID, admittedUntil: ADMITTED_UNTIL },
      SPEC_NOW
    );
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.tampered`;
    const otherSigner = new HmacAdmissionTokenAdapter(OTHER_SECRET);

    expect(
      await adapter.verify(
        token,
        { eventId: EVENT_ID, userId: '00000000-0000-4000-8000-000000000099' },
        SPEC_NOW
      )
    ).toBe(false);
    expect(
      await adapter.verify(
        token,
        { eventId: '00000000-0000-4000-8000-000000000099', userId: USER_ID },
        SPEC_NOW
      )
    ).toBe(false);
    expect(await adapter.verify(tampered, { eventId: EVENT_ID, userId: USER_ID }, SPEC_NOW)).toBe(
      false
    );
    expect(await otherSigner.verify(token, { eventId: EVENT_ID, userId: USER_ID }, SPEC_NOW)).toBe(
      false
    );
    expect(
      await adapter.verify(
        token,
        { eventId: EVENT_ID, userId: USER_ID },
        new Date(ADMITTED_UNTIL.getTime() + 1)
      )
    ).toBe(false);
  });
});
