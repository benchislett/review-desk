#!/usr/bin/env python3
"""Load shared datasets and build an optional standalone page."""

import json
from pathlib import Path
from urllib.parse import quote

from classify import QUEUES
from pins import apply_pins
from triage import apply_dismissals

ROOT = Path(__file__).resolve().parents[1]


def load_snapshot(path, repo):
    data = json.loads(path.read_text())
    assert data["done"] and data["repo"] == repo, "Incomplete or mismatched workspace snapshot"
    return data


def load_bundle(root=ROOT, live=False):
    vllm = load_snapshot(root / "results/snapshot.json", "vllm-project/vllm")
    velocity = json.loads((root / "results/velocity.json").read_text())
    assert velocity["done"] and (velocity["repo"], velocity["user"]) == (vllm["repo"], vllm["user"])
    vllm.update(velocity=velocity, workspaceLabel="vLLM", role="Core maintainer", defaultView="all")
    flash = load_snapshot(root / "results/flashinfer/snapshot.json", "flashinfer-ai/flashinfer")
    assert flash["poolScope"] == "authored-commented"
    flash.update(velocity=None, workspaceLabel="FlashInfer", role="Contributor", defaultView="mine")
    return {
        "defaultWorkspace": "vllm",
        "queues": QUEUES,
        "live": live,
        "workspaces": {"vllm": vllm, "flashinfer": flash},
    }


def render_html(bundle, root=ROOT):
    encoded = (
        json.dumps(bundle, ensure_ascii=True)
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
    )
    files = ["app.js", "workspaces.js", "preview.js", "velocity.js", "pins.js", "live.js"]
    js = (
        "\n".join(
            (root / "site" / name).read_text() for name in files if (root / "site" / name).exists()
        )
        + "\nreadHash();render();if(bundle.live)initLive();"
    )
    html = (root / "site/template.html").read_text()
    favicon = "data:image/svg+xml," + quote((root / "site/favicon.svg").read_text(), safe="")
    for token, content in [
        ("/*__FAVICON__*/", favicon),
        ("/*__CSS__*/", (root / "site/style.css").read_text()),
        ("/*__JS__*/", js),
        ("/*__DATA__*/", encoded),
    ]:
        html = html.replace(token, content)
    return html


def main():
    bundle = load_bundle()
    saved = ROOT / "results/dismissals.json"
    bundle, _ = apply_dismissals(bundle, json.loads(saved.read_text()) if saved.exists() else {})
    saved_pins = ROOT / "results/pins.json"
    apply_pins(bundle, json.loads(saved_pins.read_text()) if saved_pins.exists() else {})
    path = ROOT / "index.html"
    temp = path.with_suffix(".html.tmp")
    temp.write_text(render_html(bundle))
    temp.replace(path)
    print(
        f"Built {path}: "
        + ", ".join(
            f"{w['workspaceLabel']}: {len(w['pullRequests'])} PRs"
            for w in bundle["workspaces"].values()
        )
    )


if __name__ == "__main__":
    main()
