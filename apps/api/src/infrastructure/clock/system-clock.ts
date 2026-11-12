import type { Clock } from '../../core/clock.js';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
