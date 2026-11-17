/**
 * Opens for `openMs` after `threshold` failures in a row. Once the open window elapses, a single
 * probe call is allowed through (half-open) while concurrent callers keep failing fast until that
 * probe resolves: a success closes the breaker and resets the failure count, a failure opens it for
 * another `openMs`. Time is passed in, so the breaker needs no clock.
 */
export class CircuitBreaker {
  private failures = 0;
  private openUntilMs = 0;

  constructor(
    private readonly threshold: number,
    private readonly openMs: number
  ) {}

  /** True when a call may proceed; admits at most one probe call after the open window expires. */
  allow(nowMs: number): boolean {
    if (nowMs < this.openUntilMs) return false;
    if (this.openUntilMs > 0) this.openUntilMs = Infinity;
    return true;
  }

  success(): void {
    this.failures = 0;
    this.openUntilMs = 0;
  }

  /** True when this failure opened the breaker. */
  failure(nowMs: number): boolean {
    this.failures += 1;
    if (this.failures < this.threshold) return false;
    this.openUntilMs = nowMs + this.openMs;
    return true;
  }
}
