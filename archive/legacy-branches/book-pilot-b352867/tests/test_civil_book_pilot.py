import csv
import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("civil_book_pilot", ROOT / "tools" / "civil_book_pilot.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


class CivilBookPilotTest(unittest.TestCase):
    def test_bounded_excerpt_requires_contiguous_pages(self):
        text = "\n".join(f"[책 / PDF 페이지 {page}]\n내용 {page}" for page in range(40, 49))
        excerpt, pages = MODULE.bounded_excerpt(text, 40, 47)
        self.assertEqual(pages, list(range(40, 48)))
        self.assertNotIn("페이지 48", excerpt)

    def test_bounded_excerpt_strips_invisible_controls(self):
        text = "[책 / PDF 페이지 40]\n신\u200b의칙\n"
        excerpt, _ = MODULE.bounded_excerpt(text, 40, 40)
        self.assertNotIn("\u200b", excerpt)

    def test_pilot_preserves_all_mapped_issues(self):
        with (ROOT / "curriculum" / "issue-map.csv").open(encoding="utf-8-sig", newline="") as handle:
            rows = [row for row in csv.DictReader(handle) if row["unit_id"] == "B1-P0040-0047"]
        self.assertEqual([row["learning_tier"] for row in rows], ["A", "A", "A", "A", "B"])
        lesson = (ROOT / "experiments" / "book-to-skill" / "B1-P0040-0047-pilot.md").read_text(encoding="utf-8")
        required = ["해석", "보충", "강행규정", "사정변경", "위험 부담", "모순행위", "보호할 가치"]
        self.assertTrue(all(term in lesson for term in required))


if __name__ == "__main__":
    unittest.main()
