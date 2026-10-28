BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM review_rules
    WHERE subject_id='CIVIL' AND rule_version='concept-recall-v1'
      AND rule_payload->'rememberedDays' = '[1,7,21,60]'::jsonb
      AND rule_payload->>'partialDays' = '3'
      AND rule_payload->>'relearnDays' = '1'
  ) THEN
    RAISE EXCEPTION 'verified concept review rule missing';
  END IF;
END $$;

UPDATE review_rules SET active=false WHERE subject_id='CIVIL' AND active=true;
UPDATE review_rules SET active=true WHERE subject_id='CIVIL' AND rule_version='concept-recall-v1';

CREATE TABLE concept_study_activities (
  activity_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  subject_id text NOT NULL,
  unit_id text NOT NULL,
  request_id text NOT NULL,
  activity_type text NOT NULL CHECK (activity_type IN ('LESSON_HEARD', 'BOOK_READ', 'IMMEDIATE_UNDERSTANDING')),
  request_digest text NOT NULL,
  evidence_source text NOT NULL DEFAULT 'USER_CONFIRMED' CHECK (evidence_source = 'USER_CONFIRMED'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, subject_id, request_id),
  FOREIGN KEY (subject_id, unit_id) REFERENCES units(subject_id, unit_id) ON DELETE RESTRICT
);

CREATE INDEX concept_study_activities_owner_unit_idx
  ON concept_study_activities(owner_id, subject_id, unit_id, created_at DESC);

CREATE TRIGGER concept_study_activities_append_only
  BEFORE UPDATE OR DELETE ON concept_study_activities
  FOR EACH ROW EXECUTE FUNCTION reject_committed_record_change();

COMMIT;
