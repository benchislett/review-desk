# Development

The app has no Python package or JavaScript runtime dependencies. All commands
below run from the repository root.

## Code layout

| Location | Responsibility |
| --- | --- |
| `scripts/server.py` | Local HTTP routes, shared refresh queue, freeze state |
| `scripts/workflows.py` | Global and per-PR refresh orchestration |
| `scripts/collect.py`, `discover.py` | vLLM discovery and paginated detail reads |
| `scripts/collect_participation.py` | Restricted FlashInfer author/commenter collection |
| `scripts/classify.py`, `readiness.py`, `triage.py` | Priority, merge readiness, dismissals |
| `scripts/velocity.py` | Formal review collection and normalization |
| `scripts/credentials.py`, `settings.py` | Private authentication and local preferences |
| `scripts/build.py` | Shared data loading and HTML rendering |
| `scripts/api_runtime.py`, `api_metrics.py` | Request gate and quota telemetry |
| `scripts/refresh.py` | CLI refresh and timing reports |
| `scripts/install_service.py`, `restart_service.py` | Optional Linux systemd integration |
| `site/` | HTML template, CSS, plain JavaScript, favicon |
| `tests/` | Synthetic fixtures and browser smoke checks |

Frontend scripts share a page scope and are concatenated in a fixed order by
`build.py`. Python modules stay beside the CLI entry points in `scripts/`.
Generated state belongs in ignored `results/` or `.tmp/`, not in source files.

## Formatting

Development tools are Ruff 0.15.11 and Prettier 3.6.2. Install Ruff with your
preferred Python tool manager, for example `uv tool install ruff==0.15.11`.
`npm ci` installs the pinned formatter from `package-lock.json`.

```sh
npm ci
make format
make lint
make check-public
```

The Makefile accepts `PYTHON` and `RUFF` overrides. Node/npm are optional for
running the dashboard itself.

`check-public` checks Git-visible files and staged versions for local state and
common credential patterns. It prints filenames, never matched credential values.
It is a focused pre-commit guard rather than an exhaustive secret scanner.

## Browser checks

Requires Node 22+ and Chrome/Chromium. No GitHub account, local snapshots, or
credentials are required.

```sh
make test
# Or individually:
node tests/browser.mjs
node tests/live-browser.mjs
```

Set `CHROME_BIN` if your browser is not `/usr/bin/google-chrome`, or `PYTHON` to
select another Python interpreter. The checks run headless Chrome with a temporary
profile and its sandbox disabled, against local synthetic content only.

`fixtures.py` generates synthetic PRs through the real classifier and renderer.
The static check exercises filtering, previews, review velocity, layout, and HTML
escaping. The live check starts a temporary fake backend and uses two browser
sessions to exercise shared progress, freezing, dismissals, and refresh triggers.
The fake backend never invokes GitHub. Reports and screenshots go in `.tmp/`.

## Local configuration

`config.local.toml` supplies `github_user` and `timezone`. Collectors also accept
`--user`; velocity accepts `--timezone`. The configured repository scopes remain
explicit: vLLM and FlashInfer are the supported workspaces, with different
discovery rules.

Global refreshes of an existing index retain the account and timezone recorded
in its snapshots. To switch accounts, stop the backend and run
`python3 scripts/refresh.py` after changing the local config. Per-PR refreshes
always use the account recorded in that workspace's snapshot.

An offline `scripts/refresh.py` run writes timing and API-call reports under
`results/`, with per-attempt telemetry in `.tmp/`. When the backend is running,
the same command joins its shared queue. Do not run low-level collectors
concurrently with that queue.
