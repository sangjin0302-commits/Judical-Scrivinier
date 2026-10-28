BEGIN;

CREATE TYPE document_sync_run_state AS ENUM ('DETECTED', 'APPLYING', 'APPLIED', 'FAILED');
CREATE TYPE document_sync_candidate_kind AS ENUM
  ('NEW', 'MODIFIED', 'UNCHANGED', 'DUPLICATE', 'DELETE_CANDIDATE');
CREATE TYPE document_sync_candidate_state AS ENUM
  ('PENDING', 'APPROVED', 'REJECTED', 'APPLIED');
CREATE TYPE document_sync_approval_type AS ENUM ('CONTENT', 'GRADING');

CREATE TABLE source_documents (
  document_id text PRIMARY KEY,
  subject_id text NOT NULL REFERENCES subjects(subject_id),
  source_kind text NOT NULL DEFAULT 'GOOGLE_DOCS' CHECK (source_kind = 'GOOGLE_DOCS'),
  title text NOT NULL,
  read_only boolean NOT NULL DEFAULT true CHECK (read_only),
  current_revision_id text,
  current_content_digest text,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE document_revisions (
  document_id text NOT NULL REFERENCES source_documents(document_id) ON DELETE RESTRICT,
  revision_id text NOT NULL,
  source_modified_at timestamptz,
  content_digest text NOT NULL,
  parser_version text NOT NULL,
  parsed_problem_count integer NOT NULL CHECK (parsed_problem_count >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, revision_id)
);

-- Immutable problem body snapshots. Answer/explanation bodies stay in encrypted grading storage;
-- this table stores only their digests and the grading generation expected at activation.
CREATE TABLE problem_versions (
  version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id text NOT NULL REFERENCES subjects(subject_id),
  stable_key text NOT NULL,
  source_document_id text NOT NULL,
  source_revision_id text NOT NULL,
  source_version text NOT NULL,
  stage exam_stage NOT NULL,
  unit_id text,
  source_order bigint NOT NULL,
  prompt_text text NOT NULL,
  max_points numeric(8,2),
  prompt_digest text NOT NULL,
  answer_digest text,
  explanation_digest text,
  grading_key_version text,
  selection_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_id, stable_key, source_version),
  UNIQUE (version_id, subject_id, stable_key),
  FOREIGN KEY (source_document_id, source_revision_id)
    REFERENCES document_revisions(document_id, revision_id) ON DELETE RESTRICT,
  FOREIGN KEY (subject_id, unit_id) REFERENCES units(subject_id, unit_id),
  CHECK ((stage = 'P1' AND max_points IS NULL) OR
         (stage = 'P2' AND max_points IS NOT NULL AND max_points > 0)),
  CHECK ((answer_digest IS NULL) = (grading_key_version IS NULL)),
  CHECK (explanation_digest IS NULL OR grading_key_version IS NOT NULL)
);

ALTER TABLE problems
  ADD COLUMN IF NOT EXISTS current_problem_version_id uuid REFERENCES problem_versions(version_id);

ALTER TABLE problems
  ADD CONSTRAINT problems_current_version_identity_fk
  FOREIGN KEY (current_problem_version_id, subject_id, stable_key)
  REFERENCES problem_versions(version_id, subject_id, stable_key) ON DELETE RESTRICT;

ALTER TABLE issue_set_items
  ADD COLUMN IF NOT EXISTS problem_version_id uuid REFERENCES problem_versions(version_id) ON DELETE RESTRICT;

ALTER TABLE issue_set_items
  ADD CONSTRAINT issue_set_items_version_identity_fk
  FOREIGN KEY (problem_version_id, subject_id, stable_key)
  REFERENCES problem_versions(version_id, subject_id, stable_key) ON DELETE RESTRICT;

-- Freeze the pre-Docs ledger before any mutable problem row can be advanced to a
-- Google Docs revision. Without this baseline, legacy issue sets would fall back
-- to the current problems row and their historical prompt could change.
INSERT INTO source_documents(document_id, subject_id, source_kind, title, read_only, created_at)
SELECT 'legacy-db:' || subject_id, subject_id, 'GOOGLE_DOCS',
       'Pre-Docs PostgreSQL baseline', true, now()
  FROM subjects;

INSERT INTO document_revisions(document_id, revision_id, content_digest, parser_version,
                               parsed_problem_count, metadata)
SELECT 'legacy-db:' || s.subject_id, 'baseline-0004',
       encode(digest(COALESCE(string_agg(p.stable_key || ':' || p.content_digest,
                                         '|' ORDER BY p.stable_key), ''), 'sha256'), 'hex'),
       'legacy-db-baseline-v1', count(p.stable_key)::integer,
       jsonb_build_object('source', 'pre-docs-postgresql', 'immutable', true)
  FROM subjects s
  LEFT JOIN problems p ON p.subject_id = s.subject_id
 GROUP BY s.subject_id;

UPDATE source_documents d
   SET current_revision_id = 'baseline-0004',
       current_content_digest = r.content_digest,
       last_checked_at = now()
  FROM document_revisions r
 WHERE r.document_id = d.document_id
   AND r.revision_id = 'baseline-0004'
   AND d.document_id LIKE 'legacy-db:%';

INSERT INTO problem_versions(subject_id, stable_key, source_document_id, source_revision_id,
                             source_version, stage, unit_id, source_order, prompt_text,
                             max_points, prompt_digest, selection_metadata)
SELECT p.subject_id, p.stable_key, 'legacy-db:' || p.subject_id, 'baseline-0004',
       p.source_version, p.stage, p.unit_id, p.source_order, p.prompt_text,
       p.max_points, encode(digest(p.prompt_text, 'sha256'), 'hex'), p.selection_metadata
  FROM problems p;

UPDATE problems p
   SET current_problem_version_id = v.version_id
  FROM problem_versions v
 WHERE v.subject_id = p.subject_id
   AND v.stable_key = p.stable_key
   AND v.source_version = p.source_version;

UPDATE issue_set_items i
   SET problem_version_id = p.current_problem_version_id
  FROM problems p
 WHERE p.subject_id = i.subject_id
   AND p.stable_key = i.stable_key;

ALTER TABLE issue_set_items ALTER COLUMN problem_version_id SET NOT NULL;

CREATE TABLE problem_source_map (
  subject_id text NOT NULL,
  stable_key text NOT NULL,
  document_id text NOT NULL REFERENCES source_documents(document_id) ON DELETE RESTRICT,
  source_locator text NOT NULL,
  current_version_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_id, stable_key),
  UNIQUE (document_id, source_locator),
  FOREIGN KEY (subject_id, stable_key) REFERENCES problems(subject_id, stable_key) ON DELETE RESTRICT,
  FOREIGN KEY (current_version_id, subject_id, stable_key)
    REFERENCES problem_versions(version_id, subject_id, stable_key) ON DELETE RESTRICT
);

CREATE TABLE sync_runs (
  sync_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id text NOT NULL REFERENCES source_documents(document_id) ON DELETE RESTRICT,
  revision_id text NOT NULL,
  request_id text NOT NULL,
  request_digest text NOT NULL,
  state document_sync_run_state NOT NULL DEFAULT 'DETECTED',
  detected_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  failure_code text,
  UNIQUE (document_id, request_id),
  FOREIGN KEY (document_id, revision_id)
    REFERENCES document_revisions(document_id, revision_id) ON DELETE RESTRICT
);

CREATE TABLE sync_candidates (
  candidate_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id uuid NOT NULL REFERENCES sync_runs(sync_run_id) ON DELETE RESTRICT,
  subject_id text NOT NULL REFERENCES subjects(subject_id),
  stable_key text,
  candidate_kind document_sync_candidate_kind NOT NULL,
  state document_sync_candidate_state NOT NULL DEFAULT 'PENDING',
  candidate_digest text NOT NULL,
  prompt_changed boolean NOT NULL DEFAULT false,
  answer_changed boolean NOT NULL DEFAULT false,
  explanation_changed boolean NOT NULL DEFAULT false,
  candidate_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  UNIQUE (sync_run_id, candidate_digest),
  CHECK (candidate_kind = 'DUPLICATE' OR stable_key IS NOT NULL),
  CHECK (state <> 'APPLIED' OR candidate_kind IN ('NEW', 'MODIFIED', 'UNCHANGED', 'DELETE_CANDIDATE'))
);

CREATE TABLE sync_approvals (
  approval_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES sync_candidates(candidate_id) ON DELETE RESTRICT,
  approval_type document_sync_approval_type NOT NULL,
  actor_id text NOT NULL,
  request_id text NOT NULL,
  reason text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (candidate_id, approval_type),
  UNIQUE (actor_id, request_id)
);

CREATE INDEX document_revisions_fetched_idx ON document_revisions(document_id, fetched_at DESC);
CREATE INDEX document_revisions_digest_idx ON document_revisions(document_id, content_digest);
CREATE INDEX problem_versions_lookup_idx ON problem_versions(subject_id, stable_key, created_at DESC);
CREATE INDEX sync_candidates_pending_idx ON sync_candidates(sync_run_id, candidate_kind) WHERE state = 'PENDING';

CREATE FUNCTION snapshot_issue_problem_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.problem_version_id IS NULL THEN
    SELECT current_problem_version_id INTO NEW.problem_version_id
      FROM problems
     WHERE subject_id = NEW.subject_id AND stable_key = NEW.stable_key;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER issue_set_items_snapshot_problem_version
  BEFORE INSERT ON issue_set_items
  FOR EACH ROW EXECUTE FUNCTION snapshot_issue_problem_version();

CREATE TRIGGER problem_versions_append_only
  BEFORE UPDATE OR DELETE ON problem_versions
  FOR EACH ROW EXECUTE FUNCTION reject_committed_record_change();
CREATE TRIGGER document_revisions_append_only
  BEFORE UPDATE OR DELETE ON document_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_committed_record_change();
CREATE TRIGGER sync_approvals_append_only
  BEFORE UPDATE OR DELETE ON sync_approvals
  FOR EACH ROW EXECUTE FUNCTION reject_committed_record_change();

COMMIT;
