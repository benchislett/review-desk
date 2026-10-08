"""Persistent local bookmarks, independent of activity-based priority."""


def pin_key(workspace, pr):
    return f"{workspace['repo']}:{workspace['user'].lower()}:{pr['number']}"


def apply_pins(bundle, pins):
    """Decorate a prepared bundle; pins never add PRs outside its indexed pool."""
    for workspace in bundle["workspaces"].values():
        for pr in workspace["pullRequests"]:
            saved = pins.get(pin_key(workspace, pr))
            pr["pinned"] = saved is not None
            pr["pinnedAt"] = saved.get("pinnedAt") if saved else None
    return bundle
