"""Local browser-test server. It never invokes gh or the GitHub API."""

import datetime as dt
import json
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from build import ROOT
from fixtures import write_browser_fixture
from server import Engine, Handler, ThreadingHTTPServer
from workflows import write_json

(ROOT / ".tmp").mkdir(exist_ok=True)
stage = tempfile.TemporaryDirectory(prefix="live-browser-", dir=ROOT / ".tmp")
root = Path(stage.name)
(root / "results/flashinfer").mkdir(parents=True)
(root / "site").symlink_to(ROOT / "site", target_is_directory=True)
write_browser_fixture(root)
# One isolated ready PR lets browser checks exercise the view even when the real
# queue has no merge-ready PRs. Never write fixture state to the real snapshot.
fixture_path = root / "results/snapshot.json"
fixture = json.loads(fixture_path.read_text())
for item in fixture["pullRequests"]:
    item["ready"] = False
ready_pr = next(
    (p for p in fixture["pullRequests"] if p["mine"] and not p["isDraft"]),
    fixture["pullRequests"][0],
)
ready_pr.update(queue="direct", responsibility="You", reason="Fixture review action", isDraft=False)
fixture["pullRequests"] = [ready_pr] + [p for p in fixture["pullRequests"] if p is not ready_pr]
ready_pr["ready"] = True
ready_pr["readiness"] = {
    "ready": True,
    "known": True,
    "eligible": True,
    "reviewedByMe": False,
    "checksPassed": True,
    "checkCount": 3,
    "approvals": [{"author": "test-maintainer"}],
    "summary": "Approved by @test-maintainer · 3 check results passed.",
    "blockers": [],
}
approved_pr = next(p for p in fixture["pullRequests"] if not p["mine"])
my_approval = {
    "id": "fixture-my-approval",
    "kind": "review",
    "author": fixture["user"],
    "state": "APPROVED",
    "at": dt.datetime.now(dt.timezone.utc).isoformat(),
    "body": "Approved fixture",
    "url": approved_pr["url"] + "#fixture-my-approval",
}
approved_pr["events"].append(my_approval)
write_json(fixture_path, fixture)


class Fake:
    engine = None
    new_activity = set()
    failed_checks = set()
    revoked_approvals = set()

    def request(self):
        self.engine.before_request()
        time.sleep(0.4)
        self.engine.after_request(
            {
                "data": {
                    "_refreshRate": {
                        "cost": 1,
                        "remaining": 100,
                        "limit": 5000,
                        "resetAt": "2030-01-01T00:00:00Z",
                    }
                }
            }
        )

    def global_refresh(self, progress):
        for i in range(5):
            self.request()
            progress("Test global refresh", i + 1, 5, (i + 1) / 5)
        return {"message": "Global refresh complete"}

    def refresh_pr(self, workspace, number, progress):
        self.request()
        path = (
            root
            / "results"
            / ("snapshot.json" if workspace == "vllm" else "flashinfer/snapshot.json")
        )
        data = json.loads(path.read_text())
        item = next(p for p in data["pullRequests"] if p["number"] == number)
        item["refreshedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
        item["reason"] = "Fresh data from the local test backend"
        key = (workspace, number)
        if key in self.new_activity:
            self.new_activity.remove(key)
            event = {
                "id": "test-mention-" + item["refreshedAt"],
                "author": "test-author",
                "body": "@test-reviewer Please take another look.",
                "kind": "comment",
                "at": item["refreshedAt"],
                "url": item["url"] + "#test-new-mention",
                "state": None,
            }
            item["events"].append(event)
            item.update(
                trigger=event,
                activityAt=event["at"],
                queue="direct",
                responsibility="You",
                confidence="explicit",
            )
        if key in self.failed_checks:
            self.failed_checks.remove(key)
            item["ready"] = False
            item["readiness"].update(
                ready=False,
                checksPassed=False,
                summary="Checks are failing.",
                blockers=["Checks are failing."],
            )
        if key in self.revoked_approvals:
            self.revoked_approvals.remove(key)
            for event in item["events"]:
                if event["id"] == "fixture-my-approval":
                    event["state"] = "DISMISSED"
        write_json(path, data)
        progress("Updated", 1, 1, 1)
        return {"message": f"#{number} refreshed"}


fake = Fake()
engine = Engine(root, fake, startup_rate=False)
fake.engine = engine
engine.after_request(
    {
        "data": {
            "_refreshRate": {
                "cost": 0,
                "remaining": 100,
                "limit": 5000,
                "resetAt": "2030-01-01T00:00:00Z",
            }
        }
    }
)


class FixtureHandler(Handler):
    def do_POST(self):
        if self.path in ("/test/new-activity", "/test/failed-checks", "/test/revoke-approval"):
            if not self._trusted(write=True):
                return self._send(403, {"error": "Local test only"})
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            targets = {
                "/test/new-activity": fake.new_activity,
                "/test/failed-checks": fake.failed_checks,
                "/test/revoke-approval": fake.revoked_approvals,
            }[self.path]
            targets.add((payload["workspace"], payload["number"]))
            return self._send(200, {"queued": True})
        return super().do_POST()


http = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
http.engine = engine
print(json.dumps({"port": http.server_port}), flush=True)
try:
    http.serve_forever()
finally:
    engine.close()
    http.server_close()
    stage.cleanup()
