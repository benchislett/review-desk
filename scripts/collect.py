#!/usr/bin/env python3
"""Read-only open-PR snapshot using targeted search, or an optional exhaustive audit."""

import argparse
import datetime as dt
import json
import pathlib
import subprocess
import time

import api_metrics
import api_runtime
from credentials import github_environment
from settings import github_user

ROOT = pathlib.Path(__file__).resolve().parents[1]
PAGE = "pageInfo { hasNextPage endCursor }"
COMMENT = "id body createdAt updatedAt url author { login __typename }"
INLINE_COMMENT = COMMENT + " path line originalLine diffHunk replyTo { id }"
FIELDS = {
    "comments": f"nodes {{ {COMMENT} }} {PAGE}",
    "reviews": f"nodes {{ {COMMENT} submittedAt state }} {PAGE}",
    "latestOpinionatedReviews": f"nodes {{ id author {{ login __typename }} authorCanPushToRepository state submittedAt url }} {PAGE}",
    "reviewThreads": f"nodes {{ id isResolved isOutdated comments(first:30) {{ nodes {{ {INLINE_COMMENT} }} {PAGE} totalCount }} }} {PAGE}",
    "reviewRequests": f"nodes {{ requestedReviewer {{ ... on User {{ login }} ... on Team {{ name }} }} }} {PAGE}",
    "assignees": f"nodes {{ login }} {PAGE}",
    "labels": f"nodes {{ name }} {PAGE}",
    "timelineItems": f"""nodes {{ __typename
        ... on ReviewRequestedEvent {{ createdAt actor {{ login __typename }} requestedReviewer {{ ... on User {{ login }} }} }}
        ... on AssignedEvent {{ createdAt actor {{ login __typename }} assignee {{ ... on User {{ login }} }} }}
        }} {PAGE}""",
}
FIELDS = {key: value + " totalCount" for key, value in FIELDS.items()}
ARGS = {
    "comments": "first:100",
    "reviews": "first:100",
    "latestOpinionatedReviews": "first:100,writersOnly:true",
    "reviewThreads": "first:20",
    "reviewRequests": "first:100",
    "assignees": "first:100",
    "labels": "first:100",
    "timelineItems": "first:100",
}
BASE = """id number title body url createdAt updatedAt isDraft state author { login ... on User { name } }
reviewDecision additions deletions changedFiles
headRefOid mergeable mergeStateStatus isInMergeQueue isMergeQueueEnabled
statusCheckRollup { state contexts { totalCount } }
potentialMergeCommit { oid statusCheckRollup { state contexts { totalCount } } }
commits(last:1) { nodes { commit { oid message messageHeadline messageBody committedDate url author { name user { login } } } } }"""


def api(query):
    request_query = api_metrics.instrument_query(query)
    for attempt in range(4):
        api_runtime.before_request()
        started_at = dt.datetime.now(dt.timezone.utc).isoformat()
        started = time.perf_counter()
        try:
            p = subprocess.run(
                ["gh", "api", "graphql", "-f", "query=" + request_query],
                capture_output=True,
                text=True,
                timeout=180,
                env=github_environment(),
            )
        except Exception as exc:
            api_runtime.after_request(error=exc)
            api_metrics.record(
                query, attempt + 1, started_at, time.perf_counter() - started, error=exc
            )
            raise
        try:
            response = json.loads(p.stdout)
        except json.JSONDecodeError:
            response = {}
        api_runtime.after_request(
            response,
            None
            if p.returncode == 0 and not response.get("errors")
            else RuntimeError(p.stderr or "GitHub API error"),
        )
        api_metrics.record(
            query,
            attempt + 1,
            started_at,
            time.perf_counter() - started,
            response=response,
            returncode=p.returncode,
        )
        if p.returncode == 0 and not response.get("errors"):
            return response["data"]
        error = (p.stderr or json.dumps(response))[:1500]
        if attempt < 3 and any(
            x in error.lower()
            for x in ["502", "503", "504", "timeout", "something went wrong", "secondary rate"]
        ):
            time.sleep(5 * (attempt + 1))
            continue
        raise RuntimeError(error)
    raise RuntimeError("GitHub request failed")


def complete(node, field, typename="PullRequest"):
    conn = node[field]
    while conn["pageInfo"]["hasNextPage"]:
        args = ARGS[field] if typename == "PullRequest" else "first:100"
        fields = (
            FIELDS[field]
            if typename == "PullRequest"
            else f"nodes {{ {INLINE_COMMENT} }} {PAGE} totalCount"
        )
        cursor = json.dumps(conn["pageInfo"]["endCursor"])
        q = f"query {{ node(id:{json.dumps(node['id'])}) {{ ... on {typename} {{ {field}({args},after:{cursor}) {{ {fields} }} }} }} }}"
        more = api(q)["node"][field]
        conn["nodes"].extend(more["nodes"])
        conn["pageInfo"] = more["pageInfo"]
    # GitHub timeline totalCount is not a reliable count of returned timeline nodes.
    if (
        field != "timelineItems"
        and "totalCount" in conn
        and len(conn["nodes"]) != conn["totalCount"]
    ):
        raise RuntimeError(
            f"Incomplete {field} on {node['id']}: {len(conn['nodes'])}/{conn['totalCount']}; retry the collection"
        )


def main(argv=None, progress=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user", help="Override github_user in config.local.toml")
    parser.add_argument("--repo", default="vllm-project/vllm")
    parser.add_argument(
        "--exhaustive",
        action="store_true",
        help="Audit every open PR, including inline-only mentions missed by search",
    )
    parser.add_argument(
        "--resume", action="store_true", help="Resume an interrupted collection from its cache"
    )
    args = parser.parse_args(argv)
    args.user = github_user(ROOT, args.user)
    owner, repo = args.repo.split("/")
    (ROOT / "results").mkdir(parents=True, exist_ok=True)
    cache = ROOT / ".tmp" / ("collection" if args.exhaustive else "targeted")
    cache.mkdir(parents=True, exist_ok=True)
    if not args.resume:
        for pattern in ["page-*.json", "batch-*.json", "ids.json"]:
            for old in cache.glob(pattern):
                old.unlink()
    manifest_path = cache / "manifest.json"
    if args.resume and manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        if (manifest["user"], manifest["repo"]) != (args.user, args.repo):
            raise RuntimeError("Cache belongs to another user or repository")
    else:
        manifest = {
            "startedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            "user": args.user,
            "repo": args.repo,
            "pages": 0,
            "cursor": None,
            "done": False,
            "collectionMode": "exhaustive" if args.exhaustive else "targeted",
        }
        manifest_path.write_text(json.dumps(manifest))
    previous_path = ROOT / "results/snapshot.json"
    previous = json.loads(previous_path.read_text()) if previous_path.exists() else {}
    known = (
        {p["number"]: p for p in previous.get("pullRequests", [])}
        if (previous.get("user"), previous.get("repo")) == (args.user, args.repo)
        else {}
    )
    # Enumerate IDs separately so discussion reads can run with bounded concurrency.
    from concurrent.futures import ThreadPoolExecutor, as_completed

    ids_path = cache / "ids.json"
    if not (args.resume and ids_path.exists()) and not args.exhaustive:
        from discover import discover

        index = discover(args.repo, args.user)
        (ROOT / "results/search-index.json").write_text(json.dumps(index, indent=2))
        candidates = {p["number"]: p for p in index["candidates"]}
        previous_path = ROOT / "results/snapshot.json"
        if previous_path.exists():
            previous = json.loads(previous_path.read_text())
            if (previous["user"], previous["repo"]) == (args.user, args.repo):
                for pr in previous["pullRequests"]:
                    if pr.get("id"):
                        candidates.setdefault(
                            pr["number"], {"id": pr["id"], "number": pr["number"]}
                        )
        if previous_path.exists() and (previous.get("user"), previous.get("repo")) == (
            args.user,
            args.repo,
        ):
            manifest["lastExhaustiveScannedCount"] = (
                previous["scannedCount"]
                if previous.get("collectionMode") == "exhaustive"
                else previous.get("lastExhaustiveScannedCount")
            )
            manifest["lastExhaustiveAuditAt"] = (
                previous["completedAt"]
                if previous.get("collectionMode") == "exhaustive"
                else previous.get("lastExhaustiveAuditAt")
            )
        manifest["retainedBeyondSearch"] = len(candidates) - len(index["candidates"])
        ids_path.write_text(json.dumps(list(candidates.values())))
        manifest["queries"] = index["queries"]
    if not ids_path.exists() or (not args.resume and args.exhaustive):
        ids, cursor = [], None
        while True:
            after = ",after:" + json.dumps(cursor) if cursor else ""
            q = f"query {{ repository(owner:{json.dumps(owner)},name:{json.dumps(repo)}) {{ pullRequests(first:100,states:OPEN,orderBy:{{field:CREATED_AT,direction:ASC}}{after}) {{ nodes {{ id number }} {PAGE} }} }} }}"
            conn = api(q)["repository"]["pullRequests"]
            ids.extend(conn["nodes"])
            print(f"Enumerated {len(ids)} open PRs", flush=True)
            if not conn["pageInfo"]["hasNextPage"]:
                break
            cursor = conn["pageInfo"]["endCursor"]
        ids_path.write_text(json.dumps(ids))
    manifest_path.write_text(json.dumps(manifest, indent=2))
    ids = json.loads(ids_path.read_text())
    records = {}
    if args.resume:
        for path in sorted(cache.glob("page-*.json")) + sorted(cache.glob("batch-*.json")):
            for pr in json.loads(path.read_text()):
                records[pr["number"]] = pr
    if progress:
        progress(0, len(ids), "Reading PR discussions")
    pending = [x for x in ids if x["number"] not in records]
    batches = [pending[i : i + 5] for i in range(0, len(pending), 5)]
    nested = "\n".join(f"{key}({ARGS[key]}) {{ {value} }}" for key, value in FIELDS.items())

    def fetch_batch(batch):
        pulls = " ".join(
            f"p{x['number']}:pullRequest(number:{x['number']}) {{ {BASE} {nested} }}" for x in batch
        )
        q = f"query {{ repository(owner:{json.dumps(owner)},name:{json.dumps(repo)}) {{ {pulls} }} rateLimit {{ remaining resetAt cost }} }}"
        data = api(q)
        if data["rateLimit"]["remaining"] < 80:
            raise RuntimeError("API budget low; resume after " + data["rateLimit"]["resetAt"])
        result = list(data["repository"].values())
        if any(pr is None for pr in result):
            raise RuntimeError("A PR became inaccessible; retry collection")
        for pr in result:
            for field in FIELDS:
                complete(pr, field)
            for thread in pr["reviewThreads"]["nodes"]:
                complete(thread, "comments", "PullRequestReviewThread")
        (cache / f"batch-{batch[0]['number']}.json").write_text(json.dumps(result))
        return result, data["rateLimit"]

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(fetch_batch, batch) for batch in batches]
        for future in as_completed(futures):
            batch, rate = future.result()
            for pr in batch:
                records[pr["number"]] = pr
            if progress:
                progress(len(records), len(ids), "Reading PR discussions")
            print(
                f"Read discussions: {len(records)}/{len(ids)} PRs; API budget {rate['remaining']}",
                flush=True,
            )
    enumerated = {p["number"] for p in ids}
    records = {n: p for n, p in records.items() if n in enumerated and p["state"] == "OPEN"}
    manifest.update(done=True, candidateCount=len(ids))
    if args.exhaustive:
        manifest["openCount"] = len(ids)
    manifest_path.write_text(json.dumps(manifest, indent=2))
    for pr in records.values():
        pr["historicalReasons"] = known.get(pr["number"], {}).get("reasons", [])
    from classify import classify

    pool = [p for pr in records.values() if (p := classify(pr, args.user))]
    snapshot = {
        **manifest,
        "completedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "scannedCount": len(records),
        "pullRequests": pool,
    }
    output = ROOT / "results" / "snapshot.json"
    temporary = output.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(snapshot, indent=2))
    temporary.replace(output)
    print(f"Collected {len(pool)} relevant PRs from {len(records)} open PRs.", flush=True)


if __name__ == "__main__":
    main()
