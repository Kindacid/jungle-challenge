import { Matches } from 'class-validator';

/** Shared money DTO: a canonical 2-decimal amount string and an ISO-4217 code. */
export class MoneyDto {
  @Matches(/^(0|[1-9]\d*)\.\d{2}$/, {
    message: 'amount must be a non-negative decimal string with exactly 2 places, e.g. "25.00"',
  })
  amount!: string;

  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO-4217 code' })
  currency!: string;
}
