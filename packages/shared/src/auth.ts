import { array, enum as zEnum, type infer as ZodInfer, number, object, string } from 'zod';

export const ROLE = {
  CUSTOMER: 'customer',
  ORGANIZER: 'organizer',
  ADMIN: 'admin',
} as const;

export const RoleSchema = zEnum(ROLE);

export const DemoLoginRequestSchema = object({ role: RoleSchema });

export const RefreshRequestSchema = object({ refreshToken: string().min(1) });

export const TokenResponseSchema = object({
  accessToken: string(),
  refreshToken: string(),
  expiresIn: number().int().positive(),
});

/** The part of a Keycloak access token the web app reads to show the role. Display only, never trusted. */
export const AccessTokenClaimsSchema = object({
  realm_access: object({ roles: array(string()) }),
});

export type Role = ZodInfer<typeof RoleSchema>;
export type DemoLoginRequest = ZodInfer<typeof DemoLoginRequestSchema>;
export type RefreshRequest = ZodInfer<typeof RefreshRequestSchema>;
export type TokenResponse = ZodInfer<typeof TokenResponseSchema>;
