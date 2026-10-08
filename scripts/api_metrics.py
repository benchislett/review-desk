"""Optional per-attempt telemetry. No tokens, response bodies, or raw queries are logged."""

import datetime as dt
import hashlib
import json
import os
import re
import threading
from pathlib import Path

import api_runtime

_LOCK = threading.Lock()
ALIAS = "_refreshRate"


def instrument_query(query):
    if not os.environ.get("PR_TRACKER_METRICS_PATH") and api_runtime.controller is None:
        return query
    query = query.rstrip()
    if not query.endswith("}"):
        raise ValueError("Expected a GraphQL query selection set")
    return query[:-1] + f" {ALIAS}: rateLimit {{ cost remaining limit resetAt }} }}"


def record(query, attempt, started_at, duration, response=None, returncode=None, error=None):
    path = os.environ.get("PR_TRACKER_METRICS_PATH")
    if not path:
        return
    data = (response or {}).get("data") or {}
    rate = data.get(ALIAS) or {}
    entry = {
        "stage": os.environ.get("PR_TRACKER_METRICS_STAGE", "unknown"),
        "startedAt": started_at,
        "completedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "elapsedSeconds": round(duration, 6),
        "attempt": attempt,
        "queryHash": hashlib.sha256(query.encode()).hexdigest(),
        "kind": "search"
        if "search(" in query
        else "pagination"
        if "node(id:" in query
        else "pr-details",
        "prNumbers": [int(n) for n in re.findall(r"pullRequest\(number:(\d+)", query)],
        "returncode": returncode,
        "success": error is None and returncode == 0 and not (response or {}).get("errors"),
        "graphqlErrorTypes": [e.get("type", "unknown") for e in (response or {}).get("errors", [])],
        "costPoints": rate.get("cost"),
        "remainingPoints": rate.get("remaining"),
        "pointLimit": rate.get("limit"),
        "resetAt": rate.get("resetAt"),
    }
    if error:
        entry["error"] = type(error).__name__
    with _LOCK:
        with Path(path).open("a") as stream:
            stream.write(json.dumps(entry) + "\n")
