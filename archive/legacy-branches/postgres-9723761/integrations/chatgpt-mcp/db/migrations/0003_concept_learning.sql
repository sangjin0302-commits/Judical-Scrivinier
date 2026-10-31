BEGIN;

-- Concept curriculum metadata is separate from learner tier. issue_tier means
-- instructional A/B/C priority; learner_progress.learning_tier remains learner state.
ALTER TABLE units
  ADD COLUMN IF NOT EXISTS learning_order integer,
  ADD COLUMN IF NOT EXISTS learning_goal text,
  ADD COLUMN IF NOT EXISTS curriculum_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS content_state text NOT NULL DEFAULT 'unavailable';

DO $$ BEGIN
  ALTER TABLE units ADD CONSTRAINT units_content_state_check
    CHECK (content_state IN ('unavailable', 'indexed', 'available', 'verified'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS units_learning_order_idx
  ON units(subject_id, learning_order) WHERE learning_order IS NOT NULL;

CREATE TABLE concept_material_versions (
  material_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id text NOT NULL,
  unit_id text NOT NULL,
  material_type text NOT NULL CHECK (material_type IN ('LESSON_LAYER_1', 'LESSON_LAYER_2', 'LESSON_COMMON', 'RECALL_SOURCE')),
  source_path text NOT NULL,
  source_version text NOT NULL,
  content_text text NOT NULL,
  content_digest text NOT NULL,
  verification_state text NOT NULL CHECK (verification_state IN ('source-present', 'verified', 'superseded', 'rejected')),
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(subject_id, unit_id, material_type, source_version),
  FOREIGN KEY (subject_id, unit_id) REFERENCES units(subject_id, unit_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX concept_material_one_active_idx
  ON concept_material_versions(subject_id, unit_id, material_type) WHERE active;

CREATE TABLE concept_issues (
  subject_id text NOT NULL,
  unit_id text NOT NULL,
  issue_id text NOT NULL,
  issue_name text NOT NULL,
  issue_tier text NOT NULL CHECK (issue_tier IN ('A', 'B', 'C')),
  classification_basis text NOT NULL,
  p1_requirement text,
  p2_requirement text,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_digest text NOT NULL,
  PRIMARY KEY(subject_id, issue_id),
  FOREIGN KEY (subject_id, unit_id) REFERENCES units(subject_id, unit_id) ON DELETE RESTRICT
);

CREATE INDEX concept_issues_unit_idx ON concept_issues(subject_id, unit_id, issue_tier, issue_id);

CREATE TABLE recall_questions (
  subject_id text NOT NULL,
  unit_id text NOT NULL,
  question_id text NOT NULL,
  question_order smallint NOT NULL CHECK (question_order > 0),
  prompt_text text,
  source_path text,
  source_version text,
  content_state text NOT NULL CHECK (content_state IN ('indexed-unavailable', 'source-mapped', 'verified')),
  content_digest text NOT NULL,
  PRIMARY KEY(subject_id, question_id),
  UNIQUE(subject_id, unit_id, question_order),
  FOREIGN KEY (subject_id, unit_id) REFERENCES units(subject_id, unit_id) ON DELETE RESTRICT,
  CHECK ((content_state = 'indexed-unavailable' AND prompt_text IS NULL) OR
         (content_state <> 'indexed-unavailable' AND prompt_text IS NOT NULL))
);

CREATE INDEX recall_questions_unit_idx ON recall_questions(subject_id, unit_id, question_order);

CREATE TABLE concept_problem_links (
  subject_id text NOT NULL,
  unit_id text NOT NULL,
  stable_key text NOT NULL,
  link_status text NOT NULL CHECK (link_status IN ('candidate', 'verified', 'rejected')),
  source_ref text NOT NULL,
  source_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  PRIMARY KEY(subject_id, unit_id, stable_key),
  FOREIGN KEY (subject_id, unit_id) REFERENCES units(subject_id, unit_id) ON DELETE RESTRICT,
  FOREIGN KEY (subject_id, stable_key) REFERENCES problems(subject_id, stable_key) ON DELETE RESTRICT,
  CHECK ((link_status = 'verified' AND verified_at IS NOT NULL) OR link_status <> 'verified')
);

CREATE TABLE learner_study_preferences (
  owner_id text NOT NULL,
  subject_id text NOT NULL REFERENCES subjects(subject_id),
  study_mode text NOT NULL CHECK (study_mode IN ('INTEGRATED', 'CONCEPT_ONLY', 'PROBLEM_ONLY')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id, subject_id)
);

CREATE TABLE recall_attempts (
  attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  subject_id text NOT NULL,
  unit_id text NOT NULL,
  question_id text NOT NULL,
  request_id text NOT NULL,
  answer_text text NOT NULL,
  answer_digest text NOT NULL,
  memory_result text NOT NULL CHECK (memory_result IN ('REMEMBERED', 'PARTIAL', 'RELEARN')),
  remembered_count integer NOT NULL DEFAULT 0 CHECK (remembered_count >= 0),
  evidence_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  next_review_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, subject_id, request_id),
  FOREIGN KEY (subject_id, unit_id) REFERENCES units(subject_id, unit_id) ON DELETE RESTRICT,
  FOREIGN KEY (subject_id, question_id) REFERENCES recall_questions(subject_id, question_id) ON DELETE RESTRICT,
  CHECK (length(btrim(answer_text)) > 0)
);

CREATE INDEX recall_attempts_owner_due_idx
  ON recall_attempts(owner_id, subject_id, next_review_at DESC);

CREATE TRIGGER recall_attempts_append_only
  BEFORE UPDATE OR DELETE ON recall_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_committed_record_change();

COMMIT;
