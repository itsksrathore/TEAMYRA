"""How agents should generate media and images through TEAMYRA (fast paths).

One source for the MCP server instructions, the media_guide tool and the hint
returned when a worker job is started just to draw images.
"""
import json
import os
import re
import time
from pathlib import Path

INSTRUCTIONS = """TEAMYRA media and image generation: use the fast paths.
- Google Flow videos, images and sound effects: media_generate for one, media_batch for two or more (up to 50, run across every signed-in Google account, several Flow tabs each). Poll media_status({batch_id}) every 20-30 s.
- Codex/gpt-image stills (character sheets, look frames, photoreal or illustrated images): codex_image_batch with every image of the job in one call (prompt, output file, reference files, size); poll codex_image_status. Do not start a Codex worker job (start_task/run_ai_worker) to draw images: it makes them one at a time, 2-5 min each.
- Images that build on earlier images: generate the base images first, then a second batch that lists them as references.
- Call media_guide for the full rules and current capacity."""

GUIDE = """# Generating media and images through TEAMYRA

## Pick the tool
| Need | Tool | Notes |
|---|---|---|
| Video, Omni/Nano Banana image or sound effect from Google Flow | `media_generate` (one) / `media_batch` (2-50) | Runs in every signed-in Google account at once, several Flow tabs each. Video: 720p generation, 1080p download. |
| Still images with Codex (gpt-image): character sheets, turnarounds, look frames, photoreal or illustrated stills | `codex_image_batch` (1-50) | About 1-2 min per image, two at once per Codex account, full quality. |
| Music | `media_generate` with type music | One song at a time. |

Never draw images by starting a worker job (`start_task`, `run_ai_worker`, `run_ai_parallel`) whose task tells Codex to use its image tool: that runs one long agent session that makes images one by one (2-5 min each) and blocks the account for other work.

## Google Flow (`media_batch`)
- Put every prompt of the job in one `media_batch` call with `project_path`; leave `max_parallel` at 10 unless you must limit it (it caps running jobs per Google account).
- `media_status` shows which account and tab handles each job (`handled_by`); a submitted job always finishes in the account that submitted it.
- Reference images: list TEAMYRA asset ids or project files in `references`; refer to them in the prompt.
- Poll `media_status({batch_id})` every 20-30 s. Do not cancel or resubmit while jobs are still running.
- Failed jobs: read `recovery_plan`. `policy_refusal` / `provider_no_result` = Flow refused or made nothing: reword and queue a new job. `result_match_failed` or download failures: `media_recover` / `media_resume_download` (no new credits), or `media_report_issue` to hand them to a helper agent.

## Codex images (`codex_image_batch`)
- One call per wave: `{"project_path": ..., "requests": [{"prompt": ..., "output": "folder/name.png", "references": ["refs/a.png"], "size": "1536x1024"}]}`.
- Sizes: `1536x1024` (landscape), `1024x1536` (portrait), `1024x1024`, `auto`. Outputs may be .png, .jpg or .webp and must be inside `project_path`.
- Write the full prompt for each image (subject, style, framing, lighting). Refer to references as Image 1, Image 2... in the order listed.
- Dependent images: first batch the base images (e.g. turnarounds), then a second batch that uses them as references (head sheets, hero frames).
- Poll `codex_image_status({batch_id})` every 20-30 s. `refused` means the image service refused the prompt: reword it. `failed` items can be sent again in a new batch.
- Each image is checked once by Codex and regenerated once if it clearly misses; quality is not reduced.

## Problems
Report anything you cannot fix quickly with `media_report_issue` (Flow jobs) or `maintenance_report` (anything else) and keep working."""

_IMAGE_TASK = re.compile(
    r"built-?in image (?:generation|tool)|image ?gen(?:eration)? (?:tool|skill)|\bimagegen\b|gpt-image|image_gen\b"
    r"|generate (?:an? |the |\d+ )?(?:images?|stills?|look[- ]frames?|turnarounds?|character sheets?)",
    re.I)


def image_task_hint(task, worker):
    """A hint when a Codex worker job is started just to draw images."""
    if "codex" not in str(worker or "").lower() and str(worker or "auto") != "auto":
        return None
    if not _IMAGE_TASK.search(str(task or "")):
        return None
    return ("This job asks a worker to draw images one at a time (2-5 min each). For images use "
            "codex_image_batch: every image in one call, about 1-2 min each, several in parallel, full quality. "
            "See media_guide.")


def capacity(root):
    root = Path(root)
    tabs = _flow_tabs()
    result = {"flow_tabs_per_account": tabs}
    try:
        saved = json.loads((root / "media" / "connection.json").read_text(encoding="utf-8"))
    except Exception:
        saved = None
    result["google_flow_connected"] = saved.get("connected") is True if isinstance(saved, dict) else None
    accounts = _flow_accounts(root, saved if isinstance(saved, dict) else {})
    working = [item for item in accounts if item["enabled"] and item["connected"] and not item["challenged"]]
    result["flow_accounts"] = accounts
    result["flow_accounts_working"] = len(working)
    # Flow tabs that take bulk jobs right now: working accounts x tabs each.
    result["flow_tabs"] = tabs * max(1, len(working))
    try:
        import codex_images
        accounts = codex_images.codex_accounts(root)
        result["codex_image_accounts"] = [worker for worker, _ in accounts]
        result["codex_images_at_once"] = codex_images.DEFAULT_PER_ACCOUNT * len(accounts)
    except Exception as exc:
        result["codex_image_accounts"] = []
        result["codex_error"] = str(exc)[:200]
    result["checked_at"] = time.time()
    return result


def _flow_accounts(root, saved):
    """Every Google Media account with its last observed state."""
    profiles = saved.get("profiles") if isinstance(saved.get("profiles"), dict) else {}
    folder = Path(root) / "profiles" / "google-media"
    try:
        builtin = json.loads((folder / "builtin-google.json").read_text(encoding="utf-8"))
    except Exception:
        builtin = {}
    accounts = [{"profile_id": "google", "name": str(builtin.get("name") or "Google Account 1"),
                 "enabled": builtin.get("enabled") is not False,
                 "music": builtin.get("music") if isinstance(builtin.get("music"), bool) else builtin.get("enabled") is not False}]
    try:
        entries = sorted(folder.iterdir())
    except OSError:
        entries = []
    for entry in entries:
        if not entry.is_dir() or entry.name == "google":
            continue
        try:
            meta = json.loads((entry / "teamyra-profile.json").read_text(encoding="utf-8"))
        except Exception:
            meta = {}
        accounts.append({"profile_id": entry.name, "name": str(meta.get("name") or entry.name),
                         "enabled": meta.get("enabled") is not False,
                         "music": meta.get("music") if isinstance(meta.get("music"), bool) else meta.get("enabled") is not False})
    for item in accounts:
        # The built-in account's state lived at the top level before accounts had records.
        state = profiles.get(item["profile_id"]) or (saved if item["profile_id"] == "google" else {})
        item["connected"] = state.get("connected") is True
        item["challenged"] = state.get("challenged") is True
        item["music_signed_in"] = state.get("music_signed_in") is True
    return accounts


def _flow_tabs():
    try:
        value = int(os.environ.get("TEAMYRA_FLOW_LANES") or 3)
    except ValueError:
        value = 3
    return max(1, min(4, value))


def guide(root):
    return {"guide": GUIDE, "capacity": capacity(root)}
