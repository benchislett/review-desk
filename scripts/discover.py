#!/usr/bin/env python3
"""Build a small candidate index using GitHub's server-side search qualifiers."""

import argparse
import json
from pathlib import Path

from collect import PAGE, api
from settings import github_user


def discover(
    repo, user, qualifiers=("author", "assignee", "review-requested", "mentions", "reviewed-by")
):
    records, queries = {}, []
    # Separate searches express a union; combining qualifiers would be an intersection.
    for qualifier in qualifiers:
        query = f"repo:{repo} is:pr is:open {qualifier}:{user}"
        cursor, count = None, 0
        while True:
            after = ",after:" + json.dumps(cursor) if cursor else ""
            q = f"query {{ search(type:ISSUE,query:{json.dumps(query)},first:100{after}) {{ issueCount nodes {{ ... on PullRequest {{ id number }} }} {PAGE} }} }}"
            conn = api(q)["search"]
            if conn["issueCount"] > 1000:
                raise RuntimeError(
                    f"Search exceeds GitHub's 1000-result limit: {query}. Partition the search by date before retrying."
                )
            for pr in conn["nodes"]:
                if "number" not in pr:
                    raise RuntimeError("Unexpected non-PR search result")
                records[pr["number"]] = pr
                count += 1
            if not conn["pageInfo"]["hasNextPage"]:
                break
            cursor = conn["pageInfo"]["endCursor"]
        queries.append({"query": query, "count": count})
        print(f"{qualifier}: {count} matches", flush=True)
    return {"queries": queries, "candidates": list(records.values())}


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user", help="Override github_user in config.local.toml")
    args = parser.parse_args()
    result = discover("vllm-project/vllm", github_user(root, args.user))
    path = root / "results/search-index.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, indent=2))
    print(f"{len(result['candidates'])} unique candidate PRs")
