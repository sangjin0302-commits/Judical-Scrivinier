-- Explicit exam-question review dates; no concept schedule or old history rewrite.
CREATE TABLE IF NOT EXISTS exam_review_due (
  owner_id text NOT NULL,
  subject_id text NOT NULL,
  stable_key text NOT NULL,
  due_at timestamptz NOT NULL,
  review_step smallint NOT NULL DEFAULT 0 CHECK(review_step BETWEEN 0 AND 2),
  last_submission_id uuid REFERENCES submissions(submission_id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,subject_id,stable_key),
  FOREIGN KEY(subject_id,stable_key) REFERENCES problems(subject_id,stable_key) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS exam_review_due_owner_time_idx
  ON exam_review_due(owner_id,subject_id,due_at,stable_key);
