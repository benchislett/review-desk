"""Conservative merge readiness, independent of discussion priority."""

from bots import is_bot

REVIEW_STATES = {"COMMENTED", "APPROVED", "CHANGES_REQUESTED", "DISMISSED"}


def readiness(pr, user):
    def login(actor):
        return ((actor or {}).get("login") or "").lower()

    user = user.lower()
    author = login(pr.get("author"))
    reviewed = any(
        login(r.get("author")) == user
        and not is_bot(r.get("author"))
        and r.get("submittedAt")
        and r.get("state") in REVIEW_STATES
        for r in pr["reviews"]["nodes"]
    )
    eligible = author == user or reviewed
    latest = pr.get("latestOpinionatedReviews")
    known = (
        all(
            k in pr
            for k in (
                "mergeable",
                "mergeStateStatus",
                "statusCheckRollup",
                "isInMergeQueue",
                "isMergeQueueEnabled",
            )
        )
        and latest is not None
    )
    # GitHub supplies current opinionated reviews, restricted to repository writers.
    approvals = []
    for review in (latest or {}).get("nodes", []):
        who = login(review.get("author"))
        if (
            who
            and who != author
            and not is_bot(review.get("author"))
            and review.get("state") == "APPROVED"
            and review.get("submittedAt")
            and review.get("authorCanPushToRepository") is True
        ):
            approvals.append({"author": who, "at": review["submittedAt"], "url": review["url"]})
    approvals = sorted({r["author"]: r for r in approvals}.values(), key=lambda r: r["author"])
    head = pr.get("statusCheckRollup")
    merge = (pr.get("potentialMergeCommit") or {}).get("statusCheckRollup")
    rollups = [r for r in [head, merge] if r is not None]
    counts = [(r.get("contexts") or {}).get("totalCount") for r in rollups]
    complete = all(type(n) is int and n >= 0 for n in counts)
    count = sum(counts) if complete else 0
    checks_passed = (
        bool(rollups)
        and complete
        and count > 0
        and all(r.get("state") == "SUCCESS" for r in rollups)
    )
    blockers = []
    if not eligible:
        blockers.append("Only PRs you authored or formally reviewed qualify.")
    if pr.get("state") != "OPEN":
        blockers.append("PR is not open.")
    if pr.get("isDraft"):
        blockers.append("PR is a draft.")
    if not known:
        blockers.append("Refresh this PR to check merge readiness.")
    else:
        if not approvals:
            blockers.append("Approval from a maintainer with write access is needed.")
        if pr.get("reviewDecision") not in (None, "APPROVED"):
            blockers.append("GitHub review requirements are not satisfied.")
        if not checks_passed:
            states = {r.get("state") for r in rollups}
            blockers.append(
                "Checks are failing."
                if states & {"ERROR", "FAILURE"}
                else "Checks are still running or pending."
                if "PENDING" in states
                else "No complete passing check results yet."
            )
        if pr.get("isInMergeQueue") or pr.get("isMergeQueueEnabled"):
            blockers.append("A merge queue is required or already in progress.")
        if pr.get("mergeable") != "MERGEABLE" or pr.get("mergeStateStatus") != "CLEAN":
            state = pr.get("mergeStateStatus")
            blockers.append(
                {
                    "BEHIND": "Branch needs to be updated.",
                    "DIRTY": "Merge conflicts need to be resolved.",
                    "BLOCKED": "GitHub reports the merge is blocked.",
                    "UNKNOWN": "GitHub is still computing mergeability.",
                }.get(state, "GitHub has not confirmed a clean merge.")
            )
    ready = not blockers
    return {
        "ready": ready,
        "eligible": eligible,
        "reviewedByMe": reviewed,
        "known": known,
        "approvals": approvals,
        "checksPassed": checks_passed,
        "checkCount": count,
        "headChecksState": (head or {}).get("state"),
        "mergeChecksState": (merge or {}).get("state"),
        "mergeState": pr.get("mergeStateStatus"),
        "headOid": pr.get("headRefOid"),
        "blockers": blockers,
        "summary": f"Approved by {', '.join('@' + r['author'] for r in approvals)} · {count} check results passed."
        if ready
        else " ".join(blockers),
    }
