"""Deterministic queue rules; GitHub is the evidence, responsibility is a heuristic."""

import re

from bots import is_bot, is_ci_trigger
from readiness import readiness

QUEUES = [
    (
        "direct",
        "Unanswered mentions",
        "Someone @mentioned you in a comment or review, and you have not responded anywhere on the PR since.",
    ),
    (
        "feedback",
        "My PRs · feedback",
        "Your PR has new human feedback or an outstanding request for changes.",
    ),
    (
        "followup",
        "Review follow-ups",
        "A thread reply, re-request, or author activity follows your earlier review.",
    ),
    ("review", "Review requested", "You are a requested reviewer. Routine requests start here."),
    ("assigned", "Assigned to me", "You are assigned, without a stronger action signal."),
    (
        "waiting",
        "Waiting on others",
        "Your PR awaits review, or you have already responded to a request.",
    ),
    (
        "watching",
        "Following",
        "Historical involvement or a description mention, without a current request.",
    ),
]


def classify(pr, user, *, include_commented=False):
    user = user.lower()
    mention = re.compile(r"(?<![\w@/])@" + re.escape(user) + r"(?![\w/-])", re.I)

    def login(obj):
        return ((obj or {}).get("login") or "").lower()

    mine = login(pr.get("author")) == user
    own = []
    events = []
    for field, kind in [("comments", "comment"), ("reviews", "review")]:
        for e in pr[field]["nodes"]:
            if kind == "review" and (not e.get("submittedAt") or e.get("state") == "PENDING"):
                continue
            if is_bot(e.get("author")) or is_ci_trigger(e.get("body")):
                continue
            events.append(
                {
                    "id": e["id"],
                    "author": login(e.get("author")),
                    "body": e.get("body") or "",
                    "at": e.get("submittedAt") or e["createdAt"],
                    "url": e["url"],
                    "kind": kind,
                    "isBot": (e.get("author") or {}).get("__typename") == "Bot"
                    or login(e.get("author")).endswith("[bot]"),
                    "state": e.get("state"),
                    "editedAt": e.get("updatedAt"),
                }
            )
    reply_ids = set()
    for thread in pr["reviewThreads"]["nodes"]:
        seen_own = False
        for e in sorted(thread["comments"]["nodes"], key=lambda c: c["createdAt"]):
            author = login(e.get("author"))
            if is_bot(e.get("author")) or is_ci_trigger(e.get("body")):
                continue
            if seen_own and author != user and not thread["isResolved"]:
                reply_ids.add(e["id"])
            seen_own |= author == user
            events.append(
                {
                    "id": e["id"],
                    "author": author,
                    "body": e.get("body") or "",
                    "at": e["createdAt"],
                    "url": e["url"],
                    "kind": "inline",
                    "threadId": thread.get("id"),
                    "path": e.get("path"),
                    "line": e.get("line"),
                    "originalLine": e.get("originalLine"),
                    "diffHunk": e.get("diffHunk"),
                    "replyToId": (e.get("replyTo") or {}).get("id"),
                    "isBot": (e.get("author") or {}).get("__typename") == "Bot"
                    or author.endswith("[bot]"),
                    "resolved": thread["isResolved"],
                    "outdated": thread["isOutdated"],
                    "editedAt": e.get("updatedAt"),
                }
            )
    events.sort(key=lambda e: (e["at"], e["id"]))
    own = [e for e in events if e["author"] == user]
    last_own = own[-1]["at"] if own else ""
    tagged = [e for e in events if e["author"] != user and mention.search(e["body"])]
    requested = any(
        login(r.get("requestedReviewer")) == user for r in pr["reviewRequests"]["nodes"]
    )
    assigned = any(login(a) == user for a in pr["assignees"]["nodes"])
    history = [e for e in pr["timelineItems"]["nodes"] if e is not None]
    requests = [
        e
        for e in history
        if e.get("__typename") == "ReviewRequestedEvent"
        and login(e.get("requestedReviewer")) == user
    ]
    assignments = [
        e
        for e in history
        if e.get("__typename") == "AssignedEvent" and login(e.get("assignee")) == user
    ]
    my_reviews = [e for e in own if e["kind"] == "review"]
    reasons = []
    if mine:
        reasons.append("Author")
    if include_commented and any(
        e["kind"] in ("comment", "inline") or e["body"].strip() for e in own
    ):
        reasons.append("Commenter")
    formally_reviewed = any(
        login(r.get("author")) == user
        and not is_bot(r.get("author"))
        and r.get("submittedAt")
        and r.get("state") != "PENDING"
        for r in pr["reviews"]["nodes"]
    )
    if requested or requests or formally_reviewed:
        reasons.append("Reviewer")
    if assigned or assignments:
        reasons.append("Assignee")
    if mention.search(pr.get("body") or ""):
        reasons.append("Description mention")
    if tagged:
        reasons.append("Comment mention")
    # Membership is historical: retain previously verified involvement even if
    # a request/mention is removed or GitHub omits an old timeline event.
    for old_reason in pr.get("historicalReasons", []):
        if (
            old_reason in ("Reviewer", "Assignee", "Description mention")
            and old_reason not in reasons
        ):
            reasons.append(old_reason)
    if not reasons:
        return None
    base = {
        "at": pr["createdAt"],
        "url": pr["url"],
        "body": "",
        "author": login(pr.get("author")),
        "kind": "description",
    }
    trigger = base
    queue, responsibility, reason, confidence = (
        "watching",
        "Unclear",
        "No outstanding request detected from your recorded involvement.",
        "inferred",
    )
    unanswered = [e for e in tagged if e["at"] > last_own]
    human = [
        e
        for e in events
        if e["author"] != user and e["author"] and not e.get("isBot") and e["at"] > last_own
    ]
    review_states = {}
    for e in events:
        if e["kind"] == "review" and e["state"] in ("APPROVED", "CHANGES_REQUESTED", "DISMISSED"):
            review_states[e["author"]] = e
    changes = [
        e
        for e in review_states.values()
        if e["state"] == "CHANGES_REQUESTED" and e["author"] != user
    ]
    replies = [e for e in events if e["id"] in reply_ids and e["at"] > last_own]
    rerequests = [
        e
        for e in requests
        if not is_bot(e.get("actor"))
        and requested
        and my_reviews
        and e["createdAt"] > max(last_own, my_reviews[-1]["at"])
    ]
    author_activity = [
        e for e in events if e["author"] == login(pr.get("author")) and e["at"] > last_own
    ]
    commits = pr["commits"]["nodes"]
    commit = commits[-1]["commit"] if commits else None
    if commit and (
        is_bot((commit.get("author") or {}).get("user"))
        or is_bot({"login": (commit.get("author") or {}).get("name", "")})
    ):
        commit = None
    commit_by_me = bool(commit and login((commit.get("author") or {}).get("user")) == user)
    changed_since = bool(
        my_reviews
        and commit
        and not commit_by_me
        and commit["committedDate"] > max(last_own, my_reviews[-1]["at"])
    )
    if unanswered:
        queue, responsibility, confidence = "direct", "You", "explicit"
        trigger = unanswered[-1]
        reason = f"@{trigger['author'] or 'deleted-user'} mentioned you in a {trigger['kind']}; no later comment or submitted review from you anywhere on this PR."
    elif mine and (human or changes):
        queue, responsibility = "feedback", "You"
        trigger = (changes if changes else human)[-1]
        reason = (
            "A reviewer still requests changes. A comment alone does not clear that review decision."
            if changes
            else "New human feedback on your PR since your last response; inspect it to decide whether action is needed."
        )
    elif (
        not mine
        and not pr["isDraft"]
        and (replies or rerequests or (my_reviews and (author_activity or changed_since)))
    ):
        queue, responsibility = "followup", "You"
        if replies:
            trigger = replies[-1]
            reason = "New reply in an unresolved thread you participated in, after your last response anywhere on the PR."
        elif rerequests:
            event = rerequests[-1]
            trigger = {
                **base,
                "at": event["createdAt"],
                "kind": "review request",
                "author": login(event.get("actor")),
            }
            reason = "Your review was requested again after your previous review."
            confidence = "explicit"
        elif author_activity:
            trigger = author_activity[-1]
            reason = "The author responded after your review and last comment. Another look may be needed."
        else:
            trigger = {
                **base,
                "at": commit["committedDate"],
                "url": commit["url"],
                "kind": "commit",
                "body": commit.get("message") or "",
                "commit": commit,
                "author": login((commit.get("author") or {}).get("user"))
                or (commit.get("author") or {}).get("name")
                or "",
            }
            reason = "The head commit is newer than your last response. Changes may need another review (inferred from commit time)."
    elif requested and not pr["isDraft"] and not mine:
        queue, responsibility, confidence = "review", "You", "explicit"
        reason = "You are currently a requested reviewer; no stronger follow-up signal was found."
        if requests:
            trigger = {
                **base,
                "at": requests[-1]["createdAt"],
                "kind": "review request",
                "author": login(requests[-1].get("actor")),
            }
    elif assigned and not mine and not pr["isDraft"]:
        queue, responsibility, confidence = "assigned", "You", "explicit"
        reason = "You are currently assigned; the specific next step is not known."
        if assignments:
            trigger = {
                **base,
                "at": assignments[-1]["createdAt"],
                "kind": "assignment",
                "author": login(assignments[-1].get("actor")),
            }
    elif mine:
        queue, responsibility = ("watching", "You") if pr["isDraft"] else ("waiting", "Reviewers")
        reason = (
            "Your draft is still in progress."
            if pr["isDraft"]
            else "No new feedback detected; waiting for review or merge. This does not verify CI or merge readiness."
        )
    elif own:
        queue, responsibility = "waiting", "Author / others"
        trigger = own[-1]
        reason = "You have responded and no stronger outstanding signal was found. Responsibility is inferred."
    elif pr["isDraft"]:
        reason = "Draft PR: routine review and assignment signals are deferred until it is ready."
    result = {
        k: pr[k]
        for k in (
            "number",
            "title",
            "url",
            "createdAt",
            "updatedAt",
            "isDraft",
            "reviewDecision",
            "additions",
            "deletions",
            "changedFiles",
        )
    }
    result.update(
        id=pr.get("id"),
        author=login(pr.get("author")),
        body=pr.get("body") or "",
        mine=mine,
        queue=queue,
        responsibility=responsibility,
        reason=reason,
        confidence=confidence,
        trigger=trigger,
        lastResponse=own[-1] if own else None,
        reasons=reasons,
        labels=[label["name"] for label in pr["labels"]["nodes"]],
        activityAt=max(
            [pr["createdAt"]]
            + [e["at"] for e in events]
            + ([commit["committedDate"]] if commit else [])
        ),
        events=events,
        requested=requested,
        assigned=assigned,
        unansweredMentions=len(unanswered),
        requestActivityAt=max(
            [e["createdAt"] for e in requests + assignments if not is_bot(e.get("actor"))],
            default="",
        ),
    )
    result["readiness"] = readiness(pr, user)
    result["ready"] = result["readiness"]["ready"]
    result["reviewedByMe"] = result["readiness"]["reviewedByMe"]
    return result
