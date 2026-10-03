"""Narrow JSON bridge used by the TEAMYRA desktop process.

This keeps destructive Git lifecycle logic in the tested Python core rather than
duplicating it inside Electron. One invocation handles one action and prints one
JSON response to stdout.
"""
import json
import sys
from pathlib import Path

BRIDGE = Path(__file__).resolve().parent
ROOT = BRIDGE.parent
WORKTREES = ROOT / "worktrees"
sys.path.insert(0, str(BRIDGE))

import worktree_manager


def handle(action, payload):
    payload = payload if isinstance(payload, dict) else {}

    if action == "worktree.list":
        return worktree_manager.list_managed(WORKTREES)
    if action == "worktree.status":
        return worktree_manager.status(WORKTREES, payload["worktree_id"])
    if action == "worktree.diff":
        return worktree_manager.diff(
            WORKTREES,
            payload["worktree_id"],
            payload.get("max_chars", 80000),
        )
    if action == "worktree.create":
        project_path = payload.get("project_path")
        if not project_path:
            raise ValueError("project_path is required")
        return worktree_manager.create(
            project_path,
            WORKTREES,
            payload.get("label") or "task",
            payload.get("base_ref") or "HEAD",
        )
    if action == "worktree.rebase":
        if payload.get("confirm") is not True:
            raise ValueError("worktree.rebase requires confirm=true")
        return worktree_manager.rebase(WORKTREES, payload["worktree_id"])
    if action == "worktree.merge":
        if payload.get("confirm") is not True:
            raise ValueError("worktree.merge requires confirm=true")
        return worktree_manager.merge(WORKTREES, payload["worktree_id"])
    if action == "worktree.discard":
        if payload.get("confirm") is not True:
            raise ValueError("worktree.discard requires confirm=true")
        return worktree_manager.discard(
            WORKTREES,
            payload["worktree_id"],
            payload.get("force", False),
        )
    raise ValueError(f"unsupported desktop core action: {action}")


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: desktop_api.py <action> [json_payload]")
    action = sys.argv[1]
    payload = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    try:
        result = handle(action, payload)
        response = {"ok": True, "result": result}
    except Exception as exc:
        response = {"ok": False, "error": str(exc)}
    sys.stdout.write(json.dumps(response, ensure_ascii=False))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
