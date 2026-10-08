#!/usr/bin/env python3
"""Refresh every configured dataset and rebuild, recording wall time and API attempts."""

import datetime as dt
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from settings import github_user

ROOT = Path(__file__).resolve().parents[1]
STEPS = [
    ("vllm-queue", "collect.py"),
    ("review-velocity", "velocity.py"),
    ("flashinfer", "collect_participation.py"),
    ("build", "build.py"),
]


def summarize(events):
    return {
        "apiCalls": len(events),
        "successfulCalls": sum(e["success"] for e in events),
        "failedCalls": sum(not e["success"] for e in events),
        "retryCalls": sum(e["attempt"] > 1 for e in events),
        "reportedCostPoints": sum(e["costPoints"] for e in events if e["costPoints"] is not None),
        "callsWithoutCost": sum(e["costPoints"] is None for e in events),
        "searchCalls": sum(e["kind"] == "search" for e in events),
        "paginationCalls": sum(e["kind"] == "pagination" for e in events),
    }


def backend_refresh():
    address = ROOT / ".tmp/server/address.json"
    if not address.exists():
        return False
    config = json.loads(address.read_text())
    port = config.get("port")
    if type(port) is not int or not 1 <= port <= 65535:
        raise RuntimeError("Invalid local server address")
    base = f"http://127.0.0.1:{port}"
    try:
        with urlopen(base + "/api/status", timeout=2) as response:
            status = json.load(response)
    except URLError:
        return False
    if status["frozen"]:
        raise SystemExit("Refreshes are frozen. Click the API indicator in Review Desk to resume.")
    request = Request(
        base + "/api/refresh",
        data=b"{}",
        headers={"Content-Type": "application/json", "X-Review-Desk": "1"},
    )
    try:
        with urlopen(request, timeout=5) as response:
            job = json.load(response)
    except HTTPError as exc:
        raise SystemExit(json.load(exc).get("error", "Refresh request failed"))
    print("Following shared backend refresh " + job["id"], flush=True)
    last = None
    while True:
        with urlopen(base + "/api/status", timeout=5) as response:
            status = json.load(response)
        current = next((j for j in status["jobs"] if j["id"] == job["id"]), None)
        if current is None:
            raise SystemExit("Refresh job is no longer available; check the dashboard")
        phase = ("Paused · " if status["frozen"] else "") + current["phase"]
        if phase != last:
            print(phase, flush=True)
            last = phase
        if current["status"] == "failed":
            raise SystemExit(current["error"])
        if current["status"] == "done":
            report = {
                "success": True,
                "source": "local-backend",
                "job": current,
                "elapsedSeconds": current["elapsedSeconds"],
                "apiCalls": current["apiCalls"],
                "reportedCostPoints": current["costPoints"],
            }
            (ROOT / "results/refresh-latest.json").write_text(json.dumps(report, indent=2))
            print(
                f"Total: {current['elapsedSeconds']:.2f}s, {current['apiCalls']} API calls, {current['costPoints']} reported points",
                flush=True,
            )
            return True
        time.sleep(1)


def main():
    if backend_refresh():
        return
    state = ROOT / ".tmp/server/state.json"
    if state.exists() and json.loads(state.read_text()).get("frozen"):
        raise SystemExit(
            "Refreshes are frozen. Start the local server and click the API indicator to resume."
        )
    github_user(ROOT)  # Fail before starting collection if setup is incomplete.
    (ROOT / "results").mkdir(parents=True, exist_ok=True)
    now = dt.datetime.now(dt.timezone.utc)
    run_id = now.strftime("%Y%m%dT%H%M%S%fZ")
    logs = ROOT / ".tmp" / ("refresh-" + run_id)
    logs.mkdir(parents=True)
    calls = logs / "api-calls.jsonl"
    calls.touch()
    report = {
        "runId": run_id,
        "startedAt": now.isoformat(),
        "scope": "vLLM targeted queue + full review-velocity history + FlashInfer author/commenter matches + HTML build",
        "apiCallDefinition": "One gh api graphql invocation; includes pagination and retry attempts. No response cache is used.",
        "requestLog": str(calls.relative_to(ROOT)),
        "steps": [],
        "success": False,
    }
    started = time.perf_counter()

    def events():
        return [json.loads(line) for line in calls.read_text().splitlines() if line]

    def save():
        report.update(
            completedAt=dt.datetime.now(dt.timezone.utc).isoformat(),
            elapsedSeconds=round(time.perf_counter() - started, 3),
            **summarize(events()),
        )
        path = ROOT / "results" / ("refresh-" + run_id + ".json")
        path.write_text(json.dumps(report, indent=2))
        (ROOT / "results/refresh-latest.json").write_text(json.dumps(report, indent=2))

    for stage, script in STEPS:
        print(f"Starting {stage}", flush=True)
        env = {
            **os.environ,
            "PR_TRACKER_METRICS_PATH": str(calls),
            "PR_TRACKER_METRICS_STAGE": stage,
        }
        step_start = time.perf_counter()
        log = logs / (stage + ".log")
        with log.open("w") as stream:
            result = subprocess.run(
                [sys.executable, str(ROOT / "scripts" / script)],
                cwd=ROOT,
                env=env,
                stdout=stream,
                stderr=subprocess.STDOUT,
            )
        entry = {
            "stage": stage,
            "command": f"python3 scripts/{script}",
            "elapsedSeconds": round(time.perf_counter() - step_start, 3),
            "exitCode": result.returncode,
            "log": str(log.relative_to(ROOT)),
            **summarize([e for e in events() if e["stage"] == stage]),
        }
        report["steps"].append(entry)
        save()
        print(
            f"{stage}: {entry['elapsedSeconds']:.2f}s, {entry['apiCalls']} API calls, {entry['retryCalls']} retries, rc={result.returncode}",
            flush=True,
        )
        if result.returncode:
            print(log.read_text()[-4000:], flush=True)
            raise SystemExit(result.returncode)
    report["success"] = True
    save()
    print(
        f"Total: {report['elapsedSeconds']:.2f}s, {report['apiCalls']} API calls, {report['reportedCostPoints']} reported GraphQL points ({report['callsWithoutCost']} calls without cost data)",
        flush=True,
    )
    print(f"Report: {ROOT / 'results/refresh-latest.json'}", flush=True)


if __name__ == "__main__":
    main()
