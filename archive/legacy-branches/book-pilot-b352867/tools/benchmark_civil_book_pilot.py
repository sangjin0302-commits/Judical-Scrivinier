#!/usr/bin/env python3
"""Measure local retrieval for the canonical and pilot lesson artifacts."""

from __future__ import annotations

import argparse
import json
import statistics
import time
from pathlib import Path


def measure(path: Path, runs: int) -> dict[str, object]:
    durations: list[float] = []
    payload = b""
    for _ in range(runs):
        start = time.perf_counter_ns()
        payload = path.read_bytes()
        durations.append((time.perf_counter_ns() - start) / 1_000_000)
    return {
        "path": path.as_posix(),
        "bytes": len(payload),
        "runs": runs,
        "min_ms": min(durations),
        "median_ms": statistics.median(durations),
        "max_ms": max(durations),
        "failures": 0,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--existing", type=Path, required=True)
    parser.add_argument("--pilot", type=Path, required=True)
    parser.add_argument("--runs", type=int, default=50)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.runs < 5:
        raise ValueError("at least five runs are required")
    result = {
        "measurement": "local file retrieval only; excludes ChatGPT generation and network latency",
        "existing": measure(args.existing, args.runs),
        "pilot": measure(args.pilot, args.runs),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
