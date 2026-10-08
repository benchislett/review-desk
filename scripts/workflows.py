"""Refresh operations. All GitHub requests pass through collect.api's shared gate."""

import datetime as dt
import json
import shutil
import tempfile
from pathlib import Path
from zoneinfo import ZoneInfo

import collect
import collect_participation
import velocity
from classify import classify

WORKSPACES = {
    "vllm": ("vllm-project/vllm", "snapshot.json"),
    "flashinfer": ("flashinfer-ai/flashinfer", "flashinfer/snapshot.json"),
}


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(data, indent=2))
    temp.replace(path)


class Workflows:
    def __init__(self, root):
        self.root = Path(root)

    def global_refresh(self, progress):
        # Keep the served data intact if any stage fails. Publish only after all succeed.
        base = self.root / ".tmp"
        base.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="live-refresh-", dir=base) as directory:
            stage = Path(directory)
            (stage / "results/flashinfer").mkdir(parents=True)
            paths = ["snapshot.json", "velocity.json", "flashinfer/snapshot.json"]
            for path in paths:
                shutil.copyfile(self.root / "results" / path, stage / "results" / path)
            user = json.loads((stage / "results/snapshot.json").read_text())["user"]
            flash_user = json.loads((stage / "results/flashinfer/snapshot.json").read_text())[
                "user"
            ]
            timezone = json.loads((stage / "results/velocity.json").read_text())["timezone"]
            originals = [m.ROOT for m in [collect, velocity, collect_participation]]
            try:
                for m in [collect, velocity, collect_participation]:
                    m.ROOT = stage
                progress("vLLM", 0, 0, 0)
                collect.main(
                    ["--user", user],
                    lambda n, total, label: progress(
                        label, n, total, 0.8 * (n / total if total else 0)
                    ),
                )
                progress("Review velocity", 0, 0, 0.8)
                velocity.main(
                    ["--user", user, "--timezone", timezone],
                    lambda n, total, label: progress(
                        label, n, total, 0.8 + 0.15 * (n / total if total else 0)
                    ),
                )
                progress("FlashInfer", 0, 0, 0.95)
                collect_participation.main(
                    ["--user", flash_user],
                    lambda n, total, label: progress(
                        label, n, total, 0.95 + 0.05 * (n / total if total else 0)
                    ),
                )
            finally:
                for m, original in zip([collect, velocity, collect_participation], originals):
                    m.ROOT = original
            for path in paths:
                data = json.loads((stage / "results" / path).read_text())
                if path != "velocity.json":
                    for pr in data["pullRequests"]:
                        pr["refreshedAt"] = data["completedAt"]
                write_json(self.root / "results" / path, data)
            for path in ["search-index.json", "flashinfer/search-index.json"]:
                write_json(
                    self.root / "results" / path, json.loads((stage / "results" / path).read_text())
                )
        return {"message": "All workspaces refreshed"}

    def refresh_pr(self, workspace, number, progress):
        repo, path = WORKSPACES[workspace]
        owner, name = repo.split("/")
        snapshot_path = self.root / "results" / path
        snapshot = json.loads(snapshot_path.read_text())
        previous = next((p for p in snapshot["pullRequests"] if p["number"] == number), None)
        if previous is None:
            raise ValueError("PR is no longer in this workspace")
        progress(f"Reading {repo} #{number}", 0, 1, 0)
        nested = "\n".join(
            f"{key}({collect.ARGS[key]}) {{ {value} }}" for key, value in collect.FIELDS.items()
        )
        q = f"query {{ repository(owner:{json.dumps(owner)},name:{json.dumps(name)}) {{ pullRequest(number:{number}) {{ {collect.BASE} {nested} }} }} }}"
        raw = collect.api(q)["repository"]["pullRequest"]
        if raw is None:
            raise ValueError("PR is no longer accessible")
        for field in collect.FIELDS:
            collect.complete(raw, field)
        for thread in raw["reviewThreads"]["nodes"]:
            collect.complete(thread, "comments", "PullRequestReviewThread")
        raw["historicalReasons"] = previous["reasons"]
        updated = (
            classify(raw, snapshot["user"], include_commented=workspace == "flashinfer")
            if raw["state"] == "OPEN"
            else None
        )
        if (
            workspace == "flashinfer"
            and updated
            and not (updated["mine"] or "Commenter" in updated["reasons"])
        ):
            updated = None
        at = now()
        if updated:
            updated["refreshedAt"] = at
        snapshot["pullRequests"] = [
            p for p in snapshot["pullRequests"] if p["number"] != number
        ] + ([updated] if updated else [])
        snapshot["lastItemRefreshAt"] = at
        # Replace this PR's reviews, including closed PRs, to avoid double-counting.
        if workspace == "vllm":
            vp = self.root / "results/velocity.json"
            history = json.loads(vp.read_text())
            reviews = velocity.normalize([raw], snapshot["user"], history["timezone"])
            history["reviews"] = sorted(
                [r for r in history["reviews"] if r["number"] != number] + reviews,
                key=lambda r: (r["submittedAt"], r["id"]),
            )
            history["lastItemRefreshAt"] = at
            history["today"] = dt.datetime.now(ZoneInfo(history["timezone"])).date().isoformat()
            history["candidateCount"] = max(
                history["candidateCount"], len({r["number"] for r in history["reviews"]})
            )
            write_json(vp, history)
        write_json(snapshot_path, snapshot)
        progress("Updated", 1, 1, 1)
        return {
            "workspace": workspace,
            "number": number,
            "removed": updated is None,
            "prState": raw["state"],
            "message": f"#{number} refreshed"
            if updated
            else f"#{number} is {raw['state'].lower()} or no longer in your pool",
        }
