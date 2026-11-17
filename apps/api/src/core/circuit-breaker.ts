/**
 * Opens for `openMs` after `threshold` failures in a row; a success resets the count. After the
 * window calls go through again and a single failure opens it anew (the count is still at the
 * threshold). Time is passed in, so the breaker needs no clock.
 * shortcut: no single probe call in the half-open state, every call after the window goes through;
 * add one when the protected call is costly.
 */
export class CircuitBreaker {
  private failures = 0;
  private openUntilMs = 0;

  constructor(
    private readonly threshold: number,
    private readonly openMs: number
  ) {}

  isOpen(nowMs: number): boolean {
    return nowMs < this.openUntilMs;
  }

  success(): void {
    this.failures = 0;
  }

  /** True when this failure opened the breaker. */
  failure(nowMs: number): boolean {
    this.failures += 1;
    if (this.failures < this.threshold) return false;
    this.openUntilMs = nowMs + this.openMs;
    return true;
  }
}
