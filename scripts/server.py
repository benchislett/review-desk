#!/usr/bin/env python3
"""Local Review Desk server: stdlib HTTP, one shared job queue, JSON persistence."""

import argparse
import copy
import datetime as dt
import fcntl
import json
import os
import threading
import time
import traceback
import uuid
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import api_runtime
from build import ROOT, load_bundle, render_html
from collect import api
from credentials import github_environment
from pins import apply_pins, pin_key
from triage import apply_dismissals, dismissal_key, dismissal_record
from workflows import Workflows, write_json


class FrozenError(ValueError):
    pass


class StoppedError(RuntimeError):
    pass


class StaleActivityError(ValueError):
    pass


class Engine:
    def __init__(self, root=ROOT, workflows=None, startup_rate=True):
        self.root = Path(root)
        self.workflows = workflows or Workflows(self.root)
        self.cv = threading.Condition(threading.RLock())
        self.queue = deque()
        self.jobs = {}
        self.active = None
        self.closed = False
        self.inflight = 0
        self.total_calls = 0
        self.revision = 0
        self.instance = uuid.uuid4().hex
        self.state_path = self.root / ".tmp/server/state.json"
        stored = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        self.frozen = bool(stored.get("frozen", False))
        self.rate = stored.get("rate")
        self.last_refresh = {}
        self.dismissals_path = self.root / "results/dismissals.json"
        self.dismissals = (
            json.loads(self.dismissals_path.read_text()) if self.dismissals_path.exists() else {}
        )
        self.pins_path = self.root / "results/pins.json"
        self.pins = json.loads(self.pins_path.read_text()) if self.pins_path.exists() else {}
        self._reload_bundle()
        self.thread = threading.Thread(target=self._worker, daemon=True, name="review-desk-refresh")
        self.thread.start()
        if startup_rate and not self.frozen:
            self._enqueue("rate", "rate", "startup")

    def _persist(self):
        write_json(self.state_path, {"frozen": self.frozen, "rate": self.rate})

    def _reload_bundle(self):
        self.raw_bundle = load_bundle(self.root, live=True)
        bundle, retained = apply_dismissals(self.raw_bundle, self.dismissals)
        if retained != self.dismissals:
            write_json(self.dismissals_path, retained)
        self.dismissals = retained
        self.bundle = apply_pins(bundle, self.pins)

    def set_pin(self, workspace, number, pinned):
        with self.cv:
            if type(pinned) is not bool:
                raise ValueError("pinned must be a boolean")
            if not isinstance(workspace, str) or workspace not in self.bundle["workspaces"]:
                raise ValueError("Unknown workspace")
            data = self.bundle["workspaces"][workspace]
            pr = next(
                (p for p in data["pullRequests"] if type(number) is int and p["number"] == number),
                None,
            )
            if pr is None:
                raise ValueError("PR is not in this workspace")
            key = pin_key(data, pr)
            if (key in self.pins) == pinned:
                return self.get_bundle()
            updated = dict(self.pins)
            if pinned:
                updated[key] = {"pinnedAt": dt.datetime.now(dt.timezone.utc).isoformat()}
            else:
                updated.pop(key, None)
            write_json(self.pins_path, updated)
            self.pins = updated
            # Do not mutate a bundle while an HTTP thread may be serializing it.
            self.bundle = apply_pins(copy.deepcopy(self.bundle), self.pins)
            self.revision += 1
            return self.get_bundle()

    def set_dismissal(self, workspace, number, dismissed, version):
        with self.cv:
            if type(dismissed) is not bool:
                raise ValueError("dismissed must be a boolean")
            if not isinstance(workspace, str) or workspace not in self.bundle["workspaces"]:
                raise ValueError("Unknown workspace")
            data = self.bundle["workspaces"][workspace]
            pr = next(
                (p for p in data["pullRequests"] if type(number) is int and p["number"] == number),
                None,
            )
            if pr is None:
                raise ValueError("PR is not in this workspace")
            if not isinstance(version, str) or version != pr["activityVersion"]:
                raise StaleActivityError(
                    "This PR has new activity. Review it before changing its status."
                )
            key = dismissal_key(data, pr)
            updated = copy.deepcopy(self.dismissals)
            if dismissed:
                original = next(
                    p
                    for p in self.raw_bundle["workspaces"][workspace]["pullRequests"]
                    if p["number"] == number
                )
                updated[key] = dismissal_record(data, original)
            else:
                updated.pop(key, None)
            # Persist user state independently from snapshots that collectors replace.
            write_json(self.dismissals_path, updated)
            self.dismissals = updated
            self.bundle, _ = apply_dismissals(self.raw_bundle, self.dismissals)
            apply_pins(self.bundle, self.pins)
            self.revision += 1
            return self.get_bundle()

    def status(self):
        with self.cv:
            active = copy.deepcopy(self.jobs.get(self.active))
            recent = [copy.deepcopy(j) for j in list(self.jobs.values())[-20:]]
            return {
                "instance": self.instance,
                "revision": self.revision,
                "frozen": self.frozen,
                "rate": copy.deepcopy(self.rate),
                "active": active,
                "queued": [copy.deepcopy(self.jobs[i]) for i in self.queue],
                "jobs": recent,
                "inFlightCalls": self.inflight,
                "sessionApiCalls": self.total_calls,
            }

    def get_bundle(self):
        with self.cv:
            return {**self.bundle, "instance": self.instance, "revision": self.revision}

    def freeze(self, value):
        with self.cv:
            self.frozen = value
            self._persist()
            self.cv.notify_all()
            if (
                not value
                and (not self.rate or self._reset_passed())
                and not any(
                    j["kind"] == "rate" and j["status"] in ("queued", "running")
                    for j in self.jobs.values()
                )
            ):
                self._enqueue("rate", "rate", "unfreeze")
            return self.status()

    def _reset_passed(self):
        try:
            return dt.datetime.fromisoformat(
                self.rate["resetAt"].replace("Z", "+00:00")
            ) <= dt.datetime.now(dt.timezone.utc)
        except (KeyError, TypeError, ValueError):
            return True

    def before_request(self):
        with self.cv:
            while self.frozen and not self.closed:
                self.cv.wait()
            if self.closed:
                raise StoppedError("Server stopped")
            if self.rate and self.rate.get("remaining", 1) <= 0 and not self._reset_passed():
                self.frozen = True
                self._persist()
                while self.frozen and not self.closed:
                    self.cv.wait()
                if self.closed:
                    raise StoppedError("Server stopped")
            self.inflight += 1
            self.total_calls += 1
            if self.active:
                self.jobs[self.active]["apiCalls"] += 1

    def after_request(self, response, error=None):
        with self.cv:
            self.inflight = max(0, self.inflight - 1)
            rate = (response.get("data") or {}).get("_refreshRate")
            if rate:
                if self.active:
                    self.jobs[self.active]["costPoints"] += rate.get("cost", 0)
                rate = {**rate, "observedAt": dt.datetime.now(dt.timezone.utc).isoformat()}
                # Parallel replies can arrive out of order. Keep the lower remaining count in a window.
                if self.rate and self.rate.get("resetAt") == rate.get("resetAt"):
                    rate["remaining"] = min(self.rate["remaining"], rate["remaining"])
                self.rate = rate
                self._persist()
            self.cv.notify_all()

    def _enqueue(self, kind, key, reason, workspace=None, number=None):
        with self.cv:
            id = uuid.uuid4().hex
            job = {
                "id": id,
                "kind": kind,
                "key": key,
                "reason": reason,
                "workspace": workspace,
                "number": number,
                "costPoints": 0,
                "status": "queued",
                "phase": "Queued",
                "completed": 0,
                "total": 0,
                "progress": 0,
                "apiCalls": 0,
                "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
                "createdMono": time.monotonic(),
            }
            self.jobs[id] = job
            self.queue.append(id)
            self.cv.notify_all()
            return copy.deepcopy(job)

    def request_global(self):
        with self.cv:
            if self.frozen:
                raise FrozenError("Refreshes are frozen")
            for j in self.jobs.values():
                if j["kind"] == "global" and j["status"] in ("queued", "running"):
                    return copy.deepcopy(j)
            return self._enqueue("global", "global", "manual")

    def request_pr(self, workspace, number, reason="manual"):
        with self.cv:
            if self.frozen:
                raise FrozenError("Refreshes are frozen")
            if workspace not in self.bundle["workspaces"]:
                raise ValueError("Unknown workspace")
            if type(number) is not int or not any(
                p["number"] == number for p in self.bundle["workspaces"][workspace]["pullRequests"]
            ):
                raise ValueError("PR is not in this workspace")
            if reason not in ("manual", "open", "return"):
                raise ValueError("Unknown refresh trigger")
            key = f"{workspace}:{number}"
            now = time.monotonic()
            pending = [
                j
                for j in self.jobs.values()
                if j["key"] == key and j["status"] in ("queued", "running")
            ]
            for j in pending:
                if j["status"] == "queued":
                    return copy.deepcopy(j)
            if pending:
                j = pending[-1]
                # Returning from GitHub after an older fetch began needs one follow-up read.
                if reason != "return" or (j["reason"] == "return" and now - j["createdMono"] < 1):
                    return copy.deepcopy(j)
            if reason == "open" and now - self.last_refresh.get(key, 0) < 60:
                return {"status": "fresh", "workspace": workspace, "number": number}
            return self._enqueue("pr", key, reason, workspace, number)

    def _progress(self, phase, completed, total, fraction):
        with self.cv:
            if self.active:
                self.jobs[self.active].update(
                    phase=phase, completed=completed, total=total, progress=max(0, min(1, fraction))
                )

    def _worker(self):
        while True:
            with self.cv:
                while (not self.queue or self.frozen) and not self.closed:
                    self.cv.wait()
                if self.closed:
                    return
                id = self.queue.popleft()
                job = self.jobs[id]
                self.active = id
                job.update(
                    status="running",
                    startedAt=dt.datetime.now(dt.timezone.utc).isoformat(),
                    phase="Starting",
                )
                started = time.monotonic()
            try:
                if job["kind"] == "rate":
                    self._progress("Checking API usage", 0, 1, 0)
                    api("query { rateLimit { limit remaining resetAt cost } }")
                    result = {"message": "API usage updated"}
                elif job["kind"] == "global":
                    result = self.workflows.global_refresh(self._progress)
                else:
                    if (
                        job["reason"] == "open"
                        and time.monotonic() - self.last_refresh.get(job["key"], 0) < 60
                    ):
                        result = {"message": "Already refreshed", "cached": True}
                    else:
                        result = self.workflows.refresh_pr(
                            job["workspace"], job["number"], self._progress
                        )
                with self.cv:
                    if job["kind"] != "rate":
                        self._reload_bundle()
                        self.revision += 1
                        if job["kind"] == "global":
                            for key, w in self.bundle["workspaces"].items():
                                for p in w["pullRequests"]:
                                    self.last_refresh[f"{key}:{p['number']}"] = time.monotonic()
                        else:
                            self.last_refresh[job["key"]] = time.monotonic()
                    job.update(status="done", progress=1, phase="Complete", result=result)
            except Exception as exc:
                traceback.print_exc()
                with self.cv:
                    job.update(status="failed", error=str(exc)[:500], phase="Failed")
            finally:
                with self.cv:
                    job.update(
                        completedAt=dt.datetime.now(dt.timezone.utc).isoformat(),
                        elapsedSeconds=round(time.monotonic() - started, 3),
                    )
                    self.active = None
                    finished = [
                        id for id, j in self.jobs.items() if j["status"] in ("done", "failed")
                    ]
                    for old in finished[:-30]:
                        self.jobs.pop(old, None)
                    self.cv.notify_all()

    def close(self):
        with self.cv:
            self.closed = True
            self.cv.notify_all()
        self.thread.join(timeout=3)


def http_authority(value):
    """Normalize Host/Origin authorities, including HTTP's implicit port 80."""
    if not value or any(c.isspace() or c in "/\\?#@" for c in value):
        return None
    try:
        parsed = urlparse("http://" + value)
        port = parsed.port if parsed.port is not None else 80
        if not parsed.hostname or not 1 <= port <= 65535:
            return None
        return parsed.hostname.lower(), port
    except ValueError:
        return None


class Handler(BaseHTTPRequestHandler):
    server_version = "ReviewDesk/1"

    def log_message(self, format, *args):
        if not self.path.startswith("/api/status"):
            super().log_message(format, *args)

    def _trusted(self, write=False):
        hosts = self.headers.get_all("Host", [])
        if len(hosts) != 1:
            return False
        authority = http_authority(hosts[0])
        if authority is None or authority[1] != self.server.server_port:
            return False
        if not getattr(self.server, "allow_remote", False) and authority[0] not in (
            "127.0.0.1",
            "localhost",
            "::1",
        ):
            return False
        if write:
            if self.headers.get("X-Review-Desk") != "1":
                return False
            origin = self.headers.get("Origin")
            if origin:
                parsed = urlparse(origin)
                if (
                    parsed.scheme != "http"
                    or parsed.path
                    or parsed.params
                    or parsed.query
                    or parsed.fragment
                ):
                    return False
                if http_authority(parsed.netloc) != authority:
                    return False
            if self.headers.get("Sec-Fetch-Site") == "cross-site":
                return False
            if self.headers.get_content_type() != "application/json":
                return False
        return True

    def _send(self, status, body, kind="application/json; charset=utf-8"):
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if not self._trusted():
            return self._send(403, {"error": "Invalid request host"})
        path = urlparse(self.path).path
        engine = self.server.engine
        if path in ("/", "/index.html"):
            return self._send(
                200,
                render_html(engine.get_bundle(), engine.root).encode(),
                "text/html; charset=utf-8",
            )
        if path == "/api/status":
            return self._send(200, engine.status())
        if path == "/api/data":
            return self._send(200, engine.get_bundle())
        if path == "/favicon.svg":
            return self._send(200, (engine.root / "site/favicon.svg").read_bytes(), "image/svg+xml")
        return self._send(404, {"error": "Not found"})

    def do_POST(self):
        if not self._trusted(write=True):
            return self._send(403, {"error": "Same-origin requests only"})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size < 0 or size > 4096:
                raise ValueError("Invalid request size")
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict):
                raise ValueError("Expected JSON object")
            path = urlparse(self.path).path
            engine = self.server.engine
            if path == "/api/freeze":
                if type(payload.get("frozen")) is not bool:
                    raise ValueError("frozen must be a boolean")
                return self._send(200, engine.freeze(payload["frozen"]))
            if path == "/api/dismissal":
                return self._send(
                    200,
                    engine.set_dismissal(
                        payload.get("workspace"),
                        payload.get("number"),
                        payload.get("dismissed"),
                        payload.get("activityVersion"),
                    ),
                )
            if path == "/api/pin":
                return self._send(
                    200,
                    engine.set_pin(
                        payload.get("workspace"), payload.get("number"), payload.get("pinned")
                    ),
                )
            if path == "/api/refresh":
                return self._send(202, engine.request_global())
            if path == "/api/refresh-pr":
                return self._send(
                    202,
                    engine.request_pr(
                        payload.get("workspace"),
                        payload.get("number"),
                        payload.get("reason", "manual"),
                    ),
                )
            return self._send(404, {"error": "Not found"})
        except StaleActivityError as exc:
            return self._send(409, {"error": str(exc), "stale": True})
        except FrozenError as exc:
            return self._send(409, {"error": str(exc), "frozen": True})
        except (ValueError, TypeError) as exc:
            return self._send(400, {"error": str(exc)})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Bind address; use 0.0.0.0 to accept network connections",
    )
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    os.environ.update(github_environment())
    state = ROOT / ".tmp/server"
    state.mkdir(parents=True, exist_ok=True)
    lock = (state / "process.lock").open("w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("Review Desk backend is already running")
    # Bind before starting a worker so a port conflict never spends API quota.
    http = ThreadingHTTPServer((args.host, args.port), Handler)
    http.allow_remote = args.host not in ("127.0.0.1", "localhost", "::1")
    os.environ["PR_TRACKER_METRICS_PATH"] = str(state / "api-calls.jsonl")
    os.environ["PR_TRACKER_METRICS_STAGE"] = "live-backend"
    engine = Engine(startup_rate=False)
    http.engine = engine
    api_runtime.controller = engine
    if not engine.frozen:
        engine._enqueue("rate", "rate", "startup")
    address = state / "address.json"
    write_json(
        address,
        {"host": args.host, "port": args.port, "pid": os.getpid(), "instance": engine.instance},
    )
    print(
        f"Review Desk: http://localhost{':' + str(args.port) if args.port != 80 else ''}/ (listening on {args.host})",
        flush=True,
    )
    try:
        http.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        engine.close()
        http.server_close()
        api_runtime.controller = None
        address.unlink(missing_ok=True)
        lock.close()


if __name__ == "__main__":
    main()
