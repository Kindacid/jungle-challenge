import { Migration } from '@mikro-orm/migrations';

/**
 * Initial schema. The business guarantees are enforced HERE, in the database —
 * uniqueness, immutability, non-negative balance and the wallet<->ledger 1:1
 * invariant — so that correctness holds under concurrency and across multiple
 * app instances, independent of application code.
 *
 * Role model: migrations run as the OWNER role. The application connects as the
 * restricted `wagering_app` role, which is granted only the privileges it needs
 * and is explicitly denied UPDATE/DELETE on the ledger (append-only).
 */
export class Migration20261112_0001_init extends Migration {
  override async up(): Promise<void> {
    // ---------------------------------------------------------------- wallets
    this.addSql(`
      CREATE TABLE wallets (
        id              uuid           NOT NULL,
        player_id       uuid           NOT NULL,
        currency        char(3)        NOT NULL,
        balance_amount  numeric(20,2)  NOT NULL,
        version         integer        NOT NULL,
        created_at      timestamptz    NOT NULL,
        updated_at      timestamptz    NOT NULL,
        CONSTRAINT wallets_pkey PRIMARY KEY (id),
        CONSTRAINT wallets_currency_chk       CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallets_balance_nonneg_chk CHECK (balance_amount >= 0),
        CONSTRAINT wallets_version_chk        CHECK (version >= 1),
        CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency),
        CONSTRAINT wallets_id_currency_uq     UNIQUE (id, currency)
      );
    `);

    // version bumps by exactly 1 iff the balance changes; identity is immutable.
    this.addSql(`
      CREATE FUNCTION wallets_guard_update() RETURNS trigger AS $$
      BEGIN
        IF NEW.player_id IS DISTINCT FROM OLD.player_id
           OR NEW.currency IS DISTINCT FROM OLD.currency
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'wallet identity columns are immutable';
        END IF;
        IF NEW.balance_amount IS DISTINCT FROM OLD.balance_amount THEN
          IF NEW.version <> OLD.version + 1 THEN
            RAISE EXCEPTION 'wallet version must increment by 1 on balance change (old=%, new=%)',
              OLD.version, NEW.version;
          END IF;
        ELSE
          IF NEW.version <> OLD.version THEN
            RAISE EXCEPTION 'wallet version must not change without a balance change';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER wallets_guard_update_trg BEFORE UPDATE ON wallets
        FOR EACH ROW EXECUTE FUNCTION wallets_guard_update();
    `);

    // --------------------------------------------------- wager_transactions
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid           NOT NULL,
        provider_id                       text           NOT NULL,
        external_transaction_id           text           NOT NULL,
        idempotency_key                   text           NOT NULL,
        payload_hash                      char(64)       NOT NULL,
        wallet_id                         uuid           NOT NULL,
        player_id                         uuid           NOT NULL,
        round_id                          text,
        game_id                           text,
        kind                              text           NOT NULL,
        amount                            numeric(20,2)  NOT NULL,
        currency                          char(3)        NOT NULL,
        reference_external_transaction_id text,
        reference_transaction_id          uuid,
        status                            text           NOT NULL,
        failure_code                      text,
        observed_balance_amount           numeric(20,2),
        reference_attempts                integer        NOT NULL DEFAULT 0,
        next_reference_attempt_at         timestamptz,
        correlation_id                    text,
        created_at                        timestamptz    NOT NULL,
        processed_at                      timestamptz,
        CONSTRAINT wt_pkey PRIMARY KEY (id),
        CONSTRAINT wt_wallet_fk  FOREIGN KEY (wallet_id) REFERENCES wallets (id),
        CONSTRAINT wt_ref_fk     FOREIGN KEY (reference_transaction_id) REFERENCES wager_transactions (id),
        CONSTRAINT wt_kind_chk     CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT wt_status_chk   CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT wt_amount_chk   CHECK (amount >= 0),
        CONSTRAINT wt_currency_chk CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wt_idem_uq         UNIQUE (idempotency_key),
        CONSTRAINT wt_provider_ext_uq UNIQUE (provider_id, external_transaction_id),
        -- failure_code is present exactly when the status is a failure terminal.
        CONSTRAINT wt_failure_code_chk CHECK ((failure_code IS NOT NULL) = (status IN ('REJECTED','FAILED'))),
        -- processed_at is present exactly when PROCESSED.
        CONSTRAINT wt_processed_at_chk CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
        -- REFUND/ROLLBACK must carry a provider reference id.
        CONSTRAINT wt_reference_required_chk
          CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        -- round/game are required for every externally submittable kind.
        CONSTRAINT wt_round_game_chk
          CHECK (kind = 'OPENING' OR (round_id IS NOT NULL AND game_id IS NOT NULL))
      );
    `);

    // At most one PROCESSED reversal per referenced transaction (no double reversal).
    this.addSql(`
      CREATE UNIQUE INDEX wt_reference_reversal_uq ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';
    `);
    // At most one OPENING per wallet.
    this.addSql(`
      CREATE UNIQUE INDEX wt_opening_uq ON wager_transactions (wallet_id) WHERE kind = 'OPENING';
    `);
    // Worker scan for due pending-reference transactions.
    this.addSql(`
      CREATE INDEX wt_pending_ref_due_idx ON wager_transactions (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
    // Nudge lookup: find dependents waiting on a (provider, external id).
    this.addSql(`
      CREATE INDEX wt_pending_ref_lookup_idx
        ON wager_transactions (provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE';
    `);

    // Terminal transactions are frozen; business columns are immutable.
    this.addSql(`
      CREATE FUNCTION wt_guard_update() RETURNS trigger AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'wager_transaction % is terminal (%) and cannot change', OLD.id, OLD.status;
        END IF;
        IF NEW.provider_id IS DISTINCT FROM OLD.provider_id
           OR NEW.external_transaction_id IS DISTINCT FROM OLD.external_transaction_id
           OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
           OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
           OR NEW.wallet_id IS DISTINCT FROM OLD.wallet_id
           OR NEW.player_id IS DISTINCT FROM OLD.player_id
           OR NEW.round_id IS DISTINCT FROM OLD.round_id
           OR NEW.game_id IS DISTINCT FROM OLD.game_id
           OR NEW.kind IS DISTINCT FROM OLD.kind
           OR NEW.amount IS DISTINCT FROM OLD.amount
           OR NEW.currency IS DISTINCT FROM OLD.currency
           OR NEW.reference_external_transaction_id IS DISTINCT FROM OLD.reference_external_transaction_id
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'wager_transaction business columns are immutable';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER wt_guard_update_trg BEFORE UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wt_guard_update();
    `);

    // ------------------------------------------------ wallet_ledger_entries
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid           NOT NULL,
        wallet_id       uuid           NOT NULL,
        currency        char(3)        NOT NULL,
        transaction_id  uuid           NOT NULL,
        direction       text           NOT NULL,
        amount          numeric(20,2)  NOT NULL,
        balance_before  numeric(20,2)  NOT NULL,
        balance_after   numeric(20,2)  NOT NULL,
        wallet_version  integer        NOT NULL,
        created_at      timestamptz    NOT NULL,
        CONSTRAINT wle_pkey PRIMARY KEY (id),
        CONSTRAINT wle_direction_chk CHECK (direction IN ('DEBIT','CREDIT')),
        CONSTRAINT wle_amount_pos_chk CHECK (amount > 0),
        CONSTRAINT wle_balances_nonneg_chk CHECK (balance_before >= 0 AND balance_after >= 0),
        -- the arithmetic of the line must hold exactly.
        CONSTRAINT wle_arith_chk CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount)
        ),
        -- at most one ledger entry per wager transaction.
        CONSTRAINT wle_tx_uq UNIQUE (transaction_id),
        -- one entry per (wallet, version): ties the ledger to the version timeline.
        CONSTRAINT wle_wallet_version_uq UNIQUE (wallet_id, wallet_version),
        -- the entry currency must match the wallet currency (composite FK).
        CONSTRAINT wle_wallet_fk FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        CONSTRAINT wle_tx_fk FOREIGN KEY (transaction_id) REFERENCES wager_transactions (id)
      );
    `);
    this.addSql(
      `CREATE INDEX wle_wallet_idx ON wallet_ledger_entries (wallet_id, wallet_version);`,
    );

    // Ledger chain: balance_before must equal the previous entry's balance_after
    // (or 0 when this is the first entry for the wallet).
    this.addSql(`
      CREATE FUNCTION wle_guard_insert() RETURNS trigger AS $$
      DECLARE prev_after numeric(20,2);
      BEGIN
        SELECT balance_after INTO prev_after
          FROM wallet_ledger_entries
          WHERE wallet_id = NEW.wallet_id AND wallet_version < NEW.wallet_version
          ORDER BY wallet_version DESC
          LIMIT 1;
        IF NEW.balance_before IS DISTINCT FROM COALESCE(prev_after, 0) THEN
          RAISE EXCEPTION 'ledger chain broken for wallet %: balance_before % <> expected %',
            NEW.wallet_id, NEW.balance_before, COALESCE(prev_after, 0);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER wle_guard_insert_trg BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION wle_guard_insert();
    `);

    // Append-only: no UPDATE/DELETE/TRUNCATE, enforced in addition to grants.
    this.addSql(`
      CREATE FUNCTION wle_append_only() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% denied)', TG_OP;
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER wle_no_mutate_trg BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION wle_append_only();
    `);
    this.addSql(`
      CREATE TRIGGER wle_no_truncate_trg BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION wle_append_only();
    `);

    // --------------------------- deferred wallet <-> ledger 1:1 invariant ---
    // Checked at COMMIT so both rows can be written within one transaction.
    this.addSql(`
      CREATE FUNCTION wallets_require_ledger() RETURNS trigger AS $$
      DECLARE cnt int;
      BEGIN
        -- A wallet opened empty (version 1, balance 0) needs no ledger entry.
        IF TG_OP = 'INSERT' AND NEW.version = 1 AND NEW.balance_amount = 0 THEN
          RETURN NEW;
        END IF;
        SELECT count(*) INTO cnt FROM wallet_ledger_entries
          WHERE wallet_id = NEW.id
            AND wallet_version = NEW.version
            AND balance_after = NEW.balance_amount;
        IF cnt <> 1 THEN
          RAISE EXCEPTION 'wallet % at version % lacks a matching ledger entry (balance %)',
            NEW.id, NEW.version, NEW.balance_amount;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_require_ledger_trg
        AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallets_require_ledger();
    `);
    this.addSql(`
      CREATE FUNCTION ledger_require_wallet_match() RETURNS trigger AS $$
      DECLARE w_version int; w_balance numeric(20,2);
      BEGIN
        SELECT version, balance_amount INTO w_version, w_balance FROM wallets WHERE id = NEW.wallet_id;
        IF w_version IS NULL THEN
          RAISE EXCEPTION 'ledger entry references missing wallet %', NEW.wallet_id;
        END IF;
        IF w_version <> NEW.wallet_version OR w_balance <> NEW.balance_after THEN
          RAISE EXCEPTION 'ledger entry (v%, after %) inconsistent with wallet (v%, balance %)',
            NEW.wallet_version, NEW.balance_after, w_version, w_balance;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER ledger_require_wallet_match_trg
        AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION ledger_require_wallet_match();
    `);

    // ---------------------------------------------------------- inbox/outbox
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name   text         NOT NULL,
        message_id      text         NOT NULL,
        payload_hash    char(64)     NOT NULL,
        received_at     timestamptz  NOT NULL,
        processed_at    timestamptz,
        transaction_id  uuid,
        CONSTRAINT inbox_pkey PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id              uuid         NOT NULL,
        sequence        bigint       GENERATED ALWAYS AS IDENTITY,
        aggregate_id    text         NOT NULL,
        event_type      text         NOT NULL,
        event_version   integer      NOT NULL,
        payload         jsonb        NOT NULL,
        correlation_id  text,
        occurred_at     timestamptz  NOT NULL,
        attempts        integer      NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        locked_until    timestamptz,
        locked_by       text,
        published_at    timestamptz,
        last_error      text,
        created_at      timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT outbox_pkey PRIMARY KEY (id)
      );
    `);
    this.addSql(`
      CREATE INDEX outbox_due_idx ON outbox_messages (next_attempt_at, sequence)
        WHERE published_at IS NULL;
    `);
    // Payload and identity are immutable; only delivery bookkeeping may change.
    this.addSql(`
      CREATE FUNCTION outbox_guard_update() RETURNS trigger AS $$
      BEGIN
        IF NEW.id IS DISTINCT FROM OLD.id
           OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
           OR NEW.event_type IS DISTINCT FROM OLD.event_type
           OR NEW.event_version IS DISTINCT FROM OLD.event_version
           OR NEW.payload IS DISTINCT FROM OLD.payload
           OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at THEN
          RAISE EXCEPTION 'outbox payload and identity are immutable';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER outbox_guard_update_trg BEFORE UPDATE ON outbox_messages
        FOR EACH ROW EXECUTE FUNCTION outbox_guard_update();
    `);

    // -------------------------------------------- restricted application role
    // The owner grants the app role exactly what it needs. The ledger gets no
    // UPDATE/DELETE: it is append-only at the privilege level too.
    this.addSql(`GRANT USAGE ON SCHEMA public TO wagering_app;`);
    this.addSql(`GRANT SELECT, INSERT, UPDATE ON wallets TO wagering_app;`);
    this.addSql(`GRANT SELECT, INSERT ON wallet_ledger_entries TO wagering_app;`);
    this.addSql(`GRANT SELECT, INSERT, UPDATE ON wager_transactions TO wagering_app;`);
    this.addSql(`GRANT SELECT, INSERT, UPDATE ON inbox_messages TO wagering_app;`);
    this.addSql(`GRANT SELECT, INSERT, UPDATE, DELETE ON outbox_messages TO wagering_app;`);
    this.addSql(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wagering_app;`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages CASCADE;`);
    this.addSql(`DROP FUNCTION IF EXISTS outbox_guard_update() CASCADE;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages CASCADE;`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries CASCADE;`);
    this.addSql(`DROP FUNCTION IF EXISTS wle_guard_insert() CASCADE;`);
    this.addSql(`DROP FUNCTION IF EXISTS wle_append_only() CASCADE;`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_require_wallet_match() CASCADE;`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions CASCADE;`);
    this.addSql(`DROP FUNCTION IF EXISTS wt_guard_update() CASCADE;`);
    this.addSql(`DROP TABLE IF EXISTS wallets CASCADE;`);
    this.addSql(`DROP FUNCTION IF EXISTS wallets_guard_update() CASCADE;`);
    this.addSql(`DROP FUNCTION IF EXISTS wallets_require_ledger() CASCADE;`);
  }
}
