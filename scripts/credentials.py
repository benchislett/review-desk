"""Load GitHub credentials without executing shell files or exposing token values."""

import os
import re
import shlex
import stat
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOKEN_NAMES = {"GH_TOKEN", "GITHUB_TOKEN"}


def read_local_token(root=ROOT, *, owner_uid=None):
    """Read a private, literal-only tokens.local.sh; never source it as root."""
    path = Path(root) / "tokens.local.sh"
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return ""
    except OSError:
        raise ValueError("Cannot safely open tokens.local.sh; use a regular file.") from None
    with os.fdopen(fd) as stream:
        metadata = os.fstat(stream.fileno())
        expected_uid = os.getuid() if owner_uid is None else owner_uid
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != expected_uid:
            raise ValueError("tokens.local.sh must be a regular file owned by the app user.")
        if metadata.st_mode & 0o077:
            raise ValueError("tokens.local.sh must be private: chmod 600 tokens.local.sh")
        tokens = {}
        for number, line in enumerate(stream, start=1):
            try:
                words = shlex.split(line, comments=True, posix=True)
            except ValueError:
                raise ValueError(
                    f"Invalid token assignment on line {number} of tokens.local.sh."
                ) from None
            if words[:1] == ["export"]:
                words = words[1:]
            if not words:
                continue
            name, separator, value = words[0].partition("=")
            if len(words) != 1 or not separator or name not in TOKEN_NAMES:
                raise ValueError(
                    f"Expected a literal GH_TOKEN assignment on line {number} of tokens.local.sh."
                )
            if value and not re.fullmatch(r"[A-Za-z0-9_]+", value):
                raise ValueError(f"Invalid token value on line {number} of tokens.local.sh.")
            if name in tokens:
                raise ValueError(f"Duplicate token assignment on line {number} of tokens.local.sh.")
            tokens[name] = value
    return tokens.get("GH_TOKEN") or tokens.get("GITHUB_TOKEN", "")


def github_environment(root=ROOT):
    """Priority: systemd credential, explicit environment, local file, gh login."""
    env = os.environ.copy()
    directory = env.get("CREDENTIALS_DIRECTORY")
    if directory:
        token = (Path(directory) / "github-token").read_text().strip()
        if not token:
            raise ValueError("The GitHub service credential is empty.")
        env["GH_TOKEN"] = token
    elif not (env.get("GH_TOKEN") or env.get("GITHUB_TOKEN")):
        token = read_local_token(root)
        if token:
            env["GH_TOKEN"] = token
    return env
