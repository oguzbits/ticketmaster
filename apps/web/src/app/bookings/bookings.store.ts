import { HttpErrorResponse, HttpStatusCode } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { type Booking, BOOKING_STATUS } from '@app/shared';
import { map, Subject, timer } from 'rxjs';

import { BookingsService } from './bookings.service';

export const BOOKING_ACTION = { HOLD: 'hold', PAY: 'pay', CANCEL: 'cancel' } as const;
type BookingAction = (typeof BOOKING_ACTION)[keyof typeof BOOKING_ACTION];

export interface Notice {
  text: string;
  error: boolean;
}

const MESSAGE = {
  TAKEN: 'That seat was just taken by someone else. The map shows its current status.',
  EXPIRED: 'Your hold expired and the seat is free again. Pick a seat to start over.',
  PAYMENT_UNCONFIRMED:
    'The payment was not confirmed because the connection failed. Try again; you are not charged twice.',
  PAYMENT_FAILED: 'Payment failed. Nothing was charged and the seat is free again.',
  CANCELLED: 'Hold cancelled. The seat is free again.',
  TOO_MANY: 'Too many requests. Wait a moment and try again.',
  GENERIC: 'That did not work. Try again.',
} as const;

const TICK_MS = 1000;

/**
 * The booking of one seat map: hold, payment and cancellation of the caller's booking, with the
 * countdown to the hold's expiry. One instance per seat map (provided by the component).
 */
@Injectable()
export class BookingsStore {
  private readonly service = inject(BookingsService);

  readonly booking = signal<Booking | null>(null);
  /** The action that is on its way; controls are disabled and a second submit is ignored. */
  readonly pending = signal<BookingAction | null>(null);
  readonly notice = signal<Notice | null>(null);
  /** Emits after every answer from the server: the seat map should read the seats again. */
  readonly settled = new Subject<void>();

  private readonly now = toSignal(timer(0, TICK_MS).pipe(map(() => Date.now())), {
    initialValue: Date.now(),
  });
  readonly secondsLeft = computed(() => {
    const booking = this.booking();
    if (booking?.status !== BOOKING_STATUS.HELD) return null;
    return Math.max(0, Math.ceil((Date.parse(booking.holdExpiresAt) - this.now()) / TICK_MS));
  });
  readonly holdRanOut = computed(() => this.secondsLeft() === 0);
  /** A hold that is still running: no second hold meanwhile. */
  readonly holding = computed(
    () => this.booking()?.status === BOOKING_STATUS.HELD && !this.holdRanOut()
  );
  /** Controls are free: no request on its way and no hold running. */
  readonly canHold = computed(() => this.pending() === null && !this.holding());
  /** The countdown as `m:ss`. */
  readonly countdown = computed(() => {
    const seconds = this.secondsLeft() ?? 0;
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  });

  /**
   * Generated once per payment attempt (a new hold starts a new one) and sent again when the user
   * repeats the payment of the same hold, so a retry after a lost answer cannot charge twice.
   */
  private paymentKey: string | null = null;

  hold(eventId: string, seatId: string): void {
    if (!this.canHold()) return;
    this.start(BOOKING_ACTION.HOLD);
    this.service.hold(eventId, seatId).subscribe({
      next: (booking) => {
        this.paymentKey = null;
        this.finish(booking);
      },
      error: (error: Error) => {
        const status = statusOf(error);
        if (status === HttpStatusCode.Conflict) this.fail(MESSAGE.TAKEN);
        else if (status === HttpStatusCode.TooManyRequests) this.fail(MESSAGE.TOO_MANY);
        else this.fail(MESSAGE.GENERIC);
      },
    });
  }

  pay(): void {
    const booking = this.booking();
    if (this.pending() !== null || booking?.status !== BOOKING_STATUS.HELD) {
      return;
    }
    this.paymentKey ??= crypto.randomUUID();
    this.start(BOOKING_ACTION.PAY);
    this.service.pay(booking.id, this.paymentKey).subscribe({
      next: (result) => {
        const failed = result.status === BOOKING_STATUS.CANCELLED;
        this.finish(result, failed ? { text: MESSAGE.PAYMENT_FAILED, error: true } : null);
      },
      error: (error: Error) => {
        const status = statusOf(error);
        // No answer or a server error: the charge may have happened, so the attempt keeps its key.
        if (status === 0 || status >= HttpStatusCode.InternalServerError) {
          this.fail(MESSAGE.PAYMENT_UNCONFIRMED);
          return;
        }
        if (status === HttpStatusCode.Conflict) this.fail(MESSAGE.EXPIRED, true);
        else if (status === HttpStatusCode.TooManyRequests) this.fail(MESSAGE.TOO_MANY);
        else this.fail(MESSAGE.GENERIC);
      },
    });
  }

  cancel(): void {
    const booking = this.booking();
    if (this.pending() !== null || booking?.status !== BOOKING_STATUS.HELD) return;
    this.start(BOOKING_ACTION.CANCEL);
    this.service.cancel(booking.id).subscribe({
      next: () => this.finish(null, { text: MESSAGE.CANCELLED, error: false }),
      error: (error: Error) => {
        // 409: the hold is no longer cancellable (it expired meanwhile).
        if (statusOf(error) === HttpStatusCode.Conflict) this.fail(MESSAGE.EXPIRED, true);
        else this.fail(MESSAGE.GENERIC);
      },
    });
  }

  /** Closes the confirmation or failure panel. */
  dismiss(): void {
    this.booking.set(null);
    this.notice.set(null);
  }

  private start(action: BookingAction): void {
    this.pending.set(action);
    this.notice.set(null);
  }

  private finish(booking: Booking | null, notice: Notice | null = null): void {
    this.booking.set(booking);
    this.notice.set(notice);
    this.pending.set(null);
    this.settled.next();
  }

  /** `endsBooking`: the failure means the booking is over, so the panel closes. */
  private fail(text: string, endsBooking = false): void {
    if (endsBooking) this.booking.set(null);
    this.notice.set({ text, error: true });
    this.pending.set(null);
    this.settled.next();
  }
}

/** The HTTP status of a failed call; 0 for no answer and for anything that is not an HTTP error. */
function statusOf(error: Error): number {
  return error instanceof HttpErrorResponse ? error.status : 0;
}
