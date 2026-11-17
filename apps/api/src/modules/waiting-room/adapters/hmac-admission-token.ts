import { Logger } from '@nestjs/common';
import { errors, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

import type { AdmissionTokenPayload, AdmissionTokenPort } from '../domain/admission-token.js';

const ISSUER = 'ticketmaster-waiting-room';
const AUDIENCE = 'ticketmaster-bookings';
const SECOND_MS = 1000;

const ClaimsSchema = z.object({
  eventId: z.string().min(1),
  admittedUntilMs: z.number().int().positive(),
});

/**
 * Issues and verifies stateless HS256 admission JWTs backed by `WAITING_ROOM_SIGNING_SECRET`.
 * Every token is scoped to one `(sub = userId, eventId)` pair and stores millisecond expiry
 * (`admittedUntilMs`) alongside standard JWT `exp`.
 */
export class HmacAdmissionTokenAdapter implements AdmissionTokenPort {
  private readonly logger = new Logger(HmacAdmissionTokenAdapter.name);
  private readonly secret: Uint8Array;

  constructor(signingSecret: string) {
    this.secret = new TextEncoder().encode(signingSecret);
  }

  async issue(payload: AdmissionTokenPayload, now: Date): Promise<string> {
    const exp = Math.ceil(payload.admittedUntil.getTime() / SECOND_MS);
    const iat = Math.floor(now.getTime() / SECOND_MS);
    return new SignJWT({
      eventId: payload.eventId,
      admittedUntilMs: payload.admittedUntil.getTime(),
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(payload.userId)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.secret);
  }

  async verify(
    token: string,
    expected: { eventId: string; userId: string },
    now: Date
  ): Promise<boolean> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
        subject: expected.userId,
        currentDate: now,
        requiredClaims: ['exp', 'sub'],
      });
      const claims = ClaimsSchema.parse(payload);
      return claims.eventId === expected.eventId && claims.admittedUntilMs > now.getTime();
    } catch (error) {
      if (error instanceof errors.JOSEError || error instanceof z.ZodError) {
        this.logger.debug(`admission token rejected: ${error.name}`);
        return false;
      }
      throw error;
    }
  }
}
