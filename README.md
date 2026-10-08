# Review Desk

## Author Note

This is a simple webapp I vibe-coded to help me stay on top of code review for vllm-project/vllm, where I am a core maintainer.

Please do not contribute to this repo. This is strictly a reference work. Please fork, make it your own, and enjoy. I will not be addressing any issues or PRs opened against this repo.

It is extremely straightforward to modify this project with the help of a coding agent. Just ask for what you want. Enjoy!

**The rest of this README.md is AI-generated.**

## Overview

A local dashboard for managing GitHub code review work. Review Desk groups PRs by
who needs to act, gives unanswered mentions priority, and tracks formal review
activity over time.

The current workspaces are **vLLM** (authored, assigned, requested, reviewed, or
mentioned PRs) and **FlashInfer** (authored or commented-on PRs). All GitHub
operations are read-only. Reviews and merges happen on GitHub.

- Action queues with searchable PRs, detailed discussion previews, and dismissals
  that expire when new activity arrives.
- **My PRs**, **Approved**, and **Ready to merge** views.
- Daily, weekly, and monthly review velocity, including formal Comment reviews.
- Shared global refresh progress, per-PR refresh, and refresh after returning from
  an explicitly opened PR link.
- API usage display and a shared switch to freeze every refresh trigger.
- Bot and `/ci` command exclusion from discussion activity.

## Quick start

Requires Python 3.12+ and the [GitHub CLI](https://cli.github.com/). The backend uses
only the Python standard library; the browser has no runtime dependencies.

From the repository root:

```sh
cp -n config.example.toml config.local.toml
# Edit config.local.toml: set your GitHub login and preferred timezone.

gh auth login
python3 scripts/refresh.py
python3 scripts/server.py
```

Open **http://localhost:8765/**. Initial collection uses targeted searches, not a
repository-wide crawl. If local snapshots already exist, you can start the server
without running a refresh.

## Credentials and local state

To use a dedicated token instead of your `gh` login:

```sh
cp -n tokens.example.sh tokens.local.sh
chmod 600 tokens.local.sh
# Edit tokens.local.sh and set the literal GH_TOKEN value.
```

The app reads this file automatically. It supports literal `GH_TOKEN` or
`GITHUB_TOKEN` assignments with an optional `export`; it never executes the shell
file. Explicit environment credentials override the local file. An installed
systemd credential takes precedence over both.

These files stay local and are ignored by Git:

| Path | Contents |
| --- | --- |
| `tokens.local.sh` | GitHub credential; owner-only permissions required |
| `config.local.toml` | GitHub login and review timezone |
| `results/` | PR snapshots, review history, dismissals, refresh reports |
| `.tmp/` | Refresh settings, caches, API telemetry, logs, browser artifacts |
| `index.html` | Optional generated offline export |

The HTTP server exposes explicit application routes only. Credentials never enter
the page or its data endpoints. It is designed for one user's trusted local
network and has no user login layer.

## Run as a service

On Linux with systemd, install a service on port 80:

```sh
sudo /usr/bin/python3 scripts/install_service.py
```

The service runs from this checkout as your ordinary account, starts at boot, and
restarts after exiting. The installer copies the local token into a protected
systemd credential; `tokens.local.sh` stays available for future updates.

See [service setup](docs/service.md) for credential handling, editing, relocation,
and uninstalling. Preview the generated unit with
`python3 scripts/install_service.py --print-unit`.

## Working with the dashboard

Use **Refresh all** or an item's refresh button while the server is running.
`python3 scripts/refresh.py` also joins the shared backend queue. Browser sessions
share progress, dismissals, and the freeze control.

Frontend edits appear after a browser reload. Python backend edits need a restart;
there is no automatic file watcher. With the system service installed, run
`python3 scripts/restart_service.py`. For a manually started server, stop it and
rerun `python3 scripts/server.py`.

Use `python3 scripts/build.py` to produce a standalone offline `index.html`. Its
refresh controls are disabled. The low-level collectors should only be run with
the backend stopped.

[Queue rules and data limitations](docs/behavior.md) explain what counts as a
response, review, approval, or merge-ready PR.

## Development

See [development and code layout](docs/development.md) for formatting and browser
checks. Those checks use synthetic PRs, need no GitHub credentials, and make no
GitHub API calls.

This project is released under the [Unlicense](LICENSE).
