"""Central bot policy shared by queue classification and velocity."""

import json
from pathlib import Path

CONFIG = json.loads((Path(__file__).resolve().parents[1] / "bots.json").read_text())
LOGINS = {login.lower() for login in CONFIG["logins"]}


def is_bot(actor):
    actor = actor or {}
    login = (actor.get("login") or "").lower()
    return (
        actor.get("__typename") == "Bot"
        or actor.get("type", "").lower() == "bot"
        or login.endswith("[bot]")
        or login in LOGINS
    )


def is_ci_trigger(body):
    """CI command comments are automation controls, not review conversation."""
    return (body or "").lstrip().lower().startswith("/ci")
