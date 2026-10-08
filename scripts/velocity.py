#!/usr/bin/env python3
"""Collect formal reviews on PRs in every state, independently of the active queue."""

import argparse
import datetime as dt
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from zoneinfo import ZoneInfo

from bots import is_bot
from collect import PAGE, api
from settings import github_user, review_timezone

ROOT = Path(__file__).resolve().parents[1]
REVIEW = "id submittedAt state url author { login __typename }"
STATES = {"COMMENTED", "APPROVED", "CHANGES_REQUESTED", "DISMISSED"}


def normalize(pulls, user, timezone):
    reviews = {}
    zone = ZoneInfo(timezone)
    for pr in pulls:
        for review in pr["reviews"]["nodes"]:
            if (
                is_bot(review.get("author"))
                or not review.get("submittedAt")
                or review["state"] not in STATES
                or (review.get("author") or {}).get("login", "").lower() != user.lower()
            ):
                continue
            at = dt.datetime.fromisoformat(review["submittedAt"].replace("Z", "+00:00"))
            reviews[review["id"]] = {
                **review,
                "date": at.astimezone(zone).date().isoformat(),
                "number": pr["number"],
                "title": pr["title"],
                "prUrl": pr["url"],
                "prState": pr["state"],
            }
    return sorted(reviews.values(), key=lambda r: (r["submittedAt"], r["id"]))


def main(argv=None, progress=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default="vllm-project/vllm")
    parser.add_argument("--user", help="Override github_user in config.local.toml")
    parser.add_argument("--timezone", help="Override timezone in config.local.toml")
    args = parser.parse_args(argv)
    args.user = github_user(ROOT, args.user)
    args.timezone = review_timezone(ROOT, args.timezone)
    (ROOT / "results").mkdir(parents=True, exist_ok=True)
    started = dt.datetime.now(dt.timezone.utc).isoformat()
    query = f"repo:{args.repo} is:pr reviewed-by:{args.user}"
    candidates = {}
    cursor = None
    while True:
        after = ",after:" + json.dumps(cursor) if cursor else ""
        conn = api(
            f"query {{ search(type:ISSUE,query:{json.dumps(query)},first:100{after}) {{ issueCount nodes {{ ... on PullRequest {{ number }} }} {PAGE} }} }}"
        )["search"]
        if conn["issueCount"] > 1000:
            raise RuntimeError(
                "Review search exceeds 1000 results; partition the query before collecting."
            )
        for pr in conn["nodes"]:
            candidates[pr["number"]] = pr
        print(f"Discovered {len(candidates)} reviewed PRs (all states)", flush=True)
        if not conn["pageInfo"]["hasNextPage"]:
            break
        cursor = conn["pageInfo"]["endCursor"]
    # Include already-observed reviews in case search indexing has not caught up.
    snapshot_path = ROOT / "results/snapshot.json"
    if snapshot_path.exists():
        snapshot = json.loads(snapshot_path.read_text())
        if (snapshot["repo"], snapshot["user"]) == (args.repo, args.user):
            for pr in snapshot["pullRequests"]:
                if any(
                    e["kind"] == "review" and e["author"].lower() == args.user.lower()
                    for e in pr["events"]
                ):
                    candidates.setdefault(pr["number"], {"number": pr["number"]})
    owner, repo = args.repo.split("/")

    def fetch(batch):
        fields = f"number title url state reviews(first:100,author:{json.dumps(args.user)}) {{ nodes {{ {REVIEW} }} {PAGE} totalCount }}"
        aliases = " ".join(f"p{n}:pullRequest(number:{n}) {{ {fields} }}" for n in batch)
        records = list(
            api(
                f"query {{ repository(owner:{json.dumps(owner)},name:{json.dumps(repo)}) {{ {aliases} }} }}"
            )["repository"].values()
        )
        for pr in records:
            conn = pr["reviews"]
            while conn["pageInfo"]["hasNextPage"]:
                after = json.dumps(conn["pageInfo"]["endCursor"])
                q = f"query {{ repository(owner:{json.dumps(owner)},name:{json.dumps(repo)}) {{ pullRequest(number:{pr['number']}) {{ reviews(first:100,author:{json.dumps(args.user)},after:{after}) {{ nodes {{ {REVIEW} }} {PAGE} totalCount }} }} }} }}"
                more = api(q)["repository"]["pullRequest"]["reviews"]
                conn["nodes"].extend(more["nodes"])
                conn["pageInfo"] = more["pageInfo"]
            if len(conn["nodes"]) != conn["totalCount"]:
                raise RuntimeError(f"Incomplete reviews for PR {pr['number']}")
        return records

    pulls = []
    numbers = sorted(candidates)
    if progress:
        progress(0, len(numbers), "Reading formal reviews")
    with ThreadPoolExecutor(max_workers=4) as pool:
        for future in as_completed(
            [pool.submit(fetch, numbers[i : i + 25]) for i in range(0, len(numbers), 25)]
        ):
            pulls.extend(future.result())
            if progress:
                progress(len(pulls), len(numbers), "Reading formal reviews")
            print(f"Read formal review history: {len(pulls)}/{len(numbers)} PRs", flush=True)
    reviews = normalize(pulls, args.user, args.timezone)
    now = dt.datetime.now(dt.timezone.utc)
    result = {
        "repo": args.repo,
        "user": args.user,
        "timezone": args.timezone,
        "startedAt": started,
        "completedAt": now.isoformat(),
        "today": now.astimezone(ZoneInfo(args.timezone)).date().isoformat(),
        "query": query,
        "candidateCount": len(candidates),
        "reviews": reviews,
        "done": True,
    }
    output = ROOT / "results/velocity.json"
    temp = output.with_suffix(".json.tmp")
    temp.write_text(json.dumps(result, indent=2))
    temp.replace(output)
    print(
        f"Collected {len(reviews)} formal review submissions across {len({r['number'] for r in reviews})} PRs.",
        flush=True,
    )


if __name__ == "__main__":
    main()
