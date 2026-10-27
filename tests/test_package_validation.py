"""Offline mutations of disposable copies; no source spreadsheet or network access."""
from pathlib import Path
import csv
import importlib.util
import shutil
import sys
import tempfile
import unittest

PACKAGE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("package_validator_under_test", PACKAGE / "tools/validate_package.py")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
validate = MODULE.validate


class PackageValidationTests(unittest.TestCase):
    def setUp(self):
        temp_parent = PACKAGE / "_workspace"
        temp_parent.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="civil-tutor-validation-", dir=temp_parent)
        assert Path(self.temp.name).resolve().is_relative_to(temp_parent.resolve())
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "package"
        shutil.copytree(PACKAGE, self.root, ignore=shutil.ignore_patterns(".git", "__pycache__", ".pytest_cache", "_workspace", "tmp", "raw", "private"))

    def read_csv(self, relative):
        with (self.root / relative).open(encoding="utf-8-sig", newline="") as stream:
            return list(csv.DictReader(stream))

    def write_csv(self, relative, rows):
        with (self.root / relative).open("w", encoding="utf-8-sig", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)

    def assert_failure(self, text):
        result = validate(self.root)
        self.assertFalse(result.ok)
        self.assertTrue(any(text in e for e in result.errors), result.errors)

    def test_current_package_and_explicit_warnings(self):
        result = validate(self.root)
        self.assertTrue(result.ok, result.errors)
        links = self.read_csv("mapping/concept-problem-proposals.csv")
        for row in links:
            if row["official_key_rechecked"].strip() != "예":
                self.assertTrue(any(row["problem_stable_key"] in w and "unverified" in w for w in result.warnings))
        for row in links:
            if not row["unit_id"]:
                self.assertTrue(any(row["problem_stable_key"] in w and "unresolved" in w for w in result.warnings))

    def test_eleven_lessons_allowed(self):
        rows = self.read_csv("curriculum/units-index.csv")
        prepared = sum(bool(r["lesson_path"]) for r in rows)
        for row in rows:
            if prepared >= 11:
                break
            if row["lesson_path"]:
                continue
            key = row["unit_id"]
            row["lesson_path"] = f"lessons/{key}.md"
            row["recall_path"] = f"recall/{key}.md"
            (self.root / row["lesson_path"]).write_text(
                f"# {key}\nSynthetic validation fixture only. PDF {row['dangi_pdf_start']}\n"
                f"Review 2026-10-28. Source: {row['dangi_pdf_url']}\n", encoding="utf-8")
            (self.root / row["recall_path"]).write_text(f"# {key}\nSynthetic question fixture only.\n", encoding="utf-8")
            prepared += 1
        self.write_csv("curriculum/units-index.csv", rows)
        result = validate(self.root)
        self.assertTrue(result.ok, result.errors)
        self.assertGreaterEqual(len(list((self.root / "lessons").glob("*.md"))), 11)

    def test_new_mapping_allowed_but_unverified_warned(self):
        rows = self.read_csv("mapping/concept-problem-proposals.csv")
        new = dict(rows[0], problem_stable_key="SRC-CIV-TEST|NEW-1", unit_id="B1-P0008-0011")
        rows.append(new)
        self.write_csv("mapping/concept-problem-proposals.csv", rows)
        result = validate(self.root)
        self.assertTrue(result.ok, result.errors)
        self.assertTrue(any("SRC-CIV-TEST|NEW-1" in w for w in result.warnings))

    def test_legacy_blank_may_be_resolved(self):
        rows = self.read_csv("mapping/concept-problem-proposals.csv")
        for row in rows:
            if not row["unit_id"]:
                row["unit_id"] = "B1-P0008-0011"
        self.write_csv("mapping/concept-problem-proposals.csv", rows)
        result = validate(self.root)
        self.assertTrue(result.ok, result.errors)
        self.assertFalse(any("unresolved" in w for w in result.warnings))

    def test_new_blank_is_error(self):
        rows = self.read_csv("mapping/concept-problem-proposals.csv")
        rows.append(dict(rows[0], problem_stable_key="SRC-CIV-TEST|NEW-BLANK", unit_id=""))
        self.write_csv("mapping/concept-problem-proposals.csv", rows)
        self.assert_failure("new unresolved mapping unit: SRC-CIV-TEST|NEW-BLANK")

    def test_unit_identity_change_rejected_even_with_valid_format(self):
        rows = self.read_csv("curriculum/units-index.csv")
        rows[0]["unit_id"] = "B1-P0001-0007"
        rows[0]["dangi_pdf_start"], rows[0]["dangi_pdf_end"] = "1", "7"
        self.write_csv("curriculum/units-index.csv", rows)
        self.assert_failure("unit IDs unchanged from baseline")

    def test_original_key_change_rejected(self):
        rows = self.read_csv("mapping/concept-problem-proposals.csv")
        old = rows[0]["problem_stable_key"]
        for row in rows:
            if row["problem_stable_key"] == old:
                row["problem_stable_key"] = "SRC-CIV-TEST|REPLACED"
        self.write_csv("mapping/concept-problem-proposals.csv", rows)
        self.assert_failure("original official key missing or changed: " + old)

    def test_original_key_deletion_rejected(self):
        rows = self.read_csv("mapping/concept-problem-proposals.csv")
        old = rows[0]["problem_stable_key"]
        self.write_csv("mapping/concept-problem-proposals.csv", [r for r in rows if r["problem_stable_key"] != old])
        self.assert_failure("original official key missing or changed: " + old)

    def test_broken_lesson_path_rejected(self):
        rows = self.read_csv("curriculum/units-index.csv")
        rows[0]["lesson_path"] = "lessons/missing.md"
        self.write_csv("curriculum/units-index.csv", rows)
        self.assert_failure("indexed file path")

    def test_missing_recall_file_rejected(self):
        rows = self.read_csv("curriculum/units-index.csv")
        (self.root / rows[0]["recall_path"]).unlink()
        self.assert_failure("paired lesson/recall files")

    def test_invalid_source_url_rejected(self):
        rows = self.read_csv("curriculum/units-index.csv")
        rows[0]["dangi_pdf_url"] = "javascript:alert(1)"
        self.write_csv("curriculum/units-index.csv", rows)
        self.assert_failure("source URL metadata")

    def test_source_id_url_mismatch_rejected(self):
        rows = self.read_csv("sources/source-index.csv")
        rows[0]["url"] = "https://drive.google.com/file/d/DIFFERENT-ID/view"
        self.write_csv("sources/source-index.csv", rows)
        self.assert_failure("source URL identity")

    def test_required_document_still_required(self):
        (self.root / "docs/sheet-audit.md").unlink()
        self.assert_failure("required file: docs/sheet-audit.md")

    def test_impossible_review_date_rejected(self):
        path = next((self.root / "lessons").glob("*.md"))
        path.write_text(path.read_text(encoding="utf-8") + "\nReview: 2026-99-99\n", encoding="utf-8")
        self.assert_failure("source and review date")

    def test_rechecked_flag_does_not_hide_pending_source(self):
        rows = self.read_csv("mapping/concept-problem-proposals.csv")
        rows[0]["official_key_rechecked"] = "예"
        key = rows[0]["problem_stable_key"]
        for status in ("PDF 대조 대기", "PDF 미대조", "부분확인", "확인불가", "모르는값", ""):
            with self.subTest(status=status):
                rows[0]["source_verification"] = status
                self.write_csv("mapping/concept-problem-proposals.csv", rows)
                result = validate(self.root)
                self.assertTrue(result.ok, result.errors)
                self.assertTrue(any(key in w and "source verification incomplete" in w for w in result.warnings))

    def test_explicit_source_completion_states(self):
        rows = self.read_csv("mapping/concept-problem-proposals.csv")
        key = rows[0]["problem_stable_key"]
        for status in ("검증완료", "원문대조완료"):
            with self.subTest(status=status):
                rows[0]["source_verification"] = status
                self.write_csv("mapping/concept-problem-proposals.csv", rows)
                result = validate(self.root)
                self.assertTrue(result.ok, result.errors)
                self.assertFalse(any(key in w and "source verification incomplete" in w for w in result.warnings))


if __name__ == "__main__":
    unittest.main()
