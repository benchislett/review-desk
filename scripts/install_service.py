#!/usr/bin/env python3
"""Install/enable Review Desk on port 80. Run once with sudo; safe to rerun."""

import argparse
import json
import os
import pwd
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.request import urlopen

from credentials import read_local_token

ROOT = Path(__file__).resolve().parents[1]
UNIT = "review-desk.service"


def unit_literal(value):
    value = str(value)
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError("Unsupported control character in service configuration")
    if value != value.strip() or value.endswith("\\"):
        raise ValueError(
            "Unsupported trailing escape or surrounding whitespace in service configuration"
        )
    return value.replace("%", "%%")


def unit_quote(value):
    # ExecStart uses shell-like word parsing and expands dollars. User and
    # WorkingDirectory use literal values (with systemd percent specifiers).
    value = unit_literal(value).replace("\\", "\\\\").replace('"', '\\"').replace("$", "$$")
    return '"' + value + '"'


def render_service(root, user, python="/usr/bin/python3"):
    root = Path(root).resolve()
    template = (ROOT / "deploy" / f"{UNIT}.in").read_text()
    values = {
        "@USER@": unit_literal(user),
        "@ROOT@": unit_literal(root),
        "@PYTHON@": unit_quote(python),
        "@SERVER@": unit_quote(root / "scripts/server.py"),
    }
    return re.sub(r"@(?:USER|ROOT|PYTHON|SERVER)@", lambda match: values[match.group()], template)


def install(account, source):
    subprocess.run(["systemd-analyze", "verify", str(source)], check=True)
    # Check the existing server before changing or stopping anything.
    address = ROOT / ".tmp/server/address.json"
    previous = None
    if address.exists():
        candidate = json.loads(address.read_text())
        pid = candidate["pid"]
        proc = Path(f"/proc/{pid}")
        if proc.exists():
            argv = proc.joinpath("cmdline").read_bytes().split(b"\0")
            script = Path(os.fsdecode(argv[1])) if len(argv) > 1 and argv[1] else None
            if script is not None:
                if not script.is_absolute():
                    script = proc / "cwd" / script
                script = script.resolve()
            if (
                proc.stat().st_uid != account.pw_uid
                or script != (ROOT / "scripts/server.py").resolve()
            ):
                raise SystemExit(
                    "The recorded PID is not this user's Review Desk backend; refusing to stop it."
                )
            with urlopen(f"http://127.0.0.1:{candidate['port']}/api/status", timeout=5) as response:
                status = json.load(response)
            if status["active"] or status["queued"]:
                raise SystemExit(
                    "A refresh is running or queued. Let it finish, then rerun this installer."
                )
            previous = candidate
    if not previous or previous["port"] != 80:
        with socket.socket() as probe:
            try:
                probe.bind(("0.0.0.0", 80))
            except OSError:
                raise SystemExit("Port 80 is already in use; the existing server was left running.")
    # Parse literal assignments only: never execute a user shell file as root.
    credential_dir = Path("/etc/review-desk")
    credential = credential_dir / "github-token"
    token = read_local_token(ROOT, owner_uid=account.pw_uid)
    if not token and not credential.exists():
        env = {
            **os.environ,
            "DBUS_SESSION_BUS_ADDRESS": f"unix:path=/run/user/{account.pw_uid}/bus",
            "XDG_RUNTIME_DIR": f"/run/user/{account.pw_uid}",
        }
        try:
            result = subprocess.run(
                [
                    "/usr/sbin/runuser",
                    "--user",
                    account.pw_name,
                    "--",
                    "/usr/bin/gh",
                    "auth",
                    "token",
                    "--hostname",
                    "github.com",
                ],
                env=env,
                capture_output=True,
                text=True,
                timeout=15,
            )
            token = result.stdout.strip() if result.returncode == 0 else ""
        except subprocess.TimeoutExpired:
            pass
        if not token:
            raise SystemExit(
                "No service credential is available. Configure tokens.local.sh or unlock the gh keyring, then rerun."
            )
    if token:
        credential_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        credential_dir.chmod(0o700)
        os.chown(credential_dir, 0, 0)
        temporary = credential_dir / "github-token.new"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as stream:
            os.fchmod(stream.fileno(), 0o600)
            os.fchown(stream.fileno(), 0, 0)
            stream.write(token + "\n")
        temporary.replace(credential)
    subprocess.run(
        [
            "install",
            "-o",
            "root",
            "-g",
            "root",
            "-m",
            "0644",
            str(source),
            "/etc/systemd/system/" + UNIT,
        ],
        check=True,
    )
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    if previous:
        manager_pid = subprocess.run(
            ["systemctl", "show", UNIT, "--property=MainPID", "--value"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        if manager_pid == str(previous["pid"]):
            subprocess.run(["systemctl", "stop", UNIT], check=True)
        else:
            os.kill(previous["pid"], signal.SIGINT)
        for _ in range(150):
            if not address.exists():
                break
            time.sleep(0.1)
        if address.exists():
            raise SystemExit(
                "Previous backend has not finished stopping; rerun once it has stopped."
            )
    subprocess.run(["systemctl", "enable", UNIT], check=True)
    subprocess.run(["systemctl", "restart", UNIT], check=True)
    for _ in range(50):
        try:
            with urlopen("http://127.0.0.1/api/status", timeout=2) as response:
                json.load(response)
            break
        except OSError:
            time.sleep(0.2)
    else:
        raise SystemExit(
            "Service did not become ready. Inspect: sudo journalctl -u review-desk -n 50"
        )
    print("Review Desk is running on port 80 and enabled at boot.")
    print(f"Open http://{socket.gethostname()}/ using your existing intranet addressing.")
    print("GitHub credentials stay in a root-only credential file, loaded privately by systemd.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--user",
        default=os.environ.get("SUDO_USER") or pwd.getpwuid(ROOT.stat().st_uid).pw_name,
        help="Unprivileged account that runs the service; defaults to the sudo caller or checkout owner",
    )
    parser.add_argument(
        "--print-unit",
        action="store_true",
        help="Print the generated service without installing it",
    )
    args = parser.parse_args()
    account = pwd.getpwnam(args.user)
    if account.pw_uid == 0:
        raise SystemExit("Choose an unprivileged service account with --user.")
    unit = render_service(ROOT, account.pw_name, sys.executable)
    if args.print_unit:
        print(unit, end="")
        return
    if os.geteuid() != 0:
        raise SystemExit("Run this installer with sudo.")
    staging = ROOT / ".tmp"
    if not staging.exists():
        staging.mkdir()
        os.chown(staging, account.pw_uid, account.pw_gid)
    with tempfile.TemporaryDirectory(prefix="service-", dir=staging) as directory:
        source = Path(directory) / UNIT
        source.write_text(unit)
        install(account, source)


if __name__ == "__main__":
    main()
