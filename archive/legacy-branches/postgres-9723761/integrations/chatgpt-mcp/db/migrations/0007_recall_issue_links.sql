CREATE TABLE IF NOT EXISTS recall_question_issue_links (
  subject_id text NOT NULL,
  question_id text NOT NULL,
  issue_id text NOT NULL,
  verification_state text NOT NULL CHECK (verification_state = 'source-mapped'),
  source_path text NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_id, question_id, issue_id),
  FOREIGN KEY (subject_id, question_id) REFERENCES recall_questions(subject_id, question_id) ON DELETE RESTRICT,
  FOREIGN KEY (subject_id, issue_id) REFERENCES concept_issues(subject_id, issue_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS recall_question_issue_links_issue_idx
  ON recall_question_issue_links(subject_id, issue_id, question_id);
