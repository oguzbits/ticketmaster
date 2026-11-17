import {
  array,
  coerce,
  enum as zEnum,
  type infer as ZodInfer,
  iso,
  object,
  string,
  uuid,
} from 'zod';

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

export const AuditActionSchema = zEnum(AUDIT_ACTION);
export const AuditSubjectSchema = zEnum(AUDIT_SUBJECT);

export type AuditAction = ZodInfer<typeof AuditActionSchema>;
export type AuditSubject = ZodInfer<typeof AuditSubjectSchema>;

/** A row ID is a database identity (a safe integer); 15 digits stay inside bigint and JS numbers. */
const AuditIdSchema = string().regex(/^\d{1,15}$/);

/** IDs only: who (`actorId`), what (`subjectType`, `subjectId`), and the request that did it. */
export const AuditEntrySchema = object({
  id: AuditIdSchema,
  at: iso.datetime(),
  actorId: uuid(),
  action: AuditActionSchema,
  subjectType: AuditSubjectSchema,
  subjectId: uuid(),
  requestId: string().min(1).max(AUDIT_LOG_LIMITS.REQUEST_ID_MAX),
});

/** Newest first; `cursor` is the `id` of the last row of the previous page. */
export const AuditLogQuerySchema = object({
  action: AuditActionSchema.optional(),
  actorId: uuid().optional(),
  cursor: AuditIdSchema.optional(),
  limit: coerce
    .number()
    .int()
    .min(1)
    .max(AUDIT_LOG_LIMITS.PAGE_MAX)
    .default(AUDIT_LOG_LIMITS.PAGE_DEFAULT),
});

export const AuditLogPageSchema = object({
  items: array(AuditEntrySchema),
  nextCursor: AuditIdSchema.nullable(),
});

export type AuditEntry = ZodInfer<typeof AuditEntrySchema>;
export type AuditLogQuery = ZodInfer<typeof AuditLogQuerySchema>;
export type AuditLogPage = ZodInfer<typeof AuditLogPageSchema>;
