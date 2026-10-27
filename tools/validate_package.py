"""Read-only checks for the learning package. Never contacts or writes Sheets."""
from pathlib import Path
import csv
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
errors = []
checks = []


def check(condition, label):
    (checks if condition else errors).append(label)


def rows(path):
    with (ROOT / path).open(encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


units = rows("curriculum/units-index.csv")
ids = {row["unit_id"] for row in units}
check(len(units) == 240 and len(ids) == 240, "240 unique existing unit IDs")
check(sum(row["volume"] == "1권" for row in units) == 96, "volume 1: 96 units")
check(sum(row["volume"] == "2권" for row in units) == 144, "volume 2: 144 units")
for row in units:
    key = row["unit_id"]
    match = re.fullmatch(r"B([12])-P(\d{4})-(\d{4})", key)
    check(bool(match), f"unit format: {key}")
    if match:
        check(int(match[2]) == int(row["dangi_pdf_start"]) and
              int(match[3]) == int(row["dangi_pdf_end"]), f"source pages: {key}")
    prev = row.get("suggested_previous_unit", "")
    check(not prev or prev in ids, f"known suggested predecessor: {key}")

lessons = list((ROOT / "lessons").glob("*.md"))
recalls = list((ROOT / "recall").glob("*.md"))
check(5 <= len(lessons) <= 10, "5–10 pilot lessons")
check({p.stem for p in lessons} == {p.stem for p in recalls}, "paired lesson/recall files")
for path in lessons + recalls:
    check(path.stem in ids, f"existing unit for {path.name}")
    text = path.read_text(encoding="utf-8-sig")
    check(path.stem in text, f"unit ID in {path.name}")
    if path.parent.name == "lessons":
        check("PDF" in text and "2026-10-27" in text, f"source and review date: {path.name}")
    else:
        # Answer-free content still needs human review; this catches answer sections.
        check(not re.search(r"^#{1,6}\s*(정답|모범답안|해설|교정 근거)\s*$", text, re.M),
              f"no answer section: {path.name}")

links = rows("mapping/concept-problem-proposals.csv")
check(len(links) == 21, "21 existing link proposals, not full coverage")
check(all(not row["unit_id"] or row["unit_id"] in ids for row in links), "known mapping unit foreign keys")
check(sum(not row["unit_id"] for row in links) == 1, "one original unresolved mapping preserved")
check(len({(row["unit_id"], row["problem_stable_key"]) for row in links}) == len(links),
      "mapping pairs unique")

required = ["README.md", "START.md", "MANIFEST.md", "PROJECT_INSTRUCTIONS.md", "AGENTS.md",
            "rules/common.md", "rules/p1-ox.md", "rules/p2-case.md", "rules/concept-recall.md",
            "rules/curriculum.md", "rules/data-safety.md", "rules/speed.md", "rules/source-update.md",
            "docs/sheet-audit.md", "docs/slimming-plan.md", "docs/performance-baseline.md",
            "docs/data-architecture.md", "docs/concept-problem-link.md", "docs/update-workflow.md",
            "docs/migration-safety.md", "docs/source-audit.md", "docs/sheet-schema.md",
            "docs/bridge-alignment.md", "docs/sync-design.md", "docs/speed-baseline.md",
            "docs/pilot-report.md", "docs/study-scenario.md", "docs/delivery-report.md",
            "sources/source-index.csv", "sources/textbook-mapping.csv", "curriculum/learning-path.md"]
for item in required:
    check((ROOT / item).is_file(), f"required file: {item}")

excluded = {".git", "_workspace", "tmp", "private", "raw", "__pycache__"}
for path in ROOT.rglob("*"):
    rel = path.relative_to(ROOT)
    if not path.is_file() or any(part in excluded for part in rel.parts):
        continue
    check(path.suffix.lower() not in {".pdf", ".xlsx", ".xls", ".zip"}, f"no raw binary: {rel}")
    if path.suffix == ".md":
        text = path.read_text(encoding="utf-8-sig")
        for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", text):
            if "://" in target or target.startswith("#") or "<" in target:
                continue
            target = target.split("#", 1)[0]
            check(not target or (path.parent / target).exists(), f"local link: {rel} -> {target}")

print(f"PASS: {len(checks)}; FAIL: {len(errors)}")
for error in errors:
    print("FAIL:", error)
print("Scope: package integrity only; not legal accuracy, Sheets recalculation, or live record testing.")
sys.exit(bool(errors))
