import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import runner
import scheduler
import server


def write_job(root, job_id, *, worker="codex1", provider="codex", state="running", created=None,
              done=False, **extra):
    job = Path(root) / "jobs" / job_id
    job.mkdir(parents=True, exist_ok=True)
    meta = {"id": job_id, "worker": worker, "provider": provider, "state": state, "label": f"label {job_id}",
            "cwd": str(root), "created": created if created is not None else time.time(), "timeout_s": 600}
    meta.update(extra)
    (job / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    (job / "spec.json").write_text(json.dumps({"worker": worker, "provider": provider, "cmd": ["x"],
                                               "cwd": str(root), "timeout": 600}), encoding="utf-8")
    if done:
        (job / "DONE").write_text(state, encoding="utf-8")
    return job


def read_meta(root, job_id):
    return json.loads((Path(root) / "jobs" / job_id / "meta.json").read_text(encoding="utf-8"))


class Spawned:
    def __init__(self, delay=0.0):
        self.calls = []
        self.delay = delay
        self.lock = threading.Lock()

    def __call__(self, job_dir, meta):
        if self.delay:
            time.sleep(self.delay)
        with self.lock:
            self.calls.append(Path(job_dir).name)
        return 4242


class DispatchTests(unittest.TestCase):
    def test_server_meta_replace_retries_transient_permission_error(self):
        with tempfile.TemporaryDirectory() as td:
            write_job(td, "active")
            replace = os.replace
            attempts = []
            def transient(source, target):
                attempts.append(source)
                if len(attempts) < 3:
                    raise PermissionError("reader holds file")
                replace(source, target)
            with patch.object(server, "JOBS", Path(td) / "jobs"), \
                 patch.object(server.os, "replace", side_effect=transient), \
                 patch.object(server.time, "sleep") as sleep:
                result = server.patch_job_meta("active", last_event="updated")
            self.assertEqual(result["last_event"], "updated")
            self.assertEqual(read_meta(td, "active")["last_event"], "updated")
            self.assertEqual(len(attempts), 3)
            self.assertEqual(sleep.call_count, 2)
            self.assertEqual(list((Path(td) / "jobs" / "active").glob("*.tmp-*")), [])

    def test_server_meta_replace_exhaustion_cleans_temp_and_preserves_original(self):
        with tempfile.TemporaryDirectory() as td:
            write_job(td, "active")
            with patch.object(server, "JOBS", Path(td) / "jobs"), \
                 patch.object(server.os, "replace", side_effect=PermissionError("locked")) as replace, \
                 patch.object(server.time, "sleep") as sleep:
                with self.assertRaises(PermissionError):
                    server.patch_job_meta("active", state="failed")
            self.assertEqual(replace.call_count, 20)
            self.assertEqual(sleep.call_count, 19)
            self.assertEqual(read_meta(td, "active")["state"], "running")
            self.assertEqual(list((Path(td) / "jobs" / "active").glob("*.tmp-*")), [])

    def test_free_worker_gets_oldest_queued_job(self):
        with tempfile.TemporaryDirectory() as td:
            write_job(td, "old", state="done", done=True, created=1)
            write_job(td, "q2", state="queued", created=30, queue_order=2)
            write_job(td, "q1", state="queued", created=20, queue_order=1)
            spawn = Spawned()
            report = scheduler.dispatch_once(td, spawn=spawn)
            self.assertEqual(spawn.calls, ["q1"])
            self.assertEqual(report["dispatched"][0]["action"], "spawned")
            q1, q2 = read_meta(td, "q1"), read_meta(td, "q2")
            self.assertEqual(q1["state"], "starting")
            self.assertEqual(q1["runner_pid"], 4242)
            self.assertIsNone(q1["queue_position"])
            self.assertIn("dispatched_at", q1)
            self.assertNotIn("started", q1)  # the runner starts the deadline clock at dispatch
            self.assertEqual(q2["state"], "queued")
            self.assertEqual(q2["queue_position"], 1)

    def test_busy_states_block_dispatch(self):
        for busy_state in ("running", "starting", "waiting_for_desktop", "needs_user"):
            with self.subTest(state=busy_state), tempfile.TemporaryDirectory() as td:
                write_job(td, "active", state=busy_state, created=1)
                write_job(td, "q1", state="queued", created=2)
                spawn = Spawned()
                report = scheduler.dispatch_once(td, spawn=spawn)
                self.assertEqual(spawn.calls, [])
                self.assertEqual(report["waiting"][0]["reason"], "busy")
                self.assertEqual(read_meta(td, "q1")["queue_position"], 1)

    def test_other_workers_are_independent(self):
        with tempfile.TemporaryDirectory() as td:
            write_job(td, "busy", worker="codex1", state="running", created=1)
            write_job(td, "q-codex", worker="codex1", state="queued", created=2)
            write_job(td, "q-claude", worker="claude1", provider="claude", state="queued", created=3)
            spawn = Spawned()
            scheduler.dispatch_once(td, spawn=spawn)
            self.assertEqual(spawn.calls, ["q-claude"])

    def test_chatgpt_job_is_handed_to_desktop_without_spawning(self):
        with tempfile.TemporaryDirectory() as td:
            write_job(td, "q1", worker="chatgpt-normal", provider="chatgpt-web", state="queued", created=2)
            spawn = Spawned()
            report = scheduler.dispatch_once(td, spawn=spawn)
            self.assertEqual(spawn.calls, [])
            self.assertEqual(report["dispatched"][0]["action"], "waiting_for_desktop")
            meta = read_meta(td, "q1")
            self.assertEqual(meta["state"], "waiting_for_desktop")
            self.assertEqual(meta["last_event"], "queued for embedded ChatGPT")
            self.assertIn("dispatched_at", meta)

    def test_cooldown_and_readiness_gate_dispatch(self):
        with tempfile.TemporaryDirectory() as td:
            write_job(td, "limited", state="failed", done=True, created=1, reason="usage_or_rate_limit",
                      ended=time.time())
            write_job(td, "q1", state="queued", created=2)
            spawn = Spawned()
            report = scheduler.dispatch_once(td, spawn=spawn)
            self.assertEqual(report["waiting"][0]["reason"], "cooldown")
            (Path(td) / "jobs" / "_cooldown_cleared.json").write_text(json.dumps({"codex1": time.time() + 1}),
                                                                     encoding="utf-8")
            report = scheduler.dispatch_once(td, spawn=spawn, is_ready=lambda worker: False)
            self.assertEqual(report["waiting"][0]["reason"], "not_ready")
            scheduler.dispatch_once(td, spawn=spawn, is_ready=lambda worker: True)
            self.assertEqual(spawn.calls, ["q1"])

    def test_cancel_marker_on_queued_job_skips_to_next(self):
        with tempfile.TemporaryDirectory() as td:
            first = write_job(td, "q1", state="queued", created=1)
            write_job(td, "q2", state="queued", created=2)
            (first / "CANCEL").write_text("cancel", encoding="utf-8")
            spawn = Spawned()
            scheduler.dispatch_once(td, spawn=spawn)
            self.assertEqual(spawn.calls, ["q2"])
            meta = read_meta(td, "q1")
            self.assertEqual((meta["state"], meta["reason"], meta["exit_code"]), ("cancelled", "cancelled", 1))
            self.assertTrue((first / "DONE").exists())

    def test_spawn_failure_fails_the_job(self):
        with tempfile.TemporaryDirectory() as td:
            write_job(td, "q1", state="queued", created=1)

            def broken(job_dir, meta):
                raise OSError("no runner")

            report = scheduler.dispatch_once(td, spawn=broken)
            self.assertEqual(report["dispatched"][0]["action"], "dispatch_error")
            meta = read_meta(td, "q1")
            self.assertEqual((meta["state"], meta["reason"], meta["exit_code"]), ("failed", "dispatch_error", 1))


class DoubleDispatchTests(unittest.TestCase):
    def test_concurrent_threads_start_a_queued_job_only_once(self):
        with tempfile.TemporaryDirectory() as td:
            write_job(td, "q1", state="queued", created=1)
            write_job(td, "q2", state="queued", created=2)
            spawn = Spawned(delay=0.3)
            barrier = threading.Barrier(6)

            def go():
                barrier.wait()
                scheduler.dispatch_once(td, spawn=spawn)

            threads = [threading.Thread(target=go) for _ in range(6)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(10)
            self.assertEqual(spawn.calls, ["q1"])
            self.assertEqual(read_meta(td, "q2")["state"], "queued")

    def test_concurrent_processes_start_a_queued_job_only_once(self):
        script = (
            "import sys, time, pathlib\n"
            "sys.path.insert(0, sys.argv[1])\n"
            "import scheduler\n"
            "plain_load = scheduler.load_jobs\n"
            "def widened(root):\n"
            "    jobs = plain_load(root)\n"
            "    time.sleep(0.5)  # widen the read-check-write window between dispatchers\n"
            "    return jobs\n"
            "scheduler.load_jobs = widened\n"
            "plain_write = scheduler._write_meta\n"
            "def slow_write(job_dir, meta):\n"
            "    time.sleep(0.3)\n"
            "    return plain_write(job_dir, meta)\n"
            "scheduler._write_meta = slow_write\n"
            "if len(sys.argv) > 5:  # control run without the OS lock\n"
            "    scheduler.SchedulerLock._try_os_lock = lambda self: open(self.path, 'a+b')\n"
            "root, log, start = sys.argv[2], pathlib.Path(sys.argv[3]), float(sys.argv[4])\n"
            "def spawn(job_dir, meta):\n"
            "    time.sleep(0.6)\n"
            "    with open(log, 'a', encoding='utf-8') as fh:\n"
            "        fh.write(pathlib.Path(job_dir).name + '\\n')\n"
            "    return 1\n"
            "time.sleep(max(0, start - time.time()))\n"
            "scheduler.dispatch_once(root, spawn=spawn)\n"
        )
        def race(td, *extra):
            log = Path(td) / "spawned.log"
            start = time.time() + 3.0
            procs = [subprocess.Popen([sys.executable, "-c", script, str(ROOT / "bridge"), td, str(log),
                                       str(start), *extra]) for _ in range(3)]
            codes = [proc.wait(30) for proc in procs]
            if not extra:
                self.assertEqual(codes, [0, 0, 0])
            return log.read_text(encoding="utf-8").split() if log.exists() else []

        with tempfile.TemporaryDirectory() as td:
            write_job(td, "q1", state="queued", created=1)
            write_job(td, "q2", state="queued", created=2)
            self.assertEqual(race(td), ["q1"])
            self.assertEqual(read_meta(td, "q1")["state"], "starting")
            self.assertEqual(read_meta(td, "q2")["state"], "queued")
        # Control: the same race without the OS lock double-dispatches, which shows
        # that the assertion above really exercises the lock (process start-up jitter
        # can serialize one run by chance, so allow a few attempts).
        spawned_without_lock = []
        for _ in range(4):
            with tempfile.TemporaryDirectory() as td:
                write_job(td, "q1", state="queued", created=1)
                spawned_without_lock = race(td, "--no-lock")
            if len(spawned_without_lock) > 1:
                break
        self.assertGreater(len(spawned_without_lock), 1)


class QueueOperationTests(unittest.TestCase):
    def make_queue(self, td):
        write_job(td, "active", state="running", created=1)
        for index, job_id in enumerate(("a", "b", "c"), 2):
            write_job(td, job_id, state="queued", created=index)
        scheduler.dispatch_once(td, spawn=Spawned())  # numbers the queue

    def test_list_move_and_cancel(self):
        with tempfile.TemporaryDirectory() as td:
            self.make_queue(td)
            listing = scheduler.queue_list(td)
            self.assertEqual(listing["total_queued"], 3)
            row = listing["workers"][0]
            self.assertEqual(row["current_job"]["id"], "active")
            self.assertEqual([item["job_id"] for item in row["queue"]], ["a", "b", "c"])

            moved = scheduler.queue_move(td, "c", 1)
            self.assertEqual(moved["queue"], ["c", "a", "b"])
            self.assertEqual([read_meta(td, j)["queue_position"] for j in ("c", "a", "b")], [1, 2, 3])
            scheduler.queue_move(td, "c", 99)  # clamps to the end
            self.assertEqual([i["job_id"] for i in scheduler.queue_list(td, "codex1")["workers"][0]["queue"]],
                             ["a", "b", "c"])

            scheduler.queue_cancel(td, "a")
            meta = read_meta(td, "a")
            self.assertEqual((meta["state"], meta["exit_code"]), ("cancelled", 1))
            self.assertTrue((Path(td) / "jobs" / "a" / "DONE").exists())
            self.assertEqual(read_meta(td, "b")["queue_position"], 1)
            with self.assertRaises(ValueError):
                scheduler.queue_cancel(td, "active")
            with self.assertRaises(ValueError):
                scheduler.queue_move(td, "active", 1)
            with self.assertRaises(ValueError):
                scheduler.queue_move(td, "../x", 1)

            # When the active job ends, the new head of the queue starts.
            (Path(td) / "jobs" / "active" / "DONE").write_text("done", encoding="utf-8")
            spawn = Spawned()
            scheduler.dispatch_once(td, spawn=spawn)
            self.assertEqual(spawn.calls, ["b"])


class ServerQueueTests(unittest.TestCase):
    registry = {
        "codex1": {"id": "codex1", "provider": "codex", "label": "Codex", "home": "C:/codex", "enabled": True},
        "chatgpt-normal": {"id": "chatgpt-normal", "provider": "chatgpt-web", "label": "ChatGPT",
                           "profile_id": "web", "enabled": True},
    }

    def patches(self, root):
        jobs = Path(root) / "jobs"
        jobs.mkdir(exist_ok=True)
        return [
            patch.object(server, "ROOT", Path(root)),
            patch.object(server, "JOBS", jobs),
            patch.object(server, "worker_registry", return_value=self.registry),
            patch.object(server, "worker_auth_status", return_value=(True, "ready")),
            patch.object(server, "worker_settings", return_value={}),
            patch.object(server, "cooldown_left", return_value=0),
            patch.object(server, "git", return_value="head"),
            patch.object(server, "config", return_value={"auto_resume": 2, "max_failovers": 2}),
            patch.object(server, "spawn_runner", return_value=5151),
        ]

    def run_patched(self, root, fn):
        ps = self.patches(root)
        for p in ps:
            p.start()
        try:
            return fn()
        finally:
            for p in reversed(ps):
                p.stop()

    def test_start_job_queues_behind_active_job_and_dispatches_when_free(self):
        with tempfile.TemporaryDirectory() as td:
            project = Path(td) / "project"
            project.mkdir()

            def scenario():
                first, _ = server.start_job("codex1", "one", project, queue=True)
                second, _ = server.start_job("codex1", "two", project, queue=True)
                third, _ = server.start_job("codex1", "three", project, queue=True)
                return first, second, third

            first, second, third = self.run_patched(td, scenario)
            self.assertEqual(read_meta(td, first)["state"], "starting")
            self.assertEqual(read_meta(td, first)["runner_pid"], 5151)
            self.assertEqual((read_meta(td, second)["state"], read_meta(td, second)["queue_position"]), ("queued", 1))
            self.assertEqual(read_meta(td, third)["queue_position"], 2)
            self.assertIsNone(read_meta(td, second).get("runner_pid"))

            (Path(td) / "jobs" / first / "DONE").write_text("done", encoding="utf-8")
            report = self.run_patched(td, server.dispatch_queue)
            self.assertEqual([item["job_id"] for item in report["dispatched"]], [second])
            self.assertEqual(read_meta(td, third)["queue_position"], 1)

    def test_queue_false_keeps_concurrent_start(self):
        with tempfile.TemporaryDirectory() as td:
            project = Path(td) / "project"
            project.mkdir()

            def scenario():
                a, _ = server.start_job("codex1", "one", project, queue=True)
                b, _ = server.start_job("codex1", "two", project, queue=False)
                return a, b

            a, b = self.run_patched(td, scenario)
            self.assertEqual(read_meta(td, b)["runner_pid"], 5151)
            self.assertNotEqual(read_meta(td, b)["state"], "queued")

    def test_chatgpt_jobs_queue_behind_waiting_for_desktop(self):
        with tempfile.TemporaryDirectory() as td:
            project = Path(td) / "project"
            project.mkdir()

            def scenario():
                a, _ = server.start_job("chatgpt-normal", "one", project, queue=True)
                b, _ = server.start_job("chatgpt-normal", "two", project, queue=True)
                return a, b

            a, b = self.run_patched(td, scenario)
            self.assertEqual(read_meta(td, a)["state"], "waiting_for_desktop")
            self.assertEqual(read_meta(td, b)["state"], "queued")

    def test_start_task_and_run_ai_worker_default_to_queue(self):
        with patch.object(server, "start_job", return_value=("job-1", "codex1")) as start, \
             patch.object(server, "read_meta", return_value={"state": "queued", "queue_position": 2}), \
             patch.object(server, "follow_info", return_value={}):
            result = server.tool_call("start_task", {"project_path": ".", "task": "t", "worker": "codex1"})
            self.assertTrue(start.call_args.kwargs["queue"])
            self.assertEqual((result["state"], result["queue_position"]), ("queued", 2))
            server.tool_call("start_task", {"project_path": ".", "task": "t", "queue": False})
            self.assertFalse(start.call_args.kwargs["queue"])
        with patch.object(server, "start_job", return_value=("job-1", "codex1")) as start, \
             patch.object(server, "job_wait", return_value={"timed_out": True}), \
             patch.object(server, "chain_summary", return_value={"state": "queued"}), \
             patch.object(server, "config", return_value={}), \
             patch.object(server, "follow_info", return_value={}):
            result = server.tool_call("run_ai_worker", {"project_path": ".", "task": "t"})
            self.assertTrue(start.call_args.kwargs["queue"])
            self.assertTrue(result["still_running"])

    def test_queue_tools_are_registered_with_schemas(self):
        names = {tool["name"]: tool for tool in server.TOOLS}
        for name in ("team_report", "queue_list", "queue_cancel", "queue_move"):
            self.assertIn(name, names)
        self.assertEqual(names["queue_move"]["inputSchema"]["required"], ["job_id", "position"])
        self.assertIn("queue", names["start_task"]["inputSchema"]["properties"])
        self.assertIn("queue", names["run_ai_worker"]["inputSchema"]["properties"])
        listed = {tool["name"] for tool in server.mcp_tools(include_legacy=True)}
        self.assertIn("teamyra.team_report", listed)
        self.assertIn("team_report", listed)
        self.assertIn("teamyra.queue_move", listed)

    def test_queue_tools_and_job_cancel_on_queued_job(self):
        with tempfile.TemporaryDirectory() as td:
            write_job(td, "active", state="running", created=1)
            write_job(td, "q1", state="queued", created=2)
            write_job(td, "q2", state="queued", created=3)
            jobs = Path(td) / "jobs"
            with patch.object(server, "JOBS", jobs):
                listing = server.tool_call("queue_list", {})
                self.assertEqual([i["job_id"] for i in listing["workers"][0]["queue"]], ["q1", "q2"])
                server.tool_call("queue_move", {"job_id": "q2", "position": 1})
                self.assertEqual(read_meta(td, "q2")["queue_position"], 1)
                result = server.tool_call("job_cancel", {"job_id": "q1"})
                self.assertIn("never started", result["note"])
                self.assertEqual(read_meta(td, "q1")["state"], "cancelled")
                self.assertFalse((jobs / "q1" / "CANCEL").exists())
                server.tool_call("queue_cancel", {"job_id": "q2"})
                self.assertEqual(read_meta(td, "q2")["state"], "cancelled")
                server.tool_call("job_cancel", {"job_id": "active"})
                self.assertTrue((jobs / "active" / "CANCEL").exists())

    def test_worker_status_reports_current_job_and_queue_length(self):
        with tempfile.TemporaryDirectory() as td:
            write_job(td, "active", state="needs_user", created=1, attention={"kind": "chatgpt_verification"})
            write_job(td, "q1", state="queued", created=2, queue_order=1)
            with patch.object(server, "JOBS", Path(td) / "jobs"), \
                 patch.object(server, "worker_registry", return_value={"codex1": self.registry["codex1"]}), \
                 patch.object(server, "worker_auth_status", return_value=(True, "ok")), \
                 patch.object(server, "worker_settings", return_value={"model": "m", "effort": "high"}), \
                 patch.object(server, "cooldown_left", return_value=0):
                rows = server.worker_status()
            row = rows[0]
            self.assertEqual(row["current_job"]["id"], "active")
            self.assertEqual(row["current_job"]["attention"], {"kind": "chatgpt_verification"})
            self.assertEqual(row["queue_length"], 1)
            self.assertEqual(row["queued_jobs"], ["q1"])
            self.assertEqual(row["running_jobs"], ["active"])

    def test_summary_includes_contract_fields(self):
        meta = {"id": "j", "state": "queued", "queue_position": 3, "reason": None, "exit_code": None,
                "attention": None, "created": time.time()}
        out = server.summary(meta)
        for key in ("exit_code", "reason", "attention", "queue_position"):
            self.assertIn(key, out)
        self.assertEqual(out["queue_position"], 3)


class RunnerHookTests(unittest.TestCase):
    def test_runner_dispatches_next_queued_job_on_exit(self):
        with tempfile.TemporaryDirectory() as td:
            finished = write_job(td, "finished", state="done", done=True, created=1)
            write_job(td, "q1", state="queued", created=2)
            spawn = Spawned()
            with patch.object(scheduler, "default_spawn", return_value=spawn):
                runner.dispatch_next(finished)
            self.assertEqual(spawn.calls, ["q1"])

    def test_runner_hook_never_raises(self):
        with patch.object(scheduler, "dispatch_once", side_effect=RuntimeError("boom")):
            runner.dispatch_next(Path(tempfile.gettempdir()) / "jobs" / "x")


class ReadinessProbeTests(unittest.TestCase):
    def setUp(self):
        server.AUTH_CACHE.clear()

    def tearDown(self):
        server.AUTH_CACHE.clear()

    def test_antigravity_probe_uses_30_second_timeout(self):
        info = {"id": "antigravity", "provider": "antigravity"}
        with patch.object(server, "agy_launch", return_value=["agy"]), \
             patch.object(server, "run", return_value=(0, "gemini\n", "")) as run:
            ready, _ = server.worker_auth_status(info, use_cache=False)
        self.assertTrue(ready)
        self.assertEqual(run.call_args.kwargs["timeout"], 30)

    def test_slow_probe_keeps_last_known_good(self):
        info = {"id": "antigravity", "provider": "antigravity"}
        with patch.object(server, "agy_launch", return_value=["agy"]):
            with patch.object(server, "run", return_value=(0, "gemini\n", "")):
                self.assertTrue(server.worker_auth_status(info, use_cache=False)[0])
            with patch.object(server, "run", side_effect=subprocess.TimeoutExpired(["agy"], 30)):
                ready, _ = server.worker_auth_status(info, use_cache=False)
            self.assertTrue(ready)
            entry = server.auth_snapshot("antigravity")
            self.assertEqual(entry["source"], "last_known_good")
            self.assertIn("timed out", entry["probe_error"])
            # A definitive answer still flips the worker.
            with patch.object(server, "run", return_value=(1, "", "not logged in")):
                self.assertFalse(server.worker_auth_status(info, use_cache=False)[0])

    def test_timeout_without_previous_success_is_not_ready(self):
        info = {"id": "codex1", "provider": "codex", "home": "C:/codex"}
        with patch.object(server, "codex_launch", return_value=["codex"]), \
             patch.object(server, "run", side_effect=subprocess.TimeoutExpired(["codex"], 8)):
            ready, detail = server.worker_auth_status(info, use_cache=False)
        self.assertFalse(ready)
        self.assertIn("timed out", detail)

    def test_last_known_good_expires(self):
        info = {"id": "claude1", "provider": "claude", "native": True}
        server.AUTH_CACHE["claude1"] = {"at": time.time() - 30, "ready": True, "detail": "ok", "source": "probe",
                                        "last_good_at": time.time() - server.AUTH_LAST_GOOD_SECONDS - 5}
        with patch.object(server, "claude_launch", return_value=["claude"]), \
             patch.object(server, "run", side_effect=subprocess.TimeoutExpired(["claude"], 8)):
            self.assertFalse(server.worker_auth_status(info, use_cache=False)[0])

    def test_stale_cache_is_served_and_refreshed_in_background(self):
        info = {"id": "codex1", "provider": "codex", "home": "C:/codex"}
        server.AUTH_CACHE["codex1"] = {"at": time.time() - 120, "ready": True, "detail": "logged in",
                                       "source": "probe", "last_good_at": time.time() - 120}
        with patch.object(server, "_refresh_auth_async") as refresh, \
             patch.object(server, "run") as run:
            ready, detail = server.worker_auth_status(info)
        self.assertEqual((ready, detail), (True, "logged in"))
        refresh.assert_called_once_with(info)
        run.assert_not_called()

    def test_background_refresh_probes_cli_workers_only(self):
        registry = {
            "codex1": {"id": "codex1", "provider": "codex"},
            "chatgpt-normal": {"id": "chatgpt-normal", "provider": "chatgpt-web"},
        }
        with patch.object(server, "worker_registry", return_value=registry), \
             patch.object(server, "worker_auth_status", return_value=(True, "ok")) as probe:
            self.assertEqual(server.refresh_worker_auth_all(), 1)
        probe.assert_called_once_with(registry["codex1"], use_cache=False)

    def test_scheduler_gate_uses_cache_only(self):
        self.assertTrue(server.scheduler_worker_ready("unknown"))
        server.AUTH_CACHE["codex1"] = {"at": time.time(), "ready": False, "detail": "x"}
        self.assertFalse(server.scheduler_worker_ready("codex1"))


class WorkspaceToolHandlerTests(unittest.TestCase):
    def test_uses_stored_permissions_and_honours_confirm_but_never_full_access(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "chatgpt").mkdir()
            (root / "chatgpt" / "workspace.json").write_text(json.dumps({
                "workspace": str(root),
                "permissions": {"write": False, "terminal": False, "full_access": True, "outside_workspace": True},
            }), encoding="utf-8")
            with patch.object(server, "ROOT", root), \
                 patch.object(server.workspace_tools.WorkspaceToolService, "execute_in_workspace",
                              return_value={"ok": True}) as execute:
                server.tool_call("workspace_tool", {"project_path": td, "tool": "filesystem.delete",
                                                    "args": {"path": "x"}, "confirm": True})
                kwargs = execute.call_args.kwargs
                self.assertTrue(kwargs["confirm"])
                self.assertFalse(kwargs["permissions"]["write"])
                self.assertFalse(kwargs["permissions"]["terminal"])
                self.assertFalse(kwargs["permissions"]["full_access"])
                self.assertFalse(kwargs["permissions"]["outside_workspace"])
                server.tool_call("workspace_tool", {"project_path": td, "tool": "filesystem.read",
                                                    "args": {"path": "x"}})
                self.assertFalse(execute.call_args.kwargs["confirm"])


class BackgroundServiceTests(unittest.TestCase):
    def test_background_dispatcher_starts_once_per_root(self):
        with tempfile.TemporaryDirectory() as td:
            (Path(td) / "jobs").mkdir()
            try:
                self.assertTrue(scheduler.start_background_dispatcher(td, spawn=Spawned(), interval=0.5))
                self.assertFalse(scheduler.start_background_dispatcher(td, spawn=Spawned(), interval=0.5))
                write_job(td, "q1", state="queued", created=1)
                deadline = time.time() + 5
                while time.time() < deadline and read_meta(td, "q1")["state"] == "queued":
                    time.sleep(0.1)
                self.assertEqual(read_meta(td, "q1")["state"], "starting")
            finally:
                self.assertTrue(scheduler.stop_background_dispatcher(td))
                time.sleep(0.6)  # let the loop observe the stop before the folder is removed


if __name__ == "__main__":
    unittest.main()
