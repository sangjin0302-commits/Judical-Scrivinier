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
    assert "var gradeIndexes = [0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 17, 18, 19, 20, 21, 22]" in SOURCE
    assert "getRange(submission.gradeStart, 1, count, 26).setValues" not in SOURCE


def test_long_answers_are_chunked_outside_single_script_property():
    assert "match(/[\\s\\S]{1,6000}/g)" in SOURCE
    assert "answers: answers" not in SOURCE
    assert "P2F_loadAnswers_" in SOURCE


def test_history_values_match_live_validation_contract():
    assert "'아니오', setRows[i][6], ev.errorType, ev.checkType" in SOURCE
    assert "ev.correction, '', ev.errorType, '2차 사례형'" not in SOURCE
    assert "P2F_allowed_(settings, 'Q5:Q17')" in SOURCE
    assert "P2F_allowed_(settings, 'R5:R18')" in SOURCE
    assert "P2F_allowed_(settings, 'P5:P9')" in SOURCE


def test_partial_recovery_preflights_conflicts_and_fills_only_blanks():
    assert "function P2F_planRow_" in SOURCE
    assert "기존 값 충돌" in SOURCE
    assert "P2F_applyRuns_(sheets[P2F.HISTORY], historyRuns)" in SOURCE
    assert "P2F_applyRuns_(sheets[P2F.GRADES], gradeRuns)" in SOURCE


def test_failure_injection_boundaries_exist():
    for stage in ("afterReservation", "afterHistory", "afterGrades", "beforeSubmitted"):
        assert f"P2F_testFail_(props, '{stage}')" in SOURCE
