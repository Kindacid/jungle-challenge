import { Global, Module } from '@nestjs/common';
import { Clock, SystemClock } from './domain/clock.ts';
import { IdGenerator, Uuidv7Generator } from './domain/id-generator.ts';

/** Global core ports: clock and id generation. */
@Global()
@Module({
  providers: [
    { provide: Clock, useClass: SystemClock },
    { provide: IdGenerator, useClass: Uuidv7Generator },
  ],
  exports: [Clock, IdGenerator],
})
export class CoreModule {}
