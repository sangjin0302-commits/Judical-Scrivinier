-- Indexes for bounded PostgreSQL-only exam issue selection. No data rewrite.
CREATE INDEX IF NOT EXISTS problems_exam_issue_p1_idx
  ON problems(subject_id,source_order,stable_key)
  WHERE stage='P1' AND published=true;

CREATE INDEX IF NOT EXISTS problems_exam_issue_p2_group_idx
  ON problems(subject_id,(regexp_replace(stable_key,'-소문항[0-9]+$','')),source_order)
  WHERE stage='P2';

CREATE INDEX IF NOT EXISTS p1_grades_incorrect_problem_idx
  ON p1_grades(subject_id,stable_key,submission_id)
  WHERE is_correct=false;

CREATE INDEX IF NOT EXISTS p2_grades_problem_history_idx
  ON p2_grades(subject_id,stable_key,submission_id)
  WHERE awarded_points<max_points;

CREATE INDEX IF NOT EXISTS issue_set_items_problem_set_idx
  ON issue_set_items(subject_id,stable_key,set_id);
