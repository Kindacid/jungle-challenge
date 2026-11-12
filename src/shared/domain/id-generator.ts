/**
 * Port for generating identifiers. We use UUIDv7 so IDs are time-ordered, which
 * keeps primary-key inserts and keyset pagination index-friendly.
 */
export abstract class IdGenerator {
  abstract next(): string;
}

/** Production implementation backed by Bun's native UUIDv7 generator. */
export class Uuidv7Generator extends IdGenerator {
  next(): string {
    // Bun.randomUUIDv7() is monotonic within the process and time-ordered.
    return Bun.randomUUIDv7();
  }
}
