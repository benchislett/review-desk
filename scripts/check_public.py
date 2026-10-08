#!/usr/bin/env python3
"""Check Git-visible source and staged content for local state and credential patterns."""

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRIVATE_FILES = {"tokens.local.sh", "config.local.toml", "index.html", "index.html.tmp"}
PRIVATE_DIRS = {".tmp", "results", ".venv", "node_modules", "__pycache__"}
PATTERNS = {
    "GitHub token": rb"(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})",
    "AWS access key": rb"(?:AKIA|ASIA)[A-Z0-9]{16}",
    "private key": rb"-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----",
}


def git(*args):
    return subprocess.check_output(["git", "-C", str(ROOT), *args])


def main():
    tracked = {p for p in git("ls-files", "--cached", "-z").decode().split("\0") if p}
    untracked = {
        p for p in git("ls-files", "--others", "--exclude-standard", "-z").decode().split("\0") if p
    }
    problems = []
    for name in sorted(tracked | untracked):
        path = Path(name)
        if (
            path.name in PRIVATE_FILES
            or any(part in PRIVATE_DIRS for part in path.parts)
            or (path.name.startswith(".env") and path.name != ".env.example")
        ):
            problems.append(f"{name}: local state must not be committed")
            continue
        source = ROOT / path
        if source.is_symlink():
            problems.append(f"{name}: inspect this symlink before publishing")
            continue
        versions = []
        if source.is_file():
            versions.append(("working tree", source.read_bytes()))
        if name in tracked:
            versions.append(("index", git("show", ":" + name)))
        for version, content in versions:
            for label, pattern in PATTERNS.items():
                if re.search(pattern, content):
                    problems.append(f"{name} ({version}): possible {label}; value omitted")
    if problems:
        raise SystemExit("\n".join(problems))
    print(
        f"Public-source check passed for {len(tracked | untracked)} files and their staged versions."
    )


if __name__ == "__main__":
    main()
