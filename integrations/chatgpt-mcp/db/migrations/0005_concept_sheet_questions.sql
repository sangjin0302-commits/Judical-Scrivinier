BEGIN;

ALTER TABLE recall_questions DROP CONSTRAINT recall_questions_content_state_check;
ALTER TABLE recall_questions ADD CONSTRAINT recall_questions_content_state_check
  CHECK (content_state IN ('indexed-unavailable', 'template-unverified', 'source-mapped', 'verified'));

CREATE TABLE concept_question_imports (
  import_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id text NOT NULL REFERENCES subjects(subject_id),
  source_id text NOT NULL,
  source_digest text NOT NULL,
  question_count integer NOT NULL CHECK (question_count = 720),
  imported_count integer NOT NULL CHECK (imported_count BETWEEN 0 AND 720),
  preserved_mapped_count integer NOT NULL CHECK (preserved_mapped_count BETWEEN 0 AND 720),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(subject_id, source_id, source_digest)
);

CREATE TRIGGER concept_question_imports_append_only
  BEFORE UPDATE OR DELETE ON concept_question_imports
  FOR EACH ROW EXECUTE FUNCTION reject_committed_record_change();

COMMIT;
