\set ON_ERROR_STOP on

BEGIN;

INSERT INTO subjects(subject_id, name) VALUES ('CIVIL', '민법'), ('REGISTRATION', '부동산등기법');
INSERT INTO units(subject_id, unit_id, title) VALUES
  ('CIVIL', 'B1-P0040-0047', '신의성실·권리남용'),
  ('REGISTRATION', 'REG-TEST-001', '격리 시험');
INSERT INTO problems(subject_id, stable_key, unit_id, stage, source_order, source_ref, source_version,
                     prompt_text, max_points, published, content_digest)
VALUES
  ('CIVIL', 'TEST-CIV-P1-001', 'B1-P0040-0047', 'P1', 1, 'synthetic', 'v1', '합성 OX', NULL, true, 'p1'),
  ('CIVIL', 'TEST-CIV-P2-001', 'B1-P0040-0047', 'P2', 2, 'synthetic', 'v1', '합성 사례', 20, true, 'p2'),
  ('REGISTRATION', 'TEST-REG-P1-001', 'REG-TEST-001', 'P1', 1, 'synthetic', 'v1', '격리 확인', NULL, true, 'reg');

DO $contract$
DECLARE
  v_set text := 'TEST-P2-CONTRACT';
  v_submission uuid;
BEGIN
  INSERT INTO issue_sets(set_id, owner_id, subject_id, stage, request_id, request_digest)
    VALUES (v_set, 'user-a', 'CIVIL', 'P2', 'req-1', 'digest-1');
  INSERT INTO issue_set_items(set_id, subject_id, position, stable_key)
    VALUES (v_set, 'CIVIL', 1, 'TEST-CIV-P2-001');
  INSERT INTO submissions(set_id, owner_id, subject_id, request_id, answer_digest)
    VALUES (v_set, 'user-a', 'CIVIL', 'grade-1', 'answer-1') RETURNING submission_id INTO v_submission;
  INSERT INTO original_answers(submission_id, subject_id, stable_key, answer_text, answer_digest)
    VALUES (v_submission, 'CIVIL', 'TEST-CIV-P2-001', '원답 보존 시험', 'answer-row-1');
  INSERT INTO p2_grades(submission_id, subject_id, stable_key, awarded_points, max_points,
    issue_score, outline_score, law_score, precedent_score, application_score,
    conclusion_score, expression_score, error_type, check_type, next_review_type,
    evaluation_payload, evaluation_digest)
  VALUES (v_submission, 'CIVIL', 'TEST-CIV-P2-001', 10, 20, 1,1,1,1,1,1,1,
    '복합 오류', '해당없음', '사례형 재작성', '{"fixture":true}', 'eval-1');
  INSERT INTO sheet_outbox(aggregate_type, aggregate_id, event_type, payload, payload_digest)
    VALUES ('submission', v_submission, 'P2_GRADED', '{"fixture":true}', 'outbox-1');
  UPDATE submissions SET state='COMMITTED', grade_digest='grade-1', committed_at=now()
    WHERE submission_id=v_submission;

  BEGIN
    INSERT INTO submissions(set_id, owner_id, subject_id, request_id, answer_digest)
      VALUES (v_set, 'user-a', 'CIVIL', 'grade-2', 'different');
    RAISE EXCEPTION 'duplicate submission was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO issue_set_items(set_id, subject_id, position, stable_key)
      VALUES (v_set, 'REGISTRATION', 2, 'TEST-REG-P1-001');
    RAISE EXCEPTION 'cross-subject item was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  IF (SELECT count(*) FROM original_answers WHERE submission_id=v_submission) <> 1 THEN
    RAISE EXCEPTION 'original answer count mismatch';
  END IF;
  IF (SELECT count(*) FROM p2_grades WHERE submission_id=v_submission) <> 1 THEN
    RAISE EXCEPTION 'P2 grade count mismatch';
  END IF;
  IF (SELECT count(*) FROM sheet_outbox WHERE aggregate_id=v_submission::text AND delivered_at IS NULL) <> 1 THEN
    RAISE EXCEPTION 'outbox contract mismatch';
  END IF;

  BEGIN
    UPDATE original_answers SET answer_text='변조' WHERE submission_id=v_submission;
    RAISE EXCEPTION 'original answer mutation was accepted';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
END
$contract$;

ROLLBACK;
