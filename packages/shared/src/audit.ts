import { z } from 'zod';

/** The state changes the audit log records, one row each. Reads, hold expiry and failed payments are not audited. */
export const AUDIT_ACTION = {
  BOOKING_HELD: 'BOOKING_HELD',
  BOOKING_PAID: 'BOOKING_PAID',
  BOOKING_CANCELLED: 'BOOKING_CANCELLED',
  PAYMENT_REFUNDED: 'PAYMENT_REFUNDED',
  EVENT_CREATED: 'EVENT_CREATED',
  EVENT_STRATEGY_SWITCHED: 'EVENT_STRATEGY_SWITCHED',
  WAITING_ROOM_SETTINGS_CHANGED: 'WAITING_ROOM_SETTINGS_CHANGED',
  SIMULATION_STARTED: 'SIMULATION_STARTED',
} as const;

/** What an audit row's `subjectId` points at. */
export const AUDIT_SUBJECT = {
  BOOKING: 'BOOKING',
  EVENT: 'EVENT',
  SIMULATION_RUN: 'SIMULATION_RUN',
} as const;

export const AUDIT_LOG_LIMITS = { PAGE_DEFAULT: 50, PAGE_MAX: 100, REQUEST_ID_MAX: 128 } as const;

export const AuditActionSchema = z.enum(AUDIT_ACTION);
export const AuditSubjectSchema = z.enum(AUDIT_SUBJECT);

export type AuditAction = z.infer<typeof AuditActionSchema>;
export type AuditSubject = z.infer<typeof AuditSubjectSchema>;

/** A row ID is a database identity (a safe integer); 15 digits stay inside bigint and JS numbers. */
const AuditIdSchema = z.string().regex(/^\d{1,15}$/);

/** IDs only: who (`actorId`), what (`subjectType`, `subjectId`), and the request that did it. */
export const AuditEntrySchema = z.object({
  id: AuditIdSchema,
  at: z.iso.datetime(),
  actorId: z.uuid(),
  action: AuditActionSchema,
  subjectType: AuditSubjectSchema,
  subjectId: z.uuid(),
  requestId: z.string().min(1).max(AUDIT_LOG_LIMITS.REQUEST_ID_MAX),
});

/** Newest first; `cursor` is the `id` of the last row of the previous page. */
export const AuditLogQuerySchema = z.object({
  action: AuditActionSchema.optional(),
  actorId: z.uuid().optional(),
  cursor: AuditIdSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(AUDIT_LOG_LIMITS.PAGE_MAX)
    .default(AUDIT_LOG_LIMITS.PAGE_DEFAULT),
});

export const AuditLogPageSchema = z.object({
  items: z.array(AuditEntrySchema),
  nextCursor: AuditIdSchema.nullable(),
});

export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export type AuditLogQuery = z.infer<typeof AuditLogQuerySchema>;
export type AuditLogPage = z.infer<typeof AuditLogPageSchema>;
