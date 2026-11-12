/**
 * Port for reading the current time. Injecting it keeps the domain deterministic
 * and lets tests freeze or advance time without touching the system clock.
 */
export abstract class Clock {
  abstract now(): Date;
}

/** Default production implementation. */
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
