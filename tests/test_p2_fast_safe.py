from pathlib import Path


SOURCE = (Path(__file__).parents[1] / "apps-script" / "pb1-fast-safe" / "P2FastSafe.gs").read_text(encoding="utf-8")


def test_p2_uses_test_only_spreadsheet_gate():
    assert "PB1F_ss_()" in SOURCE
    assert "openById" not in SOURCE


def test_p2_releases_rubric_only_after_answer_reservation():
    start = SOURCE.index("function P2F_prepareGrade")
    end = SOURCE.index("function P2F_evaluations_")
    body = SOURCE[start:end]
    assert body.index("setProperty(submissionKey") < body.index("sheets[P2F.JUDGE].getRange")


def test_p2_marks_submitted_only_after_record_verification():
    start = SOURCE.index("function P2F_commitGrade")
    body = SOURCE[start:]
    assert body.index("2차 평가 기록 검증 실패") < body.index("getRange(record.startRow, 6")


def test_p2_preserves_formula_columns():
    assert "getRange(submission.gradeStart, 1, count, 6).setValues" in SOURCE
    assert "getRange(submission.gradeStart, 8, count, 7)" in SOURCE
    assert "getRange(submission.gradeStart, 18, count, 6)" in SOURCE
    assert "getRange(submission.gradeStart, 1, count, 26).setValues" not in SOURCE


def test_long_answers_are_chunked_outside_single_script_property():
    assert "match(/[\\s\\S]{1,6000}/g)" in SOURCE
    assert "answers: answers" not in SOURCE
    assert "P2F_loadAnswers_" in SOURCE
