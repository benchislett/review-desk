"""Synthetic PRs for browser checks; no account or network needed."""

import copy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from build import load_bundle, render_html
from classify import classify
from velocity import normalize
from workflows import write_json

USER = "test-reviewer"


def write_browser_fixture(root):
    """Exercise real classification and rendering with a small, varied queue."""
    root = Path(root)
    raws = []
    for number in range(1, 8):
        item = pr()
        item.update(
            id=f"fixture-{number}",
            state="OPEN",
            number=number,
            title=f"Example change {number}",
            url=f"https://github.com/vllm-project/vllm/pull/{number}",
        )
        item["labels"]["nodes"] = [{"name": "example"}]
        raws.append(item)
    mine, reply, commit, inline, draft, approved, assigned = raws
    reply["author"]["name"] = "Jórdán Example"
    reply["title"] = "Improve cache scheduling"
    mine["author"] = {"login": USER}
    mine["comments"]["nodes"] = [
        event(USER, 2, "Ready for review"),
        event("contributor", 7, f"@{USER} please check this"),
    ]
    reply["reviews"]["nodes"] = [
        event(USER, 2, "Please simplify", submittedAt="2026-10-02T12:00:00Z", state="COMMENTED")
    ]
    reply["comments"]["nodes"] = [event("author", 4, "Updated as requested")]
    commit["reviews"]["nodes"] = copy.deepcopy(reply["reviews"]["nodes"])
    commit["commits"]["nodes"] = [
        {
            "commit": {
                "oid": "a" * 40,
                "message": "Handle empty inputs\n\nReturn an empty result.",
                "messageHeadline": "Handle empty inputs",
                "messageBody": "Return an empty result.",
                "committedDate": "2026-10-06T12:00:00Z",
                "url": commit["url"] + "/commits/" + "a" * 40,
                "author": {"name": "Example Contributor", "user": {"login": "author"}},
            }
        }
    ]
    parent = event(USER, 2, "Could you add a bounds check?", path="example.py", line=12)
    response = event(
        "author",
        7,
        f"@{USER} added the check",
        path="example.py",
        line=12,
        originalLine=10,
        diffHunk="@@ -10 +12 @@\n+if index < len(items):",
        replyTo={"id": parent["id"]},
    )
    inline["reviewThreads"]["nodes"] = [{"id": "fixture-thread", **thread(parent, response)}]
    draft["isDraft"] = True
    draft["reviewRequests"]["nodes"] = [{"requestedReviewer": {"login": USER}}]
    approved["reviews"]["nodes"] = [
        event(USER, 6, "Looks good", submittedAt="2026-10-06T12:00:00Z", state="APPROVED")
    ]
    assigned["assignees"]["nodes"] = [{"login": USER}]

    snapshot = {
        "user": USER,
        "done": True,
        "startedAt": "2026-10-08T12:00:00Z",
        "completedAt": "2026-10-08T12:01:00Z",
        "collectionMode": "targeted",
        "scannedCount": len(raws),
        "candidateCount": len(raws),
        "queries": [],
    }
    write_json(
        root / "results/snapshot.json",
        {
            **snapshot,
            "repo": "vllm-project/vllm",
            "pullRequests": [classify(item, USER) for item in raws],
        },
    )
    flash = [copy.deepcopy(mine), copy.deepcopy(reply)]
    for item in flash:
        item["url"] = item["url"].replace("vllm-project/vllm", "flashinfer-ai/flashinfer")
        item["comments"]["nodes"] = [event(USER, 2, "Happy to help")]
    write_json(
        root / "results/flashinfer/snapshot.json",
        {
            **snapshot,
            "repo": "flashinfer-ai/flashinfer",
            "poolScope": "authored-commented",
            "collectionMode": "participation",
            "scannedCount": len(flash),
            "pullRequests": [classify(item, USER, include_commented=True) for item in flash],
        },
    )
    reviews = normalize(raws, USER, "UTC")
    write_json(
        root / "results/velocity.json",
        {
            **snapshot,
            "repo": "vllm-project/vllm",
            "timezone": "UTC",
            "today": "2026-10-08",
            "reviews": reviews,
            "candidateCount": len({r["number"] for r in reviews}),
        },
    )
    (root / "index.html").write_text(render_html(load_bundle(root), ROOT))


def event(who, day, body="", **kw):
    at = f"2026-10-{day:02}T12:00:00Z"
    return dict(
        id=f"{who}-{day}-{body}",
        body=body,
        createdAt=at,
        updatedAt=at,
        url="https://github.com/vllm-project/vllm/pull/1#comment",
        author={"login": who},
        **kw,
    )


def pr():
    p = dict(
        number=1,
        title="Example",
        body="",
        url="https://github.com/vllm-project/vllm/pull/1",
        createdAt="2026-10-01T12:00:00Z",
        updatedAt="2026-10-03T12:00:00Z",
        isDraft=False,
        reviewDecision=None,
        additions=1,
        deletions=0,
        changedFiles=1,
        author={"login": "author"},
    )
    for f in [
        "comments",
        "reviews",
        "reviewThreads",
        "reviewRequests",
        "assignees",
        "timelineItems",
        "commits",
        "labels",
    ]:
        p[f] = {"nodes": []}
    return p


def thread(*comments, resolved=False):
    return {"isResolved": resolved, "isOutdated": False, "comments": {"nodes": list(comments)}}


if __name__ == "__main__":
    write_browser_fixture(Path(sys.argv[1]))
