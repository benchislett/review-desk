"""Local account preferences. Repository scopes stay explicit in each collector."""

import re
import tomllib
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]


def load_settings(root=ROOT):
    path = Path(root) / "config.local.toml"
    if not path.exists():
        return {}
    with path.open("rb") as stream:
        return tomllib.load(stream)


def github_user(root=ROOT, override=None):
    user = override or load_settings(root).get("github_user")
    if not isinstance(user, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}", user):
        raise ValueError("Set github_user in config.local.toml or pass --user YOUR_LOGIN.")
    if user == "your-github-login":
        raise ValueError("Replace the example github_user in config.local.toml with your login.")
    return user


def review_timezone(root=ROOT, override=None):
    name = override or load_settings(root).get("timezone", "UTC")
    ZoneInfo(name)
    return name
