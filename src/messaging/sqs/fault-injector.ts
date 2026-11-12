import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.ts';

/**
 * Test-only fault injection seam. In production this is a no-op. Integration
 * tests set CHAOS_CRASH_AFTER_COMMIT=true to simulate a worker dying after the
 * SQL commit but before the SQS ack — redelivery must then NOT duplicate effects.
 */
@Injectable()
export class FaultInjector {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Crash the process if chaos is enabled (only after a real committed effect). */
  maybeCrashAfterCommit(): void {
    if (this.config.chaosCrashAfterCommit) {
      // Hard-exit without running shutdown hooks — the message is NOT acked.
      process.exit(137);
    }
  }
}
