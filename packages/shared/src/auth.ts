import { z } from 'zod';

export const ROLE = {
  CUSTOMER: 'customer',
  ORGANIZER: 'organizer',
  ADMIN: 'admin',
} as const;

export const RoleSchema = z.enum(ROLE);

export const DemoLoginRequestSchema = z.object({ role: RoleSchema });

export const RefreshRequestSchema = z.object({ refreshToken: z.string().min(1) });

export const TokenResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int().positive(),
});

/** The part of a Keycloak access token the web app reads to show the role. Display only, never trusted. */
export const AccessTokenClaimsSchema = z.object({
  realm_access: z.object({ roles: z.array(z.string()) }),
});

export type Role = z.infer<typeof RoleSchema>;
export type DemoLoginRequest = z.infer<typeof DemoLoginRequestSchema>;
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;
export type TokenResponse = z.infer<typeof TokenResponseSchema>;
