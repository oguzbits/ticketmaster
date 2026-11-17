import { DatePipe } from '@angular/common';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import {
  AUDIT_ACTION,
  type AuditAction,
  AuditActionSchema,
  type AuditEntry,
  AuditLogQuerySchema,
} from '@app/shared';
import { Subscription } from 'rxjs';

import { AuditLogService } from './audit-log.service';

/** The admin's audit log: who did what to which subject, newest first, filtered by action and actor. */
@Component({
  selector: 'app-audit-log-page',
  imports: [DatePipe],
  templateUrl: './audit-log-page.html',
  host: { class: 'flex flex-col gap-6' },
})
export class AuditLogPage {
  private readonly service = inject(AuditLogService);
  private request: Subscription | null = null;

  protected readonly actions = Object.values(AUDIT_ACTION);
  protected readonly action = signal<AuditAction | undefined>(undefined);
  protected readonly actorId = signal<string | undefined>(undefined);
  /** The text in the actor field is not an ID; the filter and the rows stay as they were. */
  protected readonly actorInvalid = signal(false);
  protected readonly items = signal<AuditEntry[]>([]);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  /** The cursor of the request that failed, so Retry repeats exactly that request. */
  private failedCursor: string | undefined;

  constructor() {
    this.load(undefined);
    inject(DestroyRef).onDestroy(() => this.request?.unsubscribe());
  }

  protected pickAction(value: string): void {
    this.action.set(value === '' ? undefined : AuditActionSchema.parse(value));
    this.reload();
  }

  protected pickActor(value: string): void {
    const text = value.trim();
    const parsed = AuditLogQuerySchema.shape.actorId.safeParse(text === '' ? undefined : text);
    this.actorInvalid.set(!parsed.success);
    if (!parsed.success) return;
    this.actorId.set(parsed.data);
    this.reload();
  }

  private reload(): void {
    this.items.set([]);
    this.nextCursor.set(null);
    this.load(undefined);
  }

  protected retry(): void {
    this.load(this.failedCursor);
  }

  protected loadMore(): void {
    const cursor = this.nextCursor();
    if (cursor && !this.loading()) this.load(cursor);
  }

  /** A new request replaces a running one, so a slow answer never overwrites a newer filter. */
  private load(cursor: string | undefined): void {
    this.request?.unsubscribe();
    this.loading.set(true);
    this.failed.set(false);
    this.request = this.service
      .page({
        ...(this.action() ? { action: this.action() } : {}),
        ...(this.actorId() ? { actorId: this.actorId() } : {}),
        ...(cursor ? { cursor } : {}),
      })
      .subscribe({
        next: (page) => {
          this.loading.set(false);
          this.items.update((current) => [...current, ...page.items]);
          this.nextCursor.set(page.nextCursor);
        },
        error: () => {
          this.loading.set(false);
          this.failed.set(true);
          this.failedCursor = cursor;
        },
      });
  }
}
