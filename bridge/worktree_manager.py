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


def _rebase_in_progress(path):
    path = Path(path)
    for name in ("rebase-merge", "rebase-apply"):
        rc, raw, _ = _git(path, "rev-parse", "--git-path", name, check=False)
        if rc == 0 and raw:
            marker = Path(raw)
            if not marker.is_absolute():
                marker = (path / marker).resolve()
            if marker.exists():
                return True
    return False


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
        "rebase_in_progress": _rebase_in_progress(path),
    })
    return out



def _untracked_preview(path, remaining):
    _, raw, _ = _git(path, "ls-files", "--others", "--exclude-standard", "-z")
    items = [item for item in raw.split("\0") if item]
    if not items:
        return "", False
    if remaining <= 0:
        return "", True

    root = Path(path).resolve()
    parts = []
    used = 0
    truncated = False
    for index, rel in enumerate(items):
        if used >= remaining:
            truncated = True
            break
        candidate = (root / rel).resolve()
        try:
            candidate.relative_to(root)
        except ValueError:
            continue
        if not candidate.is_file():
            continue

        header = f"\n\n# TEAMYRA untracked file: {rel}\n"
        size = candidate.stat().st_size
        if size > 128 * 1024:
            body = f"[untracked file omitted: {size} bytes]\n"
        else:
            data = candidate.read_bytes()
            if b"\x00" in data:
                body = f"[binary untracked file omitted: {size} bytes]\n"
            else:
                text = data.decode("utf-8", errors="replace")
                lines = text.splitlines()
                body = "\n".join("+" + line for line in lines)
                if text.endswith("\n"):
                    body += "\n"
        chunk = header + body
        available = remaining - used
        take = min(len(chunk), available)
        parts.append(chunk[:take])
        used += take
        if take < len(chunk) or index < len(items) - 1 and used >= remaining:
            truncated = True
            break
    return "".join(parts), truncated

def diff(storage_root, worktree_id, max_chars=50000):
    meta = load(storage_root, worktree_id)
    path = Path(meta["path"])
    if not path.exists():
        raise ValueError("worktree path no longer exists")
    max_chars = max(1000, min(int(max_chars), 200000))
    _, tracked, _ = _git(
        path, "diff", "--no-ext-diff", "--unified=3", "--no-color", meta["base_commit"]
    )
    remaining = max(0, max_chars - min(len(tracked), max_chars))
    untracked, untracked_clipped = _untracked_preview(path, remaining)
    text = tracked + untracked
    total_chars = len(text)
    clipped = len(tracked) > max_chars or untracked_clipped or total_chars > max_chars
    return {
        "id": worktree_id,
        "branch": meta["branch"],
        "base_commit": meta["base_commit"],
        "diff": text[:max_chars],
        "clipped": clipped,
        "total_chars": total_chars,
    }


def snapshot(storage_root, worktree_id, message=None):
    meta = load(storage_root, worktree_id)
    path = Path(meta["path"])
    if not path.exists():
        raise ValueError("worktree path no longer exists")

    changes = _changes(path)
    head_before = _git(path, "rev-parse", "HEAD")[1]
    if not changes:
        return {
            "ok": True,
            "id": worktree_id,
            "committed": False,
            "head": head_before,
        }

    _git(path, "add", "-A")
    commit_message = str(message or f"TEAMYRA snapshot {worktree_id}").strip()[:200]
    rc, out, err = _git(
        path,
        "-c", "user.name=TEAMYRA",
        "-c", "user.email=teamyra@local",
        "commit", "-m", commit_message,
        check=False,
    )
    if rc != 0:
        raise RuntimeError((err or out or "snapshot commit failed").strip())

    head = _git(path, "rev-parse", "HEAD")[1]
    return {
        "ok": True,
        "id": worktree_id,
        "committed": True,
        "head": head,
        "previous_head": head_before,
        "message": commit_message,
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


def begin_rebase_resolution(storage_root, worktree_id):
    meta = load(storage_root, worktree_id)
    root = Path(meta["repo_root"])
    path = Path(meta["path"])
    if not root.exists() or not path.exists():
        raise ValueError("repository or worktree path no longer exists")
    if _rebase_in_progress(path):
        return {"ok": True, "paused": True, **status(storage_root, worktree_id)}
    if _changes(path):
        raise ValueError("worktree has uncommitted changes; commit or discard them before interactive rebase")

    target_branch = meta["target_branch"]
    _, target_head, _ = _git(root, "rev-parse", target_branch)
    current_head = _git(path, "rev-parse", "HEAD")[1]
    if current_head == target_head:
        meta["base_commit"] = target_head
        meta["rebased_at"] = time.time()
        _write_meta(storage_root, meta)
        return {"ok": True, "paused": False, "changed": False, **status(storage_root, worktree_id)}

    rc, out, err = _git(path, "rebase", target_head, check=False)
    if rc == 0:
        meta["base_commit"] = target_head
        meta["rebased_at"] = time.time()
        _write_meta(storage_root, meta)
        return {"ok": True, "paused": False, "changed": True, **status(storage_root, worktree_id)}

    current = status(storage_root, worktree_id)
    if current.get("rebase_in_progress") and current.get("conflicts"):
        return {
            "ok": True,
            "paused": True,
            "message": (err or out or "rebase paused for conflict resolution").strip(),
            **current,
        }
    _git(path, "rebase", "--abort", check=False)
    raise RuntimeError((err or out or "interactive rebase failed").strip())


def _conflict_file(storage_root, worktree_id, relative_path):
    meta = load(storage_root, worktree_id)
    path = Path(meta["path"])
    if not path.exists():
        raise ValueError("worktree path no longer exists")
    if not _rebase_in_progress(path):
        raise ValueError("no interactive rebase is in progress")
    relative_path = str(relative_path or "").replace("\\", "/")
    conflicts = set(_git(path, "diff", "--name-only", "--diff-filter=U")[1].splitlines())
    if relative_path not in conflicts:
        raise ValueError("file is not an unresolved conflict")
    candidate = (path / relative_path).resolve()
    try:
        candidate.relative_to(path.resolve())
    except ValueError as exc:
        raise ValueError("conflict path escapes worktree") from exc
    return meta, path, relative_path, candidate


def conflict_detail(storage_root, worktree_id, relative_path, max_chars=300000):
    _, path, relative_path, candidate = _conflict_file(storage_root, worktree_id, relative_path)
    max_chars = max(1000, min(int(max_chars), 500000))
    content = ""
    binary = False
    clipped = False
    if candidate.exists() and candidate.is_file():
        data = candidate.read_bytes()
        binary = b"\x00" in data
        if not binary:
            text = data.decode("utf-8", errors="replace")
            clipped = len(text) > max_chars
            content = text[:max_chars]

    stages = {}
    for key, stage in (("base", 1), ("target", 2), ("worktree", 3)):
        rc, text, _ = _git(path, "show", f":{stage}:{relative_path}", check=False)
        stages[key] = text if rc == 0 else None
    return {
        "worktree_id": worktree_id,
        "path": relative_path,
        "content": content,
        "binary": binary,
        "clipped": clipped,
        "stages": stages,
    }


def resolve_conflict(storage_root, worktree_id, relative_path, strategy="manual", content=None):
    _, path, relative_path, candidate = _conflict_file(storage_root, worktree_id, relative_path)
    strategy = str(strategy or "manual").lower()
    if strategy not in {"manual", "target", "worktree"}:
        raise ValueError("strategy must be manual, target, or worktree")
    if strategy == "manual":
        if content is None:
            raise ValueError("manual resolution requires content")
        encoded = str(content).encode("utf-8")
        if len(encoded) > 1024 * 1024:
            raise ValueError("resolved conflict content exceeds 1 MiB")
        candidate.parent.mkdir(parents=True, exist_ok=True)
        candidate.write_bytes(encoded)
        _git(path, "add", "--", relative_path)
    else:
        stage = 2 if strategy == "target" else 3
        rc, _, _ = _git(path, "cat-file", "-e", f":{stage}:{relative_path}", check=False)
        if rc != 0:
            rm_rc, rm_out, rm_err = _git(path, "rm", "--", relative_path, check=False)
            if rm_rc != 0:
                raise RuntimeError((rm_err or rm_out or f"could not use deleted {strategy} version").strip())
        else:
            flag = "--ours" if strategy == "target" else "--theirs"
            checkout_rc, out, err = _git(path, "checkout", flag, "--", relative_path, check=False)
            if checkout_rc != 0:
                raise RuntimeError((err or out or f"could not use {strategy} version").strip())
            _git(path, "add", "--", relative_path)
    return status(storage_root, worktree_id)


def continue_rebase_resolution(storage_root, worktree_id):
    meta = load(storage_root, worktree_id)
    root = Path(meta["repo_root"])
    path = Path(meta["path"])
    if not _rebase_in_progress(path):
        raise ValueError("no interactive rebase is in progress")
    conflicts = _git(path, "diff", "--name-only", "--diff-filter=U")[1].splitlines()
    if conflicts:
        raise ValueError("resolve all conflict files before continuing rebase")

    staged_rc, _, _ = _git(path, "diff", "--cached", "--quiet", check=False)
    command = ("rebase", "--skip") if staged_rc == 0 else ("-c", "core.editor=true", "rebase", "--continue")
    rc, out, err = _git(path, *command, check=False)
    current = status(storage_root, worktree_id)
    if rc != 0:
        if current.get("rebase_in_progress") and current.get("conflicts"):
            return {"ok": True, "paused": True, "message": (err or out).strip(), **current}
        raise RuntimeError((err or out or "rebase continue failed").strip())

    _, target_head, _ = _git(root, "rev-parse", meta["target_branch"])
    meta["base_commit"] = target_head
    meta["rebased_at"] = time.time()
    _write_meta(storage_root, meta)
    return {"ok": True, "paused": False, "changed": True, **status(storage_root, worktree_id)}


def abort_rebase_resolution(storage_root, worktree_id):
    meta = load(storage_root, worktree_id)
    path = Path(meta["path"])
    if not path.exists():
        raise ValueError("worktree path no longer exists")
    if _rebase_in_progress(path):
        rc, out, err = _git(path, "rebase", "--abort", check=False)
        if rc != 0:
            raise RuntimeError((err or out or "rebase abort failed").strip())
    return {"ok": True, **status(storage_root, worktree_id)}


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
