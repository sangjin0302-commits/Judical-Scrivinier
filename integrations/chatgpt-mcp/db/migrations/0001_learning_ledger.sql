BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE exam_stage AS ENUM ('P1', 'P2');
CREATE TYPE record_state AS ENUM ('PREPARED', 'COMMITTED', 'FAILED');

CREATE TABLE subjects (
  subject_id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE units (
  subject_id text NOT NULL REFERENCES subjects(subject_id),
  unit_id text NOT NULL,
  title text NOT NULL,
  PRIMARY KEY (subject_id, unit_id)
);

CREATE TABLE problems (
  subject_id text NOT NULL REFERENCES subjects(subject_id),
  stable_key text NOT NULL,
  unit_id text,
  stage exam_stage NOT NULL,
  source_order bigint NOT NULL,
  source_ref text NOT NULL,
  prompt_text text NOT NULL,
  max_points numeric(8,2),
  published boolean NOT NULL DEFAULT false,
  content_digest text NOT NULL,
  PRIMARY KEY (subject_id, stable_key),
  UNIQUE (subject_id, source_order),
  FOREIGN KEY (subject_id, unit_id) REFERENCES units(subject_id, unit_id),
  CHECK ((stage = 'P1' AND max_points IS NULL) OR
         (stage = 'P2' AND max_points IS NOT NULL AND max_points > 0))
);

-- 채점키는 문제 본문과 분리한다. API 역할은 답안 확정 전 이 테이블을 읽을 수 없다.
CREATE TABLE private_grading_keys (
  subject_id text NOT NULL,
  stable_key text NOT NULL,
  key_version text NOT NULL,
  encrypted_payload bytea NOT NULL,
  payload_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_id, stable_key, key_version),
  FOREIGN KEY (subject_id, stable_key) REFERENCES problems(subject_id, stable_key)
);

CREATE TABLE issue_sets (
  set_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  subject_id text NOT NULL REFERENCES subjects(subject_id),
  stage exam_stage NOT NULL,
  request_id text NOT NULL,
  request_digest text NOT NULL,
  state record_state NOT NULL DEFAULT 'PREPARED',
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  UNIQUE (owner_id, subject_id, stage, request_id),
  UNIQUE (set_id, subject_id)
);

CREATE TABLE issue_set_items (
  set_id uuid NOT NULL,
  subject_id text NOT NULL,
  position integer NOT NULL CHECK (position > 0),
  stable_key text NOT NULL,
  PRIMARY KEY (set_id, position),
  UNIQUE (set_id, stable_key),
  FOREIGN KEY (set_id, subject_id) REFERENCES issue_sets(set_id, subject_id) ON DELETE RESTRICT,
  FOREIGN KEY (subject_id, stable_key) REFERENCES problems(subject_id, stable_key)
);

CREATE TABLE submissions (
  submission_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id uuid NOT NULL REFERENCES issue_sets(set_id) ON DELETE RESTRICT,
  owner_id text NOT NULL,
  subject_id text NOT NULL REFERENCES subjects(subject_id),
  request_id text NOT NULL,
  answer_digest text NOT NULL,
  grade_digest text,
  state record_state NOT NULL DEFAULT 'PREPARED',
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  UNIQUE (owner_id, set_id, request_id),
  UNIQUE (set_id),
  UNIQUE (submission_id, subject_id),
  FOREIGN KEY (set_id, subject_id) REFERENCES issue_sets(set_id, subject_id) ON DELETE RESTRICT
);

-- 원답은 갱신하지 않는다. 정정은 별도 제출/학습 이벤트로만 남긴다.
CREATE TABLE original_answers (
  submission_id uuid NOT NULL,
  subject_id text NOT NULL,
  stable_key text NOT NULL,
  answer_text text NOT NULL,
  answer_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (submission_id, stable_key),
  FOREIGN KEY (submission_id, subject_id) REFERENCES submissions(submission_id, subject_id) ON DELETE RESTRICT,
  FOREIGN KEY (subject_id, stable_key) REFERENCES problems(subject_id, stable_key)
);

CREATE TABLE p1_grades (
  submission_id uuid NOT NULL,
  subject_id text NOT NULL,
  stable_key text NOT NULL,
  is_correct boolean NOT NULL,
  key_version text NOT NULL,
  PRIMARY KEY (submission_id, stable_key),
  FOREIGN KEY (submission_id, subject_id) REFERENCES submissions(submission_id, subject_id) ON DELETE RESTRICT,
  FOREIGN KEY (subject_id, stable_key) REFERENCES problems(subject_id, stable_key)
);

CREATE TABLE p2_grades (
  submission_id uuid NOT NULL,
  subject_id text NOT NULL,
  stable_key text NOT NULL,
  awarded_points numeric(8,2) NOT NULL,
  max_points numeric(8,2) NOT NULL,
  issue_score smallint NOT NULL CHECK (issue_score BETWEEN 0 AND 2),
  outline_score smallint NOT NULL CHECK (outline_score BETWEEN 0 AND 2),
  law_score smallint NOT NULL CHECK (law_score BETWEEN 0 AND 2),
  precedent_score smallint NOT NULL CHECK (precedent_score BETWEEN 0 AND 2),
  application_score smallint NOT NULL CHECK (application_score BETWEEN 0 AND 2),
  conclusion_score smallint NOT NULL CHECK (conclusion_score BETWEEN 0 AND 2),
  expression_score smallint NOT NULL CHECK (expression_score BETWEEN 0 AND 2),
  error_type text NOT NULL,
  check_type text NOT NULL,
  next_review_type text NOT NULL,
  evaluation_payload jsonb NOT NULL,
  evaluation_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (submission_id, stable_key),
  FOREIGN KEY (submission_id, subject_id) REFERENCES submissions(submission_id, subject_id) ON DELETE RESTRICT,
  FOREIGN KEY (subject_id, stable_key) REFERENCES problems(subject_id, stable_key),
  CHECK (max_points > 0 AND awarded_points >= 0 AND awarded_points <= max_points)
);

CREATE TABLE learning_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  subject_id text NOT NULL REFERENCES subjects(subject_id),
  unit_id text,
  stable_key text,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (subject_id, unit_id) REFERENCES units(subject_id, unit_id),
  FOREIGN KEY (subject_id, stable_key) REFERENCES problems(subject_id, stable_key)
);

-- DB 커밋과 Sheets 반영 사이의 유실을 막는 transactional outbox.
CREATE TABLE sheet_outbox (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  payload_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  UNIQUE (aggregate_type, aggregate_id, event_type, payload_digest)
);

CREATE TABLE sheet_sync_receipts (
  event_id uuid PRIMARY KEY REFERENCES sheet_outbox(event_id) ON DELETE RESTRICT,
  spreadsheet_id text NOT NULL,
  sheet_name text NOT NULL,
  external_record_key text NOT NULL,
  external_digest text NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (spreadsheet_id, sheet_name, external_record_key)
);

CREATE INDEX sheet_outbox_pending_idx ON sheet_outbox (created_at) WHERE delivered_at IS NULL;
CREATE INDEX original_answers_problem_idx ON original_answers (subject_id, stable_key);
CREATE INDEX learning_events_owner_idx ON learning_events (owner_id, subject_id, created_at DESC);

CREATE FUNCTION reject_committed_record_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER original_answers_append_only
  BEFORE UPDATE OR DELETE ON original_answers
  FOR EACH ROW EXECUTE FUNCTION reject_committed_record_change();
CREATE TRIGGER p1_grades_append_only
  BEFORE UPDATE OR DELETE ON p1_grades
  FOR EACH ROW EXECUTE FUNCTION reject_committed_record_change();
CREATE TRIGGER p2_grades_append_only
  BEFORE UPDATE OR DELETE ON p2_grades
  FOR EACH ROW EXECUTE FUNCTION reject_committed_record_change();

COMMIT;
