"""Synthetic-only safety checks. Never connects to Sheets or a key store."""
import unittest

PROTECTED = {"OX정답키": {"H"}, "풀이이력": {"M", "N", "O", "P", "Q"},
             "서술형채점": {"G", "O", "P", "Q"}}

def select_top(status, candidates, count):
    if status != "정상":
        raise ValueError("bridge_not_ready")
    if count < 1 or len(candidates) < count or len(set(candidates)) != len(candidates):
        raise ValueError("invalid_candidates")
    return candidates[:count]

def grading_gate(expected_count, answers):
    if len(answers) != expected_count or any(a not in ("O", "X") for a in answers):
        raise ValueError("invalid_submission")
    return True

def validate_write(sheet, columns):
    if set(columns) & PROTECTED.get(sheet, set()):
        raise ValueError("protected_formula")

class ContractChecks(unittest.TestCase):
    def test_candidate_order(self):
        self.assertEqual(select_top("정상", ["K3", "K1", "K2"], 2), ["K3", "K1"])
    def test_status(self):
        with self.assertRaises(ValueError):
            select_top("확인필요", ["K1"], 1)
    def test_short_candidates(self):
        with self.assertRaises(ValueError):
            select_top("정상", ["K1"], 2)
    def test_duplicate_keys(self):
        with self.assertRaises(ValueError):
            select_top("정상", ["K1", "K1"], 1)
    def test_no_answer(self):
        with self.assertRaises(ValueError):
            grading_gate(2, [])
    def test_bad_answer(self):
        with self.assertRaises(ValueError):
            grading_gate(2, ["O", "?"])
    def test_valid_answers(self):
        self.assertTrue(grading_gate(2, ["O", "X"]))
    def test_protected_columns(self):
        for sheet, cols in PROTECTED.items():
            for col in cols:
                with self.assertRaises(ValueError):
                    validate_write(sheet, [col])
    def test_allowed_columns(self):
        validate_write("풀이이력", ["A", "B", "L"])

if __name__ == "__main__":
    unittest.main()
