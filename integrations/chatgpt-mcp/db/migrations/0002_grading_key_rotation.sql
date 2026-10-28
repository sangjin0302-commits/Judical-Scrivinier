BEGIN;

ALTER TABLE private_grading_keys
  ADD COLUMN IF NOT EXISTS encryption_key_id text NOT NULL DEFAULT 'legacy-unknown',
  ADD COLUMN IF NOT EXISTS verification_state text NOT NULL DEFAULT 'legacy-unverified',
  ADD COLUMN IF NOT EXISTS active_for_grading boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;

ALTER TABLE private_grading_keys DROP CONSTRAINT IF EXISTS private_grading_keys_pkey;
ALTER TABLE private_grading_keys
  ADD PRIMARY KEY (subject_id, stable_key, key_version, encryption_key_id);

ALTER TABLE private_grading_keys
  ADD CONSTRAINT private_grading_keys_verification_state_check
  CHECK (verification_state IN ('legacy-unverified', 'verified', 'rejected', 'missing-source'));

CREATE UNIQUE INDEX IF NOT EXISTS private_grading_keys_one_active_idx
  ON private_grading_keys(subject_id, stable_key)
  WHERE active_for_grading;

CREATE INDEX IF NOT EXISTS private_grading_keys_key_id_idx
  ON private_grading_keys(encryption_key_id, verification_state, active_for_grading);

COMMIT;
