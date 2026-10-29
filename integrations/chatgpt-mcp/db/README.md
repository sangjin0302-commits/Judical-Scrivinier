# PostgreSQL official exam ledger

This directory contains the existing Railway test PostgreSQL adapter for official P1/P2 exam records and guarded Google Docs question versions. Existing concept tables and learning records stay in the database; this branch does not expose concept services or delete their data. Production Google sources remain read-only.

The write boundary is one PostgreSQL transaction:

1. lock or create the idempotency-scoped set/submission;
2. preserve original answers as insert-only rows;
3. insert P1 results or all seven P2 element scores;
4. insert one Sheets outbox event;
5. mark the submission committed last;
6. commit once.

`sheet_outbox` makes Google Sheets a retriable projection. `sheet_sync_receipts` prevents the same outbox event from producing a second Sheets record. A digest conflict must stop instead of overwriting either side.

Run only against a disposable database:

```powershell
psql "$env:TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0001_learning_ledger.sql
psql "$env:TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/test/transaction_contract.sql
```

Before any production approval, prove: concurrent identical requests yield one commit, changed-payload retries fail, transaction rollback leaves zero partial rows, an outbox retry produces one receipt, a logical dump restores into a separate scratch database, and restored row counts/digests match.
