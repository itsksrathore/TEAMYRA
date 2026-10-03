"""First-class Git worktree lifecycle for TEAMYRA.

Runtime metadata lives under the configured worktrees directory, which is ignored
by git. Destructive operations are conservative by default.
"""
import json
import os
import re
import subprocess
import time
import uuid
from pathlib import Path

ID_RE = re.compile(r"^wt-[A-Za-z0-9._-]{1,96}$")
SAFE_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _run(cmd, cwd=None, check=True):
    cp = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        text=True,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    )
    if check and cp.returncode != 0:
        raise RuntimeError((cp.stderr or cp.stdout or "command failed").strip())
    return cp.returncode, (cp.stdout or "").strip(), (cp.stderr or "").strip()


def _git(cwd, *args, check=True):
    return _run(["git", "-C", str(cwd), *args], check=check)


def _slug(value):
    value = SAFE_RE.sub("-", str(value or "").strip()).strip(".-_")
    return (value or "task")[:48]


def _registry_dir(storage_root):
    path = Path(storage_root) / ".teamyra"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _meta_path(storage_root, worktree_id):
    if not ID_RE.fullmatch(str(worktree_id or "")):
        raise ValueError("invalid worktree id")
    return _registry_dir(storage_root) / f"{worktree_id}.json"


def _write_meta(storage_root, meta):
    path = _meta_path(storage_root, meta["id"])
    tmp = path.with_name(path.name + f".tmp-{os.getpid()}-{uuid.uuid4().hex[:6]}")
    tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def load(storage_root, worktree_id):
    path = _meta_path(storage_root, worktree_id)
    if not path.exists():
        raise ValueError(f"no such worktree: {worktree_id}")
    return json.loads(path.read_text(encoding="utf-8"))


def repo_root(project_path):
    path = Path(project_path).resolve()
    if not path.exists():
        raise ValueError(f"project path not found: {path}")
    _, out, _ = _git(path, "rev-parse", "--show-toplevel")
    return Path(out).resolve()


def create(project_path, storage_root, label="task", base_ref="HEAD"):
    root = repo_root(project_path)
    target_branch = _git(root, "branch", "--show-current")[1]
    if not target_branch:
        raise ValueError("source repository is in detached HEAD state")

    _, base_commit, _ = _git(root, "rev-parse", base_ref)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    token = uuid.uuid4().hex[:6]
    worktree_id = f"wt-{stamp}-{token}"
    slug = _slug(label)
    branch = f"teamyra/{slug}/{stamp}-{token}"
    path = Path(storage_root).resolve() / f"{root.name}-{slug}-{token}"
    path.parent.mkdir(parents=True, exist_ok=True)

    _git(root, "worktree", "add", "-b", branch, str(path), base_commit)
    meta = {
        "id": worktree_id,
        "label": str(label or "task").strip()[:120] or "task",
        "repo_root": str(root),
        "path": str(path),
        "branch": branch,
        "target_branch": target_branch,
        "base_ref": str(base_ref),
        "base_commit": base_commit,
        "created_at": time.time(),
        "merged_at": None,
        "merged_commit": None,
        "rebased_at": None,
    }
    _write_meta(storage_root, meta)
    return status(storage_root, worktree_id)


def _changes(path):
    _, porcelain, _ = _git(path, "status", "--porcelain")
    return [line for line in porcelain.splitlines() if line.strip()]


def status(storage_root, worktree_id):
    meta = load(storage_root, worktree_id)
    path = Path(meta["path"])
    exists = path.exists()
    out = dict(meta)
    out["exists"] = exists
    if not exists:
        out.update({"head": None, "dirty": False, "changes": [], "commits": [], "diffstat": ""})
        return out

    head = _git(path, "rev-parse", "HEAD")[1]
    branch = _git(path, "branch", "--show-current")[1]
    changes = _changes(path)
    commits = _git(path, "log", "--oneline", f"{meta['base_commit']}..HEAD")[1].splitlines()
    diffstat = _git(path, "diff", "--stat", meta["base_commit"])[1]
    conflicts = _git(path, "diff", "--name-only", "--diff-filter=U")[1].splitlines()
    out.update({
        "head": head,
        "current_branch": branch,
        "dirty": bool(changes),
        "changes": changes[:200],
        "commits": commits[:100],
        "diffstat": diffstat,
        "conflicts": conflicts,
    })
    return out


def diff(storage_root, worktree_id, max_chars=50000):
    meta = load(storage_root, worktree_id)
    path = Path(meta["path"])
    if not path.exists():
        raise ValueError("worktree path no longer exists")
    max_chars = max(1000, min(int(max_chars), 200000))
    _, text, _ = _git(
        path, "diff", "--no-ext-diff", "--unified=3", "--no-color", meta["base_commit"]
    )
    clipped = len(text) > max_chars
    return {
        "id": worktree_id,
        "branch": meta["branch"],
        "base_commit": meta["base_commit"],
        "diff": text[:max_chars],
        "clipped": clipped,
        "total_chars": len(text),
    }


def rebase(storage_root, worktree_id):
    meta = load(storage_root, worktree_id)
    root = Path(meta["repo_root"])
    path = Path(meta["path"])
    if not root.exists() or not path.exists():
        raise ValueError("repository or worktree path no longer exists")
    if _changes(path):
        raise ValueError("worktree has uncommitted changes; commit or discard them before rebase")

    target_branch = meta["target_branch"]
    _, target_head, _ = _git(root, "rev-parse", target_branch)
    current_head = _git(path, "rev-parse", "HEAD")[1]
    if current_head == target_head:
        meta["base_commit"] = target_head
        meta["rebased_at"] = time.time()
        _write_meta(storage_root, meta)
        return {
            "ok": True,
            "id": worktree_id,
            "branch": meta["branch"],
            "target_branch": target_branch,
            "base_commit": target_head,
            "head": current_head,
            "changed": False,
        }

    rc, out, err = _git(path, "rebase", target_head, check=False)
    if rc != 0:
        _git(path, "rebase", "--abort", check=False)
        raise RuntimeError((err or out or "rebase failed").strip())

    head = _git(path, "rev-parse", "HEAD")[1]
    meta["base_commit"] = target_head
    meta["rebased_at"] = time.time()
    _write_meta(storage_root, meta)
    return {
        "ok": True,
        "id": worktree_id,
        "branch": meta["branch"],
        "target_branch": target_branch,
        "base_commit": target_head,
        "head": head,
        "changed": head != current_head,
    }


def merge(storage_root, worktree_id):
    meta = load(storage_root, worktree_id)
    root = Path(meta["repo_root"])
    path = Path(meta["path"])
    if not root.exists() or not path.exists():
        raise ValueError("repository or worktree path no longer exists")
    if _changes(path):
        raise ValueError("worktree has uncommitted changes; commit or discard them before merge")
    if _changes(root):
        raise ValueError("target repository has uncommitted changes; clean it before merge")

    target_branch = _git(root, "branch", "--show-current")[1]
    if target_branch != meta["target_branch"]:
        raise ValueError(
            f"target repository must be on {meta['target_branch']} before merge (currently {target_branch or 'detached'})"
        )

    rc, out, err = _git(
        root,
        "merge",
        "--no-ff",
        "--no-edit",
        meta["branch"],
        check=False,
    )
    if rc != 0:
        _git(root, "merge", "--abort", check=False)
        raise RuntimeError((err or out or "merge failed").strip())

    merged_commit = _git(root, "rev-parse", "HEAD")[1]
    meta["merged_at"] = time.time()
    meta["merged_commit"] = merged_commit
    _write_meta(storage_root, meta)
    return {
        "ok": True,
        "id": worktree_id,
        "branch": meta["branch"],
        "target_branch": target_branch,
        "merged_commit": merged_commit,
    }


def _branch_is_merged(meta):
    root = Path(meta["repo_root"])
    rc, _, _ = _git(
        root,
        "merge-base",
        "--is-ancestor",
        meta["branch"],
        meta["target_branch"],
        check=False,
    )
    return rc == 0


def discard(storage_root, worktree_id, force=False):
    meta = load(storage_root, worktree_id)
    root = Path(meta["repo_root"])
    path = Path(meta["path"])
    if path.exists() and _changes(path) and not force:
        raise ValueError("worktree has uncommitted changes; use force=true to discard them")

    merged = _branch_is_merged(meta) if root.exists() else False
    if not merged and not force:
        raise ValueError("worktree branch is not merged; merge it or use force=true")

    if root.exists() and path.exists():
        args = ["worktree", "remove"]
        if force:
            args.append("--force")
        args.append(str(path))
        _git(root, *args)

    if root.exists():
        _git(root, "branch", "-D" if force else "-d", meta["branch"], check=False)

    meta_path = _meta_path(storage_root, worktree_id)
    if meta_path.exists():
        meta_path.unlink()
    return {"ok": True, "id": worktree_id, "removed": True, "forced": bool(force)}


def list_managed(storage_root):
    directory = _registry_dir(storage_root)
    rows = []
    for path in sorted(directory.glob("wt-*.json")):
        try:
            meta = json.loads(path.read_text(encoding="utf-8"))
            rows.append(status(storage_root, meta["id"]))
        except Exception:
            continue
    return rows
