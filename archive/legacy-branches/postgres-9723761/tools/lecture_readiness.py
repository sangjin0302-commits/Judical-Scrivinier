"""Read-only coverage gate for expanding the civil-law concept lectures.

Structural checks never certify legal accuracy. A unit is ready for publication only
after its source and legal-review fields have been verified separately.
"""

import argparse
import csv
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REQUIRED_HEADINGS = (
    "## 1층:",
    "### 짧은 완결 사례",
    "### 확인 질문과 진행",
    "## 2층:",
    "### 근거를 확인할 때",
)


def read_rows(path):
    with path.open(encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


def audit(root=ROOT):
    units = read_rows(root / "curriculum/units-index.csv")
    issues = read_rows(root / "curriculum/issue-map.csv")
    by_unit = {}
    for issue in issues:
        by_unit.setdefault(issue["unit_id"], []).append(issue)

    result = {"unitCount": len(units), "structuralReady": 0,
              "humanLegalReviewComplete": 0, "needsLesson": [],
              "needsIssueClassification": [], "needsSourceVerification": [],
              "structuralErrors": {}}
    for unit in units:
        unit_id = unit["unit_id"]
        classified = [issue for issue in by_unit.get(unit_id, [])
                      if issue.get("learning_tier") in {"A", "B", "C"}]
        if not classified:
            result["needsIssueClassification"].append(unit_id)
        if "원본 PDF 대조 전" in unit.get("source_status", "") or not unit.get("dangi_pdf_url"):
            result["needsSourceVerification"].append(unit_id)
        lesson_path = unit["lesson_path"]
        if not lesson_path:
            result["needsLesson"].append(unit_id)
            continue
        path = root / lesson_path
        if not path.is_file():
            result["structuralErrors"][unit_id] = ["indexed lesson missing"]
            continue
        content = path.read_text(encoding="utf-8-sig")
        errors = [heading for heading in REQUIRED_HEADINGS if heading not in content]
        if "### 최소 구조와 필수 법리" not in content and "1." not in content:
            errors.append("core-law structure missing")
        if "### 공식 문제 적용으로 넘어갈 때" not in content and "### 공식 문제를 적용할 때" not in content:
            errors.append("official problem bridge missing")
        if unit_id not in content:
            errors.append("unit ID missing")
        if errors:
            result["structuralErrors"][unit_id] = errors
        else:
            result["structuralReady"] += 1
        # A complete legal review requires an explicit separate attestation.
        # Existing free-form lesson_status cannot be promoted automatically.
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--require-complete", action="store_true")
    parser.add_argument("--details", action="store_true")
    args = parser.parse_args()
    result = audit()
    display = result if args.details else {
        key: len(value) if isinstance(value, (list, dict)) else value
        for key, value in result.items()
    }
    print(json.dumps(display, ensure_ascii=False, separators=(",", ":")))
    if args.require_complete and (result["needsLesson"] or result["structuralErrors"]
                                  or result["needsIssueClassification"]
                                  or result["needsSourceVerification"]
                                  or result["humanLegalReviewComplete"] != result["unitCount"]):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
