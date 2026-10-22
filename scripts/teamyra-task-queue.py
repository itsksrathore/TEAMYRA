"""Durable, sequential TEAMYRA queues. Resume with the same manifest path."""
import json
import os
from pathlib import Path
import shutil
import sys
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bridge"))
import server


def run_queue(manifest_path):
    manifest_path = Path(manifest_path).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    output = manifest_path.parent
    mutex = threading.Lock()

    def log(text):
        with mutex, (output / "queue.log").open("a", encoding="utf-8") as stream:
            stream.write(time.strftime("%Y-%m-%d %H:%M:%S ") + text + "\n")

    def worker_queue(worker, tasks):
        state_file = output / (worker + ".state.json")
        lock_file = output / (worker + ".lock")
        try:
            with lock_file.open("x", encoding="utf-8") as stream:
                stream.write(str(os.getpid()))
        except FileExistsError:
            from wake_gateway import process_alive
            if process_alive(int(lock_file.read_text())):
                log(worker + ": already has a queue runner")
                return
            lock_file.unlink()
            return worker_queue(worker, tasks)
        try:
            state = json.loads(state_file.read_text()) if state_file.exists() else {"index": 0}
            def save():
                temp = state_file.with_suffix(".tmp")
                temp.write_text(json.dumps(state, indent=2), encoding="utf-8")
                temp.replace(state_file)
            for index in range(state["index"], len(tasks)):
                task = tasks[index]
                if not state.get("job_id"):
                    while server.running_jobs(worker):
                        time.sleep(5)
                    result = server.tool_call("start_task", {
                        "worker": worker, "project_path": task["project"], "task": task["prompt"],
                        "label": task["label"], "timeout_minutes": task.get("timeout_minutes", 180),
                        "write": True, "auto_failover": False,
                    })
                    state.update(index=index, job_id=result["job_id"], status="running")
                    save()
                    log(f"{worker}: start {task['label']} {state['job_id']}")
                while not server.is_done(state["job_id"]):
                    time.sleep(5)
                result = server.job_result(state["job_id"])
                try:
                    if result.get("state") != "done":
                        raise ValueError(f"job {result.get('state')}: {result.get('last_event', '')}")
                    if task.get("artifact"):
                        artifact = Path(task["project"]) / task["artifact"]
                        if artifact.stat().st_mtime < server.read_meta(state["job_id"])["created"]:
                            raise ValueError("artifact predates this job")
                        verdict = json.loads(artifact.read_text(encoding="utf-8"))
                        if task.get("review"):
                            required = {"verdict", "reviewed_head", "reviewer", "mode", "gates", "plan_items_missing", "issues"}
                            if not required.issubset(verdict) or verdict["verdict"] not in {"pass", "fail"}:
                                raise ValueError("invalid review schema")
                            if verdict["reviewed_head"] != server.read_meta(state["job_id"])["head_start"]:
                                raise ValueError("reviewed_head does not match assigned checkout")
                        if task.get("copy_to"):
                            destination = Path(task["copy_to"])
                            destination.parent.mkdir(parents=True, exist_ok=True)
                            if destination.exists():
                                shutil.copy2(destination, destination.with_name(destination.name + ".previous-" + state["job_id"]))
                            shutil.copy2(artifact, destination)
                    log(f"{worker}: complete {task['label']} {state['job_id']}")
                except (OSError, ValueError) as error:
                    # Preserve failure visibly. Do not erase it by advancing the queue.
                    state.update(status="failed", error=str(error))
                    save()
                    log(f"{worker}: STOP {task['label']}: {error}")
                    return
                state = {"index": index + 1, "status": "ready"}
                save()
            state["status"] = "complete"
            save()
            log(worker + ": queue complete")
        except Exception as error:
            log(f"{worker}: STOP {type(error).__name__}: {error}")
        finally:
            lock_file.unlink(missing_ok=True)

    threads = [threading.Thread(target=worker_queue, args=(worker, tasks)) for worker, tasks in manifest.items()]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()


if __name__ == "__main__":
    run_queue(sys.argv[1])
