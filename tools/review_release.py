"""Inspect release boundaries without reading external services or changing data."""
from pathlib import Path
import json
import re

root = Path(__file__).resolve().parents[1]
excluded = {'.git', '_workspace', '__pycache__', 'tmp', 'raw', 'private'}
files = [p for p in root.rglob('*') if p.is_file()
         and not any(x in excluded for x in p.relative_to(root).parts)]
findings = []
for path in files:
    if path.suffix.lower() in {'.pdf', '.xlsx', '.xls', '.zip'}:
        findings.append(str(path.relative_to(root)))
    if path.suffix.lower() not in {'.md', '.txt', '.csv', '.py'}:
        continue
    text = path.read_text(encoding='utf-8-sig')
    # Report paths only; never echo a possible credential.
    if re.search(r'gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{30,}|^-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----$', text, re.M):
        findings.append(str(path.relative_to(root)))
print(json.dumps({'files_reviewed': len(files), 'binary_or_secret_findings': sorted(set(findings))},
                 ensure_ascii=False))
raise SystemExit(bool(findings))
