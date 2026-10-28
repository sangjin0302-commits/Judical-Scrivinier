"""Offline learning-package integrity checks; never contacts Sheets or grading keys."""
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from urllib.parse import unquote, urlparse
import argparse
import csv
import json
import re

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = ["README.md", "START.md", "MANIFEST.md", "PROJECT_INSTRUCTIONS.md", "AGENTS.md",
 "rules/common.md", "rules/p1-ox.md", "rules/p2-case.md", "rules/concept-recall.md",
 "rules/curriculum.md", "rules/data-safety.md", "rules/speed.md", "rules/source-update.md",
 "docs/sheet-audit.md", "docs/slimming-plan.md", "docs/performance-baseline.md",
 "docs/data-architecture.md", "docs/concept-problem-link.md", "docs/update-workflow.md",
 "docs/migration-safety.md", "docs/source-audit.md", "docs/sheet-schema.md",
 "docs/bridge-alignment.md", "docs/sync-design.md", "docs/speed-baseline.md",
 "docs/pilot-report.md", "docs/study-scenario.md", "docs/delivery-report.md",
 "sources/source-index.csv", "sources/textbook-mapping.csv", "curriculum/learning-path.md",
 "tools/identity-baseline.json", "rules/teaching-method.md",
 "docs/teaching-demo.md", "docs/teaching-redesign.md",
 "rules/compression-curriculum.md", "rules/mastery-gate.md", "curriculum/issue-map.csv",
 "docs/exam-demand-evidence.md", "docs/compression-pilot-plan.md", "docs/compression-report.md"]
REQUIRED += ["docs/pb1-fast-safe-design.md", "docs/pb1-benchmark-protocol.md",
             "apps-script/pb1-fast-safe/PB1FastSafe.gs",
             "apps-script/pb1-fast-safe/PB1FastSafeUI.html",
             "apps-script/pb1-fast-safe/README.md"]

@dataclass
class ValidationResult:
    checks: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self):
        return not self.errors

    def check(self, condition, label):
        (self.checks if condition else self.errors).append(label)

def valid_https_url(value):
    """Syntax only; does not establish remote existence or access."""
    try:
        p = urlparse(value)
        return (p.scheme == "https" and bool(p.hostname) and not p.username and
                not p.password and not any(c.isspace() for c in value) and bool(p.path.strip("/")))
    except ValueError:
        return False

def google_source_id(value):
    if not valid_https_url(value):
        return None
    p = urlparse(value)
    patterns = {"drive.google.com": r"/(?:file/d|drive/folders)/([A-Za-z0-9_-]+)(?:/|$)",
                "docs.google.com": r"/(?:document|spreadsheets|presentation)/d/([A-Za-z0-9_-]+)(?:/|$)"}
    match = re.match(patterns.get(p.hostname, r"(?!)"), p.path)
    return match[1] if match else None

def validate(root=ROOT):
    root = Path(root).resolve()
    result = ValidationResult()
    check = result.check

    def rows(relative):
        try:
            with (root / relative).open(encoding="utf-8-sig", newline="") as stream:
                return list(csv.DictReader(stream))
        except (OSError, UnicodeError, csv.Error) as exc:
            result.errors.append(f"read CSV: {relative}: {exc}")
            return []

    def safe_file(relative):
        if not relative or "\\" in relative or Path(relative).is_absolute():
            return False
        target = (root / relative).resolve()
        return target.is_relative_to(root) and target.is_file()

    try:
        baseline = json.loads((root / "tools/identity-baseline.json").read_text(encoding="utf-8"))
        old_units = {r["unit_id"]: r for r in baseline["units"]}
        old_keys = set(baseline["official_problem_keys"])
        old_unresolved = set(baseline["unresolved_problem_keys"])
        check(len(baseline["units"]) == len(old_units) == 240, "baseline has 240 source identities")
        check(bool(re.fullmatch(r"[0-9a-f]{40}", baseline["source_commit"])), "baseline source commit")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        result.errors.append(f"read identity baseline: {exc}")
        return result
    units = rows("curriculum/units-index.csv")
    ids = {r.get("unit_id", "") for r in units}
    check(len(units) == len(ids), "unit IDs unique")
    check(ids == set(old_units), "unit IDs unchanged from baseline")
    for row in units:
        key = row.get("unit_id", "")
        match = re.fullmatch(r"B([12])-P(\d{4})-(\d{4})", key)
        check(bool(match), f"unit format: {key}")
        if key in old_units:
            check(all(row.get(k) == old_units[key][k] for k in ("volume", "dangi_pdf_start", "dangi_pdf_end")), f"original volume and page range: {key}")
        if match:
            try:
                check(int(match[2]) == int(row["dangi_pdf_start"]) and int(match[3]) == int(row["dangi_pdf_end"]), f"source pages: {key}")
            except (ValueError, KeyError):
                result.errors.append(f"numeric source pages: {key}")
        prev = row.get("suggested_previous_unit", "")
        check(not prev or prev in ids, f"known suggested predecessor: {key}")
        for col in ("dangi_markdown_url", "dangi_pdf_url"):
            check(bool(google_source_id(row.get(col, ""))), f"source URL metadata: {key}:{col}")
        for kind, col in (("lessons", "lesson_path"), ("recall", "recall_path")):
            val = row.get(col, "")
            if val:
                check(val == f"{kind}/{key}.md" and safe_file(val), f"indexed file path: {key}:{col}")
        check(bool(row.get("lesson_path")) == bool(row.get("recall_path")), f"paired index paths: {key}")
    lessons = list((root / "lessons").glob("*.md"))
    recalls = list((root / "recall").glob("*.md"))
    check(bool(lessons), "prepared lessons present; expansion allowed")
    check({p.stem for p in lessons} == {p.stem for p in recalls}, "paired lesson/recall files")
    by_id = {r.get("unit_id"): r for r in units}
    for path in lessons + recalls:
        key = path.stem
        check(key in ids, f"existing unit for {path.name}")
        col = "lesson_path" if path.parent.name == "lessons" else "recall_path"
        check(by_id.get(key, {}).get(col) == path.relative_to(root).as_posix(), f"file indexed: {path.relative_to(root)}")
        text = path.read_text(encoding="utf-8-sig")
        check(key in text, f"unit ID in {path.relative_to(root)}")
        if path.parent.name == "lessons":
            dates = re.findall(r"\b20\d{2}-\d{2}-\d{2}\b", text)
            valid_dates = bool(dates)
            for value in dates:
                try:
                    date.fromisoformat(value)
                except ValueError:
                    valid_dates = False
            check("PDF" in text and valid_dates, f"source and review date: {path.name}")
            check(any(valid_https_url(u) for u in re.findall(r"https://[^\s)>]+", text)), f"lesson source URL: {path.name}")
        else:
            check(not re.search(r"^#{1,6}\s*(정답|모범답안|해설|교정 근거)\s*$", text, re.M), f"no answer section: {path.name}")
    links = rows("mapping/concept-problem-proposals.csv")
    current_keys = {r.get("problem_stable_key", "") for r in links}
    for key in sorted(old_keys - current_keys):
        result.errors.append(f"original official key missing or changed: {key}")
    check(len({(r.get("unit_id"), r.get("problem_stable_key")) for r in links}) == len(links), "mapping pairs unique")
    for row in links:
        key, unit = row.get("problem_stable_key", ""), row.get("unit_id", "")
        check(bool(re.fullmatch(r"SRC-[A-Za-z0-9_-]+\|[^\s|]+", key)), f"official key format: {key}")
        check(not unit or unit in ids, f"known mapping unit: {key}")
        if not unit:
            msg = f"unresolved mapping unit: {key}"
            if key in old_unresolved:
                result.warnings.append("legacy " + msg)
            else:
                result.errors.append("new " + msg)
        if row.get("official_key_rechecked", "").strip() != "예":
            result.warnings.append(f"unverified official key (not rechecked against source): {key}")
        source_status = row.get("source_verification", "").strip()
        if source_status not in {"검증완료", "원문대조완료"}:
            result.warnings.append(f"source verification incomplete: {key}: {source_status or 'missing status'}")
    issues = rows("curriculum/issue-map.csv")
    issue_columns = {"unit_id", "issue_id", "issue_name", "learning_tier", "classification_basis",
                     "p1_requirement", "p2_requirement", "prerequisites", "dangi_source", "loan_source",
                     "official_problem_keys", "verification_status", "deferred_trigger", "evidence_refs"}
    check(bool(issues) and issue_columns <= set(issues[0]), "issue map required columns")
    check({r.get("unit_id") for r in issues} == ids, "issue map covers existing unit IDs including unclassified")
    issue_ids = {r.get("issue_id", "") for r in issues}
    check(len(issue_ids) == len(issues) and "" not in issue_ids, "issue identities unique and nonempty")
    classified_units, unclassified_units = set(), set()
    for row in issues:
        unit, issue = row.get("unit_id", ""), row.get("issue_id", "")
        tier = row.get("learning_tier", "")
        check(unit in ids, f"issue unit exists: {issue}")
        check(tier in {"A", "B", "C", ""}, f"issue learning tier: {issue}")
        check(bool(row.get("verification_status", "").strip()), f"issue verification status: {issue}")
        if not tier:
            unclassified_units.add(unit)
            check("미분류" in row.get("verification_status", ""), f"unclassified status explicit: {issue}")
            check(not row.get("official_problem_keys", "").strip(), f"unclassified has no claimed official link: {issue}")
            continue
        classified_units.add(unit)
        for column in ("issue_name", "classification_basis", "dangi_source", "evidence_refs"):
            check(bool(row.get(column, "").strip()), f"classified issue evidence: {issue}:{column}")
        check(bool(row.get("p1_requirement", "").strip()) and bool(row.get("p2_requirement", "").strip()),
              f"both exam uses or explicit limitations: {issue}")
        if tier in {"B", "C"}:
            check(bool(row.get("deferred_trigger", "").strip()), f"deferred issue has promotion trigger: {issue}")
        for prerequisite in filter(None, (s.strip() for s in row.get("prerequisites", "").split(";"))):
            check(prerequisite in ids or prerequisite in issue_ids, f"known issue prerequisite: {issue}:{prerequisite}")
        for reference in filter(None, (s.strip() for s in row.get("evidence_refs", "").split(";"))):
            check(safe_file(reference.split("#", 1)[0]), f"issue local evidence exists: {issue}:{reference}")
        for key in filter(None, (s.strip() for s in row.get("official_problem_keys", "").split(";"))):
            check(key in current_keys, f"issue official key registered in mapping: {issue}:{key}")
    for unit in sorted(classified_units):
        check(any(r.get("unit_id") == unit and r.get("learning_tier") == "A" for r in issues),
              f"classified unit retains core issues: {unit}")
    check({p.stem for p in lessons} <= classified_units, "prepared lessons have classified issue maps")
    if unclassified_units:
        result.warnings.append(f"issue map unclassified units: {len(unclassified_units)}; not omitted from curriculum")
    result.warnings.append("issue map tiers are evidence-linked teaching decisions, not verified frequency or mastery")
    sources = rows("sources/source-index.csv")
    source_ids = {r.get("source_id", "") for r in sources}
    check(len(sources) == len(source_ids) and "" not in source_ids, "source metadata identities unique and nonempty")
    for row in sources:
        key = row.get("source_id", "")
        check(google_source_id(row.get("url", "")) == key, f"source URL identity: {key}")
        check(bool(row.get("name")) and bool(row.get("mime_type")), f"source name and MIME: {key}")
    for row in units:
        for col in ("dangi_markdown_url", "dangi_pdf_url"):
            check(google_source_id(row.get(col, "")) in source_ids, f"indexed source exists: {row.get('unit_id')}:{col}")
    mappings = rows("sources/textbook-mapping.csv")
    check(len(mappings) == len(ids) and {r.get("unit_id") for r in mappings} == ids, "textbook mapping covers unit identities")
    for row in mappings:
        check(google_source_id(row.get("source_url", "")) in source_ids, f"textbook source URL: {row.get('unit_id')}")
    for item in REQUIRED:
        check((root / item).is_file(), f"required file: {item}")
    excluded = {".git", "_workspace", "tmp", "private", "raw", "__pycache__"}
    for path in root.rglob("*"):
        rel = path.relative_to(root)
        if not path.is_file() or any(p in excluded for p in rel.parts):
            continue
        check(path.suffix.lower() not in {".pdf", ".xlsx", ".xls", ".zip"}, f"no raw binary: {rel}")
        if path.suffix == ".md":
            text = path.read_text(encoding="utf-8-sig")
            for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", text):
                if "://" in target or target.startswith("#") or "<" in target:
                    continue
                target = unquote(target.split("#", 1)[0])
                check(not target or (path.parent / target).exists(), f"local link: {rel} -> {target}")
    return result

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    result = validate(parser.parse_args(argv).root)
    print(f"PASS: {len(result.checks)}; FAIL: {len(result.errors)}; WARN: {len(result.warnings)}")
    for error in result.errors:
        print("FAIL:", error)
    for warning in result.warnings:
        print("WARN:", warning)
    print("Scope: offline package integrity only; not legal accuracy, remote URL access, Sheets recalculation, or live record testing.")
    return int(not result.ok)

if __name__ == "__main__":
    raise SystemExit(main())
