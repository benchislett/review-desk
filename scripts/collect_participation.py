#!/usr/bin/env python3
"""Collect only open FlashInfer PRs found by author/commenter searches. No repo crawl."""

import argparse
import datetime as dt
import json
from pathlib import Path

from classify import classify
from collect import ARGS, BASE, FIELDS, api, complete
from discover import discover
from settings import github_user

ROOT = Path(__file__).resolve().parents[1]
REPO = "flashinfer-ai/flashinfer"
QUALIFIERS = ("author", "commenter")


def main(argv=None, progress=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user", help="Override github_user in config.local.toml")
    args = parser.parse_args(argv)
    user = github_user(ROOT, args.user)
    started = dt.datetime.now(dt.timezone.utc).isoformat()
    index = discover(REPO, user, qualifiers=QUALIFIERS)
    # This is the entire candidate set: no repo enumeration, retained IDs, or reviewer search.
    candidates = index["candidates"]
    candidate_numbers = {p["number"] for p in candidates}
    output = ROOT / "results/flashinfer"
    output.mkdir(parents=True, exist_ok=True)
    cache = ROOT / ".tmp/flashinfer"
    cache.mkdir(parents=True, exist_ok=True)
    nested = "\n".join(f"{key}({ARGS[key]}) {{ {value} }}" for key, value in FIELDS.items())
    owner, repo = REPO.split("/")
    records = []
    if progress:
        progress(0, len(candidates), "Reading matching FlashInfer PRs")
    for i in range(0, len(candidates), 5):
        batch = candidates[i : i + 5]
        pulls = " ".join(
            f"p{x['number']}:pullRequest(number:{x['number']}) {{ {BASE} {nested} }}" for x in batch
        )
        q = f"query {{ repository(owner:{json.dumps(owner)},name:{json.dumps(repo)}) {{ {pulls} }} }}"
        result = list(api(q)["repository"].values())
        for pr in result:
            if pr is None or pr["number"] not in candidate_numbers:
                raise RuntimeError("Unexpected PR outside search results")
            for field in FIELDS:
                complete(pr, field)
            for thread in pr["reviewThreads"]["nodes"]:
                complete(thread, "comments", "PullRequestReviewThread")
        (cache / f"batch-{i:04}.json").write_text(json.dumps(result))
        records.extend(result)
        if progress:
            progress(len(records), len(candidates), "Reading matching FlashInfer PRs")
        print(f"Read {len(records)}/{len(candidates)} matching FlashInfer PRs", flush=True)
    pool = [
        p
        for pr in records
        if pr["state"] == "OPEN" and (p := classify(pr, user, include_commented=True))
    ]
    # Structural reviewer/mention data is used only to prioritize admitted PRs.
    pool = [p for p in pool if p["mine"] or "Commenter" in p["reasons"]]
    snapshot = {
        "repo": REPO,
        "user": user,
        "startedAt": started,
        "completedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "done": True,
        "collectionMode": "participation",
        "poolScope": "authored-commented",
        "queries": index["queries"],
        "candidateCount": len(candidates),
        "scannedCount": len(records),
        "pullRequests": pool,
    }
    (output / "search-index.json").write_text(json.dumps(index, indent=2))
    path = output / "snapshot.json"
    temp = path.with_suffix(".json.tmp")
    temp.write_text(json.dumps(snapshot, indent=2))
    temp.replace(path)
    print(
        f"Saved {len(pool)} relevant open PRs, {sum(p['mine'] for p in pool)} authored. No repository crawl.",
        flush=True,
    )


if __name__ == "__main__":
    main()
