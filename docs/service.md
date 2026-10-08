# Service setup

Run these commands from the checkout you want to serve. First follow the README
to configure the account and collect initial snapshots.

```sh
sudo /usr/bin/python3 scripts/install_service.py
```

The installer renders `deploy/review-desk.service.in` using the checkout's absolute
path, the Python interpreter running the installer, and the invoking user from
`SUDO_USER`. `--user ACCOUNT` selects another unprivileged service account.

It validates the unit with `systemd-analyze`, checks that port 80 is available,
and verifies any recorded backend PID before stopping it. Active or queued
refreshes cause installation to stop with a message rather than interrupting the
work. It installs `/etc/systemd/system/review-desk.service`, reloads systemd, and
enables and starts the service. Installation can be rerun to update paths or the
credential.

## Runtime

The service listens on `0.0.0.0:80`, runs as the selected user, and receives only
the `CAP_NET_BIND_SERVICE` capability needed for the privileged port. It starts
at boot, including before desktop login. Systemd restarts it five seconds after
an exit, with a limit of five starts per minute. An explicit `systemctl stop`
keeps it stopped.

```sh
systemctl status review-desk
journalctl -u review-desk -n 50
sudo systemctl stop review-desk
sudo systemctl start review-desk
```

The installer checks the local `/api/status` endpoint after starting the service.
The backend normally makes one GitHub quota request on startup; it does not
automatically re-index. Persisted freeze state also suppresses that quota request.
The installer does not configure hostnames, addresses, or firewalls.

## Credentials

The installer chooses a credential in this order:

1. A nonempty token in the checkout's `tokens.local.sh`, owned by the service user
   with no group or other permissions.
2. An existing `/etc/review-desk/github-token`, preserved on reinstall.
3. The service user's existing `gh auth token` credential, when accessible.

The local shell file is parsed as literal assignments, never sourced or executed
by the root installer. `tokens.example.sh` documents the accepted format.

The credential directory is root-owned with mode `0700`; the credential file is
root-owned with mode `0600`. The unit's `LoadCredential` setting supplies a private
runtime copy. The backend uses it for server-side `gh` subprocesses through
`GH_TOKEN`; it is absent from the generated unit and HTTP responses.

To rotate the credential, edit `tokens.local.sh` and rerun the installer. Token
expiration and revocation still apply. The service can show cached data when
GitHub authentication is unavailable.

## Editing and relocating

The service runs the working checkout directly. Reload the browser after editing
HTML, CSS, or JavaScript. For Python changes:

```sh
python3 scripts/restart_service.py
```

The helper verifies the running systemd PID belongs to you and that no refreshes
are active or queued. It sends `SIGINT`; systemd then starts a replacement. This
does not need sudo. There is no automatic code watcher.

To move the checkout:

1. Run `sudo systemctl stop review-desk`.
2. Move the whole directory, including ignored configuration and local state.
3. Run `sudo /usr/bin/python3 scripts/install_service.py` from the new directory.

The installer regenerates absolute paths. Existing snapshots, dismissals, and
credentials are preserved. A normal clone contains only source and examples;
copy local state separately if you want to preserve your existing queue.

## Uninstalling

```sh
sudo systemctl disable --now review-desk
sudo rm /etc/systemd/system/review-desk.service
sudo systemctl daemon-reload
```

The checkout and its data remain available. Remove `/etc/review-desk/github-token`
separately if you no longer need the installed credential.
