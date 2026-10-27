"""Bulk image generation with Codex's built-in image tool.

A Codex worker job made images one at a time inside a long agent session that
also read task files, inspected every result and wrote notes: 2-5 minutes per
image, and each account ran one job at a time. Here every image is its own
short `codex exec` (reference images attached with -i, the usual model and
reasoning effort, one look at the result and at most one corrected retry), and
several run at once across the signed-in Codex accounts. TEAMYRA copies the
image Codex generated from that account's generated_images folder to the
requested path, so the agent never touches the project files.
"""
import json
import os
import re
import secrets
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path

from runtime_paths import codex_launch, share_codex_sandbox

MAX_BATCH = 50
DEFAULT_PER_ACCOUNT = 2
MAX_PARALLEL = 8
ITEM_TIMEOUT_SECONDS = 12 * 60
LIMIT_COOLDOWN_SECONDS = 15 * 60
SIZES = {"1536x1024", "1024x1536", "1024x1024", "auto"}
FORMATS = {".png", ".jpg", ".jpeg", ".webp"}
TERMINAL = {"completed", "failed", "refused", "cancelled"}
_BATCH_RE = re.compile(r"^cimg-\d{8}-\d{6}-[0-9a-f]{6}$")
_LIMIT_RE = re.compile(r"usage limit|rate limit|too many requests|\b429\b|quota", re.I)

INSTRUCTIONS = """Generate exactly one image with your built-in image generation tool.
Size: {size}.{refs}
Image prompt:
{prompt}

Use the prompt in full and keep the highest image quality. After the image is generated, look at it once; \
if it clearly misses the prompt or a reference image, regenerate once with a corrected prompt. Do not run \
shell commands, read or write files, or ask questions. When finished reply with one line: DONE, or \
REFUSED: <reason> if the image service refused the request."""


def _root_dir(root):
    return Path(root) / "codex-images"


def _batch_dir(root, batch_id):
    batch_id = str(batch_id or "").strip()
    if not _BATCH_RE.fullmatch(batch_id):
        raise ValueError("invalid codex image batch id")
    return _root_dir(root) / batch_id


def _write_json(path, data):
    tmp = path.with_name(path.name + f".tmp-{os.getpid()}-{threading.get_ident()}")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    for _ in range(20):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:  # a reader has it open on Windows
            time.sleep(0.05)
    os.replace(tmp, path)


def _read_json(path, default=None):
    for _ in range(20):
        try:
            return json.loads(Path(path).read_text(encoding="utf-8"))
        except FileNotFoundError:
            return default
        except (PermissionError, json.JSONDecodeError):
            time.sleep(0.05)
    return default


def _inside(child, parent):
    try:
        Path(child).resolve().relative_to(Path(parent).resolve())
        return True
    except ValueError:
        return False


def _normalize(request, project, index):
    if not isinstance(request, dict):
        raise ValueError(f"requests[{index}] must be an object")
    prompt = str(request.get("prompt") or "").strip()
    if not prompt:
        raise ValueError(f"requests[{index}].prompt is required")
    output = str(request.get("output") or "").strip()
    if not output:
        raise ValueError(f"requests[{index}].output is required (a file path in the project)")
    out = Path(output)
    out = (out if out.is_absolute() else project / out).resolve()
    if not _inside(out, project):
        raise ValueError(f"requests[{index}].output must be inside project_path")
    if out.suffix.lower() not in FORMATS:
        raise ValueError(f"requests[{index}].output must end in .png, .jpg or .webp")
    size = str(request.get("size") or "1536x1024").strip().lower()
    if size not in SIZES:
        raise ValueError(f"requests[{index}].size must be one of {sorted(SIZES)}")
    references = []
    for item in request.get("references") or []:
        ref = Path(str(item))
        ref = (ref if ref.is_absolute() else project / ref).resolve()
        if not ref.is_file():
            raise ValueError(f"requests[{index}] reference not found: {item}")
        references.append(str(ref))
    if len(references) > 10:
        raise ValueError(f"requests[{index}] takes at most 10 reference images")
    return {"index": index, "prompt": prompt, "output": str(out), "size": size, "references": references,
            "status": "queued", "attempts": 0, "account": None, "error": None}


def create_batch(root, requests, project_path, max_parallel=None, accounts=None, spawn=True):
    if not isinstance(requests, list) or not requests:
        raise ValueError("requests must be a non-empty array")
    if len(requests) > MAX_BATCH:
        raise ValueError(f"a codex image batch takes at most {MAX_BATCH} images")
    project = Path(str(project_path or "")).expanduser()
    if not project_path or not project.is_dir():
        raise ValueError("project_path must be an existing folder")
    project = project.resolve()
    items = [_normalize(request, project, index) for index, request in enumerate(requests)]
    outputs = [item["output"].lower() for item in items]
    if len(set(outputs)) != len(outputs):
        raise ValueError("every request needs its own output path")
    batch_id = time.strftime("cimg-%Y%m%d-%H%M%S-") + secrets.token_hex(3)
    folder = _batch_dir(root, batch_id)
    folder.mkdir(parents=True)
    parallel = None
    if max_parallel is not None:
        parallel = max(1, min(int(max_parallel), MAX_PARALLEL))
    batch = {"batch_id": batch_id, "project_path": str(project), "created_at": time.time(),
             "max_parallel": parallel, "accounts": list(accounts or []), "cancel_requested": False,
             "items": items}
    _write_json(folder / "batch.json", batch)
    if spawn:
        _spawn_runner(root, folder)
    return batch_status(root, batch_id)


def _spawn_runner(root, folder):
    frozen = os.environ.get("TEAMYRA_CORE_EXE") or (sys.executable if getattr(sys, "frozen", False) else "")
    command = ([frozen, "__codex-images", str(root), str(folder)] if frozen
               else [sys.executable, str(Path(__file__).resolve()), "run", str(root), str(folder)])
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "DETACHED_PROCESS", 0) | \
        getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    log = open(folder / "runner.log", "ab")
    subprocess.Popen(command, cwd=str(Path(__file__).resolve().parent), stdin=subprocess.DEVNULL,
                     stdout=log, stderr=log, creationflags=flags, close_fds=True)


def batch_status(root, batch_id):
    folder = _batch_dir(root, batch_id)
    batch = _read_json(folder / "batch.json")
    if not isinstance(batch, dict):
        raise ValueError(f"no such codex image batch: {batch_id}")
    counts = {}
    for item in batch["items"]:
        counts[item["status"]] = counts.get(item["status"], 0) + 1
    finished = sum(counts.get(state, 0) for state in TERMINAL)
    done = finished == len(batch["items"])
    ended = max((item.get("ended") or 0 for item in batch["items"]), default=0)
    return {
        "batch_id": batch["batch_id"], "project_path": batch["project_path"], "total": len(batch["items"]),
        "counts": counts, "done": done, "runner_alive": _runner_alive(folder) if not done else False,
        "elapsed_seconds": round((ended if done else time.time()) - batch["created_at"]),
        "items": [{key: item.get(key) for key in ("index", "status", "output", "account", "attempts",
                                                  "seconds", "width", "height", "error")} for item in batch["items"]],
    }


def cancel_batch(root, batch_id):
    folder = _batch_dir(root, batch_id)
    with _lock(folder):
        batch = _read_json(folder / "batch.json")
        batch["cancel_requested"] = True
        for item in batch["items"]:
            if item["status"] == "queued":
                item["status"] = "cancelled"
        _write_json(folder / "batch.json", batch)
    return batch_status(root, batch_id)


def _runner_alive(folder):
    beat = _read_json(folder / "heartbeat.json", {}) or {}
    return time.time() - float(beat.get("at") or 0) < 30


class _lock:
    """Cross-process lock for batch.json (status writers and cancel)."""
    def __init__(self, folder):
        self.path = Path(folder) / ".lock"

    def __enter__(self):
        deadline = time.time() + 15
        while True:
            try:
                self.fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                return self
            except FileExistsError:
                try:
                    if time.time() - self.path.stat().st_mtime > 30:
                        self.path.unlink()
                        continue
                except FileNotFoundError:
                    continue
                if time.time() > deadline:
                    raise TimeoutError("codex image batch is busy")
                time.sleep(0.05)

    def __exit__(self, *exc):
        os.close(self.fd)
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass


# --- runner ------------------------------------------------------------------------------

def image_size(path):
    """(width, height) of a PNG/JPEG/WebP file, or None."""
    try:
        from PIL import Image
        with Image.open(path) as image:
            return image.size
    except Exception:
        pass
    data = Path(path).read_bytes()[:64]
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", data[16:24])
    return None


def _save_output(source, destination):
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    tmp = destination.with_name(destination.name + ".part")
    if destination.suffix.lower() == ".png":
        tmp.write_bytes(Path(source).read_bytes())
    else:
        from PIL import Image
        with Image.open(source) as image:
            fmt = "JPEG" if destination.suffix.lower() in {".jpg", ".jpeg"} else "WEBP"
            (image.convert("RGB") if fmt == "JPEG" else image).save(tmp, fmt, quality=95)
    os.replace(tmp, destination)
    return image_size(destination)


def codex_accounts(root, wanted=None):
    """Signed-in Codex accounts (worker id -> CODEX_HOME), main account first."""
    from worker_registry import build_worker_registry
    accounts = []
    for worker, info in build_worker_registry(Path(root)).items():
        if info.get("provider") != "codex" or not info.get("home"):
            continue
        if wanted and worker not in wanted:
            continue
        if not (Path(info["home"]) / "auth.json").is_file():
            continue
        accounts.append((worker, str(info["home"])))
    return accounts


def _settings(root):
    try:
        config = json.loads((Path(root) / "bridge" / "config.json").read_text(encoding="utf-8"))
    except Exception:
        config = {}
    codex = config.get("codex") or {}
    return codex.get("model"), codex.get("effort")


def run_one(item, home, project, timeout=ITEM_TIMEOUT_SECONDS, root=None, runner=subprocess.run):
    """Generate one image as one `codex exec`. Returns a result dict."""
    launch = codex_launch()
    if not launch:
        return {"status": "failed", "error": "Codex CLI not found"}
    share_codex_sandbox(home)
    model, effort = _settings(root) if root else (None, None)
    refs = ""
    if item["references"]:
        count = len(item["references"])
        refs = (" The attached image" + (f"s (Image 1 to Image {count})" if count > 1 else " (Image 1)") +
                " are the reference images, in that order.")
    message = INSTRUCTIONS.format(size=item["size"], refs=refs, prompt=item["prompt"])
    command = [*launch]
    if model:
        command += ["-c", f'model="{model}"']
    if effort:
        command += ["-c", f'model_reasoning_effort="{effort}"']
    command += ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "-C", str(project)]
    for ref in item["references"]:
        command += ["-i", ref]
    command += ["--", message]
    env = os.environ.copy()
    env["CODEX_HOME"] = home
    started = time.time()
    try:
        done = runner(command, env=env, cwd=str(project), stdin=subprocess.DEVNULL, capture_output=True,
                      text=True, encoding="utf-8", errors="replace", timeout=timeout,
                      creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        stdout, stderr, code = done.stdout or "", done.stderr or "", done.returncode
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout.decode("utf-8", "replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        stderr, code = "timed out", -1
    thread_id, reply, errors = None, "", []
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        kind = event.get("type")
        if kind == "thread.started":
            thread_id = event.get("thread_id")
        elif kind == "item.completed" and (event.get("item") or {}).get("type") == "agent_message":
            reply = str(event["item"].get("text") or "").strip()
        elif kind in ("error", "turn.failed"):
            errors.append(json.dumps(event)[:400])
    images = []
    if thread_id:
        folder = Path(home) / "generated_images" / thread_id
        if folder.is_dir():
            images = sorted((p for p in folder.iterdir() if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}),
                            key=lambda p: p.stat().st_mtime)
    seconds = round(time.time() - started)
    detail = " ".join([*errors, stderr[-600:]]).strip()
    if images:
        size = _save_output(images[-1], item["output"])
        return {"status": "completed", "seconds": seconds, "width": size[0] if size else None,
                "height": size[1] if size else None, "source": str(images[-1]), "generations": len(images),
                "thread_id": thread_id}
    if _LIMIT_RE.search(detail) or _LIMIT_RE.search(reply):
        return {"status": "limited", "seconds": seconds, "error": (detail or reply)[:600]}
    if reply.upper().startswith("REFUSED"):
        return {"status": "refused", "seconds": seconds, "error": reply[:600]}
    return {"status": "failed", "seconds": seconds,
            "error": ("no image was generated; " + (reply or detail or f"exit {code}"))[:600]}


def run_batch(root, folder, runner=subprocess.run):
    folder = Path(folder)
    batch = _read_json(folder / "batch.json")
    accounts = codex_accounts(root, batch.get("accounts") or None)
    if not accounts:
        with _lock(folder):
            batch = _read_json(folder / "batch.json")
            for item in batch["items"]:
                if item["status"] == "queued":
                    item.update(status="failed", error="no signed-in Codex account")
            _write_json(folder / "batch.json", batch)
        return
    per_account = DEFAULT_PER_ACCOUNT
    total = batch.get("max_parallel") or per_account * len(accounts)
    running = {worker: 0 for worker, _ in accounts}
    limited_until = {worker: 0.0 for worker, _ in accounts}
    homes = dict(accounts)
    state = threading.Lock()
    stop = threading.Event()

    def beat():
        while not stop.is_set():
            _write_json(folder / "heartbeat.json", {"at": time.time(), "pid": os.getpid()})
            stop.wait(10)

    threading.Thread(target=beat, daemon=True).start()

    def update(index, **fields):
        with _lock(folder):
            current = _read_json(folder / "batch.json")
            current["items"][index].update(fields)
            _write_json(folder / "batch.json", current)
            return current

    def next_job():
        """(item, worker) to start now, None to wait, or False when nothing is left."""
        with _lock(folder):
            current = _read_json(folder / "batch.json")
        queued = [item for item in current["items"] if item["status"] == "queued"]
        if current.get("cancel_requested") or not queued:
            # A running image may still come back (another account's limit).
            with state:
                return None if any(running.values()) else False
        with state:
            if sum(running.values()) >= total:
                return None
            now = time.time()
            free = [worker for worker, _ in accounts
                    if limited_until[worker] <= now and running[worker] < per_account]
            if not free:
                # Every account hit its limit and nothing is still running: stop
                # rather than wait out the cooldown; the rest is reported failed.
                if all(limited_until[worker] > now for worker, _ in accounts) and not any(running.values()):
                    return False
                return None
            worker = min(free, key=lambda name: running[name])
            running[worker] += 1
        item = queued[0]
        update(item["index"], status="generating", account=worker, attempts=item["attempts"] + 1,
               started=time.time(), error=None)
        return item, worker

    def work(item, worker):
        try:
            result = run_one(item, homes[worker], batch["project_path"], root=root, runner=runner)
        except Exception as exc:  # keep the batch going
            result = {"status": "failed", "error": f"runner error: {exc}"[:600]}
        with state:
            running[worker] -= 1
            if result["status"] == "limited":
                limited_until[worker] = time.time() + LIMIT_COOLDOWN_SECONDS
        if result["status"] == "limited":
            others = any(limited_until[name] <= time.time() for name, _ in accounts)
            if others and item["attempts"] + 1 < 4:
                update(item["index"], status="queued", account=None, error=result["error"])
                return
            result["status"] = "failed"
        update(item["index"], **result, ended=time.time())

    threads = []
    try:
        while True:
            job = next_job()
            if job is False:
                break
            if job is None:
                time.sleep(1)
                continue
            thread = threading.Thread(target=work, args=job, daemon=True)
            thread.start()
            threads.append(thread)
        for thread in threads:
            thread.join()
    finally:
        stop.set()
        with _lock(folder):
            current = _read_json(folder / "batch.json")
            for item in current["items"]:
                if item["status"] == "queued":
                    item.update(status="cancelled" if current.get("cancel_requested") else "failed",
                                error=item.get("error") or "not started")
            _write_json(folder / "batch.json", current)
        _write_json(folder / "heartbeat.json", {"at": 0, "pid": os.getpid(), "finished": time.time()})


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "run":
        argv = argv[1:]
    root, folder = argv[0], argv[1]
    run_batch(root, folder)


if __name__ == "__main__":
    main()
