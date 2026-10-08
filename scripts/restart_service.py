#!/usr/bin/env python3
"""Gracefully restart the user-owned service after backend edits; no sudo needed."""

import json
import os
import signal
import subprocess
import time
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]


def main():
    address = ROOT / ".tmp/server/address.json"
    if not address.exists():
        raise SystemExit("No running backend found. Start the service first.")
    previous = json.loads(address.read_text())
    pid = previous["pid"]
    service_pid = subprocess.run(
        ["systemctl", "show", "review-desk.service", "--property=MainPID", "--value"],
        capture_output=True,
        text=True,
    )
    if service_pid.returncode or service_pid.stdout.strip() != str(pid):
        raise SystemExit(
            "This backend is not managed by review-desk.service. Restart the manual server normally."
        )
    if Path(f"/proc/{pid}").stat().st_uid != os.getuid():
        raise SystemExit("Run this helper as the service account.")
    base = f"http://127.0.0.1:{previous['port']}"
    with urlopen(base + "/api/status", timeout=5) as response:
        status = json.load(response)
    if status["active"] or status["queued"]:
        raise SystemExit("A refresh is running or queued. Let it finish before restarting.")
    # The process is owned by this user. Restart=always starts its replacement;
    # systemctl stop still stops it permanently when explicitly requested.
    os.kill(pid, signal.SIGINT)
    for _ in range(100):
        time.sleep(0.2)
        try:
            with urlopen(base + "/api/status", timeout=2) as response:
                current = json.load(response)
            if current["instance"] != status["instance"]:
                print("Review Desk restarted with the updated backend code.")
                return
        except OSError:
            pass
    raise SystemExit("Restart did not complete. Inspect: journalctl -u review-desk -n 50")


if __name__ == "__main__":
    main()
