"""Local dismissals tied to the activity that the user actually saw."""

import copy
import datetime as dt
import hashlib
import json

from bots import is_bot, is_ci_trigger


def activity_version(pr, *, include_requests=True):
    """Ignore refresh times, CI/labels/counts, and bot-only discussion changes."""

    def event(e):
        return {k: e.get(k) for k in ("id", "kind", "at", "author", "body", "state", "resolved")}

    human = [
        event(e)
        for e in pr.get("events", [])
        if not e.get("isBot")
        and not is_bot({"login": e.get("author", "")})
        and not is_ci_trigger(e.get("body"))
    ]
    human.sort(key=lambda e: (e.get("at") or "", e.get("id") or ""))
    evidence = {k: pr.get(k) for k in ("queue", "requested", "assigned", "isDraft")}
    evidence.update(trigger=event(pr.get("trigger") or {}), events=human)
    if include_requests:
        evidence.update(
            requestActivityAt=pr.get("requestActivityAt"), activityAt=pr.get("activityAt")
        )
    return hashlib.sha256(
        json.dumps(evidence, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def dismissal_key(workspace, pr):
    return f"{workspace['repo']}:{workspace['user'].lower()}:{pr['number']}"


def dismissal_record(workspace, pr):
    # Older snapshots did not retain request timestamps. Their capture time is
    # the migration baseline; adding old timeline metadata must not undo a choice.
    observed = pr.get("refreshedAt") or workspace.get("completedAt") or pr["activityAt"]
    return {
        "evidenceVersion": activity_version(pr, include_requests=False),
        "activityAt": pr["activityAt"],
        "requestActivityAt": pr.get("requestActivityAt", observed),
        "dismissedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
    }


def timestamp(value):
    return (
        dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if value
        else dt.datetime.min.replace(tzinfo=dt.timezone.utc)
    )


def apply_dismissals(bundle, dismissals):
    """Return an independent display bundle and only still-applicable dismissals."""
    result = copy.deepcopy(bundle)
    retained = {}
    for workspace in result["workspaces"].values():
        for pr in workspace["pullRequests"]:
            version = activity_version(pr)
            pr["activityVersion"] = version
            key = dismissal_key(workspace, pr)
            saved = dismissals.get(key)
            if not saved or saved.get("evidenceVersion") != activity_version(
                pr, include_requests=False
            ):
                continue
            if timestamp(pr.get("requestActivityAt")) > timestamp(saved.get("requestActivityAt")):
                continue
            if timestamp(pr.get("activityAt")) > timestamp(saved.get("activityAt")):
                continue
            retained[key] = saved
            pr["dismissal"] = {
                "dismissedAt": saved["dismissedAt"],
                "automaticQueue": pr["queue"],
                "automaticReason": pr["reason"],
                "automaticResponsibility": pr["responsibility"],
            }
            pr.update(
                queue="watching",
                responsibility="No action for now",
                confidence="manual",
                reason="Current activity dismissed. New activity restores automatic priority.",
            )
    return result, retained
