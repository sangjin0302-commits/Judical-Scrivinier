#!/usr/bin/env python3
"""Build a private, page-bounded civil-law source cache and a public lesson index.

The source cache is intentionally written outside the repository.  The public
index contains only hashes, counts, stable IDs, and paths to independently
authored teaching material; it never contains textbook prose.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
from pathlib import Path


PAGE_MARKER = re.compile(r"^\[(?P<title>.+?) / PDF 페이지 (?P<page>\d+)\]\s*$", re.MULTILINE)
INVISIBLE = re.compile("[\u200b\u200c\u200d\u2060\ufeff\U000e0000-\U000e007f]")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def bounded_excerpt(text: str, start_page: int, end_page: int) -> tuple[str, list[int]]:
    matches = list(PAGE_MARKER.finditer(text))
    selected: list[str] = []
    pages: list[int] = []
    for index, match in enumerate(matches):
        page = int(match.group("page"))
        if start_page <= page <= end_page:
            stop = matches[index + 1].start() if index + 1 < len(matches) else len(text)
            selected.append(text[match.start() : stop].rstrip())
            pages.append(page)
    expected = list(range(start_page, end_page + 1))
    if pages != expected:
        raise ValueError(f"page markers mismatch: expected {expected}, found {pages}")
    excerpt = "\n\n".join(selected).strip() + "\n"
    excerpt = INVISIBLE.sub("", excerpt)
    return excerpt, pages


def issue_rows(issue_map: Path, unit_id: str) -> list[dict[str, str]]:
    with issue_map.open(encoding="utf-8-sig", newline="") as handle:
        rows = [row for row in csv.DictReader(handle) if row["unit_id"] == unit_id]
    if not rows:
        raise ValueError(f"unit not found in issue map: {unit_id}")
    return rows


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--private-workdir", type=Path, required=True)
    parser.add_argument("--lesson", type=Path, required=True)
    parser.add_argument("--issue-map", type=Path, required=True)
    parser.add_argument("--unit-id", default="B1-P0040-0047")
    parser.add_argument("--start-page", type=int, default=40)
    parser.add_argument("--end-page", type=int, default=47)
    parser.add_argument("--public-index", type=Path)
    args = parser.parse_args()

    source = args.source.resolve()
    workdir = args.private_workdir.resolve()
    public_index = args.public_index.resolve() if args.public_index else None
    if public_index and (public_index == workdir or workdir in public_index.parents):
        raise ValueError("public index must not be written inside the private workdir")

    raw = source.read_bytes()
    text = raw.decode("utf-8-sig")
    excerpt, pages = bounded_excerpt(text, args.start_page, args.end_page)
    workdir.mkdir(parents=True, exist_ok=True)
    excerpt_path = workdir / f"{args.unit_id}.private.txt"
    excerpt_path.write_text(excerpt, encoding="utf-8", newline="\n")

    issues = issue_rows(args.issue_map, args.unit_id)
    lesson_bytes = args.lesson.read_bytes()
    metadata = {
        "schema_version": 1,
        "unit_id": args.unit_id,
        "source_sha256": sha256_bytes(raw),
        "excerpt_sha256": sha256_bytes(excerpt.encode("utf-8")),
        "lesson_sha256": sha256_bytes(lesson_bytes),
        "pages": pages,
        "excerpt_chars": len(excerpt),
        "issue_ids": [row["issue_id"] for row in issues],
        "tiers": {row["issue_id"]: row["learning_tier"] for row in issues},
        "private_excerpt": str(excerpt_path),
    }
    (workdir / "metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    if public_index:
        public_index.parent.mkdir(parents=True, exist_ok=True)
        safe_index = {
            "schema_version": 1,
            "unit_id": args.unit_id,
            "page_range": [args.start_page, args.end_page],
            "lesson": args.lesson.as_posix(),
            "lesson_sha256": metadata["lesson_sha256"],
            "issue_ids": metadata["issue_ids"],
            "tiers": metadata["tiers"],
            "source_verification": "private-source-checked",
        }
        public_index.write_text(
            json.dumps(safe_index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    print(json.dumps({"pages": pages, "excerpt_chars": len(excerpt)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
