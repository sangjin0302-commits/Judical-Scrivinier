"""Report staged secret indicators without printing their values."""

import re
import subprocess
import sys


def git(*args):
    return subprocess.check_output(["git", *args])


paths = [p.decode("utf-8") for p in git("diff", "--cached", "--diff-filter=ACMR", "--name-only", "-z").split(b"\0") if p]
patterns = {
    "private-key": rb"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    "provider-token": rb"(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{24,}|AIza[A-Za-z0-9_-]{30,})",
    "database-uri": rb"postgres(?:ql)?://(?!(?:test:test|user:placeholder)@)[^\s/'\"<>]+:[^\s@/'\"<>]+@",
    "literal-secret": rb"(?im)^\s*(?:GRADING_KEY_BASE64|GOOGLE_CLIENT_SECRET|GOOGLE_REFRESH_TOKEN|DATABASE_URL|RAILWAY_TOKEN|WORKOS_API_KEY)\s*=\s*['\"]?(?!\$|<|\{|example|placeholder|your-|changeme)[A-Za-z0-9_+./=-]{16,}",
}
findings = []
for path in paths:
    if re.search(r"(^|/)(?:\.env(?:\.|$)|private/|.*(?:dump|backup)\.(?:sql|gz|zip)$)", path, re.I):
        findings.append(("sensitive-path", path))
        continue
    blob = git("show", f":{path}")
    for label, pattern in patterns.items():
        if re.search(pattern, blob):
            findings.append((label, path))
for label, path in findings:
    print(f"{label}: {path}")
print(f"Scanned {len(paths)} staged files; findings: {len(findings)}")
sys.exit(bool(findings))
