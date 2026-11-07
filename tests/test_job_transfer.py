import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import job_transfer
import scheduler

CONFIG = {"transfer": {"enabled": True, "max_transfers": 3, "wait_minutes": 30, "pause_minutes": 5}}


def write_status(root, folder, profiles):
    path = Path(root) / folder
    path.mkdir(parents=True, exist_ok=True)
    (path / "status.json").write_text(json.dumps({"heartbeat_at": time.time(), "active_profile_id": "web",
                                                  "profiles": profiles}), encoding="utf-8")


def ready(lanes=5, **extra):
    return {"automation_ready": True, "session_present": True, "lanes": lanes, **extra}


def add_profile(root, provider, profile_id, name):
    path = Path(root) / "profiles" / provider / profile_id
    path.mkdir(parents=True, exist_ok=True)
    (path / "teamyra-profile.json").write_text(json.dumps({"name": name}), encoding="utf-8")


def write_job(root, job_id, *, worker="chatgpt-normal", provider="chatgpt-web", state="failed", done=True,
              events=(), task="Build the thing", **extra):
    job = Path(root) / "jobs" / job_id
    job.mkdir(parents=True, exist_ok=True)
    meta = {"id": job_id, "worker": worker, "provider": provider, "state": state, "label": "build",
            "worker_label": worker, "cwd": str(root), "created": time.time() - 100, "timeout_s": 3600,
            "ended": time.time() - 5, "failover_attempt": 0}
    meta.update(extra)
    (job / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    (job / "spec.json").write_text(json.dumps({"worker": worker, "provider": provider, "cmd": [],
                                               "cwd": str(root), "profile_id": "web"}), encoding="utf-8")
    (job / "task.txt").write_text(task, encoding="utf-8")
    with open(job / "events.jsonl", "w", encoding="utf-8") as handle:
        for kind, text in events:
            handle.write(json.dumps({"ts": time.time(), "kind": kind, "text": text}) + "\n")
    if done:
        (job / "DONE").write_text(state, encoding="utf-8")
    return job


def read_meta(root, job_id):
    return json.loads((Path(root) / "jobs" / job_id / "meta.json").read_text(encoding="utf-8"))


class FakeStart:
    """Stands in for server.start_job: creates the new job folder."""

    def __init__(self, root, refuse=()):
        self.root = Path(root)
        self.calls = []
        self.refuse = set(refuse)

    def __call__(self, worker, task, cwd, **kwargs):
        if worker in self.refuse:
            raise ValueError(f"{worker} is not ready")
        new_id = f"new-{len(self.calls) + 1}-{worker}"
        self.calls.append({"worker": worker, "task": task, **kwargs})
        write_job(self.root, new_id, worker=worker, provider="?", state="queued", done=False, task=task,
                  parent=kwargs.get("parent"), failover_attempt=kwargs.get("failover_attempt"),
                  failover_root=kwargs.get("failover_root"))
        return new_id, worker


class TransferTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.root = Path(self.td.name)
        (self.root / "jobs").mkdir()
        scheduler._META_CACHE.clear()

    def tearDown(self):
        self.td.cleanup()

    def test_failed_job_moves_to_another_account_of_the_same_site_first(self):
        add_profile(self.root, "chatgpt-web", "acc2", "ChatGPT Normal 2")
        write_status(self.root, "chatgpt", {"web": ready(challenged=True), "acc2": ready()})
        write_status(self.root, "deepseek", {"web": ready()})
        write_job(self.root, "j1", reason="needs_user_timeout", events=[
            ("command", 'filesystem.read {"path":"D:/p/README.md"}'),
            ("result", '{"path":"D:/p/README.md","content":"hello"}'),
            ("command", 'filesystem.create {"path":"D:/p/src/a.ts","content":"export const a = 1;"}'),
            ("result", '{"path":"D:/p/src/a.ts","bytes":20}'),
            ("command", 'terminal.run {"argv":["npm","test"]}'),
            ("result", '{"argv":["npm","test"],"exit_code":1,"stdout":"","stderr":"1 failing"}'),
        ])
        start = FakeStart(self.root)
        moved = job_transfer.sweep(self.root, start, CONFIG)
        self.assertEqual(len(moved), 1)
        call = start.calls[0]
        self.assertEqual(call["worker"], "chatgpt-acc2")
        self.assertEqual(call["parent"], "j1")
        self.assertEqual(call["failover_attempt"], 1)
        self.assertEqual(call["failover_root"], "j1")
        pack = call["task"]
        self.assertIn("TEAMYRA HANDOVER", pack)
        self.assertIn("Build the thing", pack)
        self.assertIn("read D:/p/README.md", pack)
        self.assertIn("wrote D:/p/src/a.ts", pack)
        self.assertIn("ran `npm test` -> exit 1 (1 failing)", pack)
        self.assertIn("human check or sign-in", pack)
        old = read_meta(self.root, "j1")
        self.assertEqual(old["failover_job_id"], moved[0]["new_job_id"])
        self.assertEqual(old["failover_worker"], "chatgpt-acc2")
        # Done once: a second sweep does nothing.
        self.assertEqual(job_transfer.sweep(self.root, start, CONFIG), [])
        self.assertEqual(len(start.calls), 1)

    def test_limit_skips_cooling_accounts_and_goes_to_another_model(self):
        write_status(self.root, "chatgpt", {"web": ready()})
        write_status(self.root, "deepseek", {"web": ready()})
        write_job(self.root, "j1", reason="usage_or_rate_limit")
        start = FakeStart(self.root)
        job_transfer.sweep(self.root, start, CONFIG)
        # chatgpt-normal is cooling down (its job ended on a limit) and was tried.
        self.assertEqual(start.calls[0]["worker"], "deepseek-normal")

    def test_a_broken_page_goes_to_another_site_before_another_account(self):
        add_profile(self.root, "qwen-web", "acc2", "Qwen 2")
        write_status(self.root, "qwen", {"web": ready(), "acc2": ready()})
        write_status(self.root, "deepseek", {"web": ready()})
        write_job(self.root, "j1", worker="qwen-normal", provider="qwen-web", reason="page_unresponsive")
        start = FakeStart(self.root)
        job_transfer.sweep(self.root, start, CONFIG)
        self.assertEqual(start.calls[0]["worker"], "deepseek-normal")
        # With no other site ready, the other account of the same site is still used.
        scheduler._META_CACHE.clear()
        write_status(self.root, "deepseek", {"web": ready(challenged=True)})
        write_job(self.root, "j2", worker="qwen-normal", provider="qwen-web", reason="page_unresponsive")
        job_transfer.sweep(self.root, start, CONFIG)
        self.assertEqual(start.calls[-1]["worker"], "qwen-acc2")

    def test_site_block_moves_to_another_site_and_skips_the_whole_site(self):
        # ChatGPT "unusual activity coming from your system": every ChatGPT account is skipped.
        add_profile(self.root, "chatgpt-web", "acc2", "ChatGPT Normal 2")
        write_status(self.root, "chatgpt", {"web": ready(), "acc2": ready()})
        write_status(self.root, "deepseek", {"web": ready()})
        write_job(self.root, "j1", reason="site_blocked")
        start = FakeStart(self.root)
        job_transfer.sweep(self.root, start, CONFIG)
        self.assertEqual(start.calls[0]["worker"], "deepseek-normal")
        self.assertIn("refused this PC", start.calls[0]["task"])
        # A queued ChatGPT job leaves the blocked site too, even on the other account.
        scheduler._META_CACHE.clear()
        old = time.time() - 6 * 60
        write_job(self.root, "q1", worker="chatgpt-acc2", state="queued", done=False, queued_at=old)
        moved = job_transfer.move_unstarted(self.root, CONFIG)
        self.assertEqual([(m["job_id"], m["to"]) for m in moved], [("q1", "deepseek-normal")])

    def test_site_down_moves_to_another_site(self):
        add_profile(self.root, "glm-web", "acc2", "GLM 2")
        write_status(self.root, "glm", {"web": ready(), "acc2": ready()})
        write_status(self.root, "muse", {"web": ready()})
        write_job(self.root, "j1", worker="glm-normal", provider="glm-web", reason="site_down")
        start = FakeStart(self.root)
        job_transfer.sweep(self.root, start, CONFIG)
        self.assertEqual(start.calls[0]["worker"], "muse-normal")
        self.assertIn("not answering", start.calls[0]["task"])

    def test_move_on_request_to_a_site_or_a_named_worker(self):
        add_profile(self.root, "deepseek-web", "acc2", "DeepSeek 2")
        write_status(self.root, "chatgpt", {"web": ready()})
        write_status(self.root, "deepseek", {"web": ready(), "acc2": ready()})
        write_status(self.root, "muse", {"web": ready()})
        write_job(self.root, "j1", state="cancelled", reason="cancelled", events=[
            ("command", 'filesystem.read {"path":"D:/p/a.py"}'), ("result", '{"content":"x"}')])
        start = FakeStart(self.root)
        moved = job_transfer.move_job(self.root, read_meta(self.root, "j1"), start, provider="deepseek-web")
        self.assertTrue(start.calls[0]["worker"].startswith("deepseek-"))
        self.assertIn("moved it to you", start.calls[0]["task"])
        self.assertIn("read D:/p/a.py", start.calls[0]["task"])
        meta = read_meta(self.root, "j1")
        self.assertEqual((meta["failover_job_id"], meta["reason"]), (moved["new_job_id"], "moved_by_request"))
        # A named worker is used as given, even another provider.
        write_job(self.root, "j2", state="failed", reason="worker_error")
        job_transfer.move_job(self.root, read_meta(self.root, "j2"), start, worker="muse-normal")
        self.assertEqual(start.calls[-1]["worker"], "muse-normal")
        with self.assertRaises(ValueError):
            job_transfer.move_job(self.root, read_meta(self.root, "j2"), start, worker="no-such-worker")
        options = job_transfer.move_options(self.root, read_meta(self.root, "j1"))
        self.assertTrue(options and all({"worker", "label", "site", "free"} <= set(o) for o in options))

    def test_a_free_tab_beats_a_busy_account_of_the_same_site(self):
        add_profile(self.root, "chatgpt-web", "acc2", "ChatGPT Normal 2")
        write_status(self.root, "chatgpt", {"web": ready(), "acc2": ready(lanes=1)})
        write_status(self.root, "muse", {"web": ready()})
        write_job(self.root, "busy", worker="chatgpt-acc2", state="running", done=False)
        write_job(self.root, "j1", reason="worker_error")
        start = FakeStart(self.root)
        job_transfer.sweep(self.root, start, CONFIG)
        self.assertEqual(start.calls[0]["worker"], "muse-normal")

    def test_chain_continues_and_stops_at_the_maximum(self):
        write_status(self.root, "chatgpt", {"web": ready()})
        write_status(self.root, "muse", {"web": ready()})
        write_status(self.root, "deepseek", {"web": ready()})
        write_job(self.root, "j1", reason="worker_error", failover_job_id="j2")
        write_job(self.root, "j2", worker="muse-normal", provider="muse-web", reason="worker_error",
                  parent="j1", failover_attempt=1, failover_root="j1", task="HANDOVER pack, not the original")
        start = FakeStart(self.root)
        job_transfer.sweep(self.root, start, CONFIG)
        call = start.calls[0]
        self.assertEqual(call["worker"], "deepseek-normal")  # both earlier workers were tried
        self.assertEqual(call["failover_attempt"], 2)
        self.assertEqual(call["failover_root"], "j1")
        self.assertIn("Build the thing", call["task"])  # the first job's task, not the earlier pack
        self.assertNotIn("HANDOVER pack, not the original", call["task"])
        write_job(self.root, "j9", reason="worker_error", failover_attempt=3)
        self.assertFalse(job_transfer.transfer_expected(read_meta(self.root, "j9"), config=CONFIG))

    def test_no_ready_agent_waits_then_gives_up(self):
        write_status(self.root, "chatgpt", {"web": ready()})
        write_job(self.root, "j1", reason="usage_or_rate_limit")
        start = FakeStart(self.root)
        self.assertEqual(job_transfer.sweep(self.root, start, CONFIG), [])
        meta = read_meta(self.root, "j1")
        self.assertTrue(meta["transfer_waiting_since"])
        self.assertTrue(job_transfer.transfer_expected(meta, config=CONFIG))  # job_wait keeps waiting
        meta["ended"] = time.time() - 31 * 60
        (self.root / "jobs" / "j1" / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
        scheduler._META_CACHE.clear()  # finished jobs are cached for a minute
        job_transfer.sweep(self.root, start, CONFIG)
        meta = read_meta(self.root, "j1")
        self.assertTrue(meta["transfer_exhausted"])
        self.assertFalse(job_transfer.transfer_expected(meta, config=CONFIG))

    def test_not_moved_cases(self):
        write_status(self.root, "chatgpt", {"web": ready()})
        write_status(self.root, "muse", {"web": ready()})
        write_job(self.root, "timeout", reason="timeout")
        write_job(self.root, "cancel", state="cancelled", reason="cancelled")
        write_job(self.root, "optout", reason="worker_error", transfer=False)
        write_job(self.root, "cli", worker="codex1", provider="codex", reason="worker_error")
        write_job(self.root, "old", reason="worker_error", ended=time.time() - 3 * 3600)
        write_job(self.root, "monitor", reason="worker_error", auto_failover_enabled=True)
        start = FakeStart(self.root)
        self.assertEqual(job_transfer.sweep(self.root, start, CONFIG), [])
        self.assertEqual(start.calls, [])

    def test_a_refusing_worker_is_skipped(self):
        add_profile(self.root, "chatgpt-web", "acc2", "ChatGPT Normal 2")
        write_status(self.root, "chatgpt", {"web": ready(), "acc2": ready()})
        write_status(self.root, "muse", {"web": ready()})
        write_job(self.root, "j1", reason="worker_error")
        start = FakeStart(self.root, refuse={"chatgpt-acc2"})
        job_transfer.sweep(self.root, start, CONFIG)
        self.assertEqual(start.calls[0]["worker"], "muse-normal")

    def test_unstarted_jobs_leave_a_blocked_account(self):
        write_status(self.root, "chatgpt", {"web": ready(challenged=True)})
        write_status(self.root, "muse", {"web": ready()})
        old = time.time() - 6 * 60
        write_job(self.root, "q1", state="queued", done=False, queued_at=old)
        write_job(self.root, "w1", state="waiting_for_desktop", done=False, dispatched_at=old)
        write_job(self.root, "w2", state="waiting_for_desktop", done=False, dispatched_at=old)
        (self.root / "jobs" / "w2" / "chatgpt-state.json").write_text("{}", encoding="utf-8")  # already started
        write_job(self.root, "fresh", state="queued", done=False, queued_at=time.time())
        moved = job_transfer.move_unstarted(self.root, CONFIG)
        self.assertEqual(sorted(item["job_id"] for item in moved), ["q1", "w1"])
        for job_id in ("q1", "w1"):
            meta = read_meta(self.root, job_id)
            self.assertEqual((meta["worker"], meta["provider"], meta["state"]), ("muse-normal", "muse-web", "queued"))
            self.assertIn("chatgpt-normal", meta["previous_workers"])
            spec = json.loads((self.root / "jobs" / job_id / "spec.json").read_text(encoding="utf-8"))
            self.assertEqual((spec["worker"], spec["provider"]), ("muse-normal", "muse-web"))
        self.assertEqual(read_meta(self.root, "w2")["worker"], "chatgpt-normal")
        self.assertEqual(read_meta(self.root, "fresh")["worker"], "chatgpt-normal")

    def test_unstarted_job_leaves_an_account_whose_page_never_got_ready(self):
        write_status(self.root, "chatgpt", {"web": {"automation_ready": False, "session_present": False}})
        write_status(self.root, "muse", {"web": ready()})
        write_job(self.root, "w1", state="waiting_for_desktop", done=False, dispatched_at=time.time() - 6 * 60)
        moved = job_transfer.move_unstarted(self.root, CONFIG)
        self.assertEqual([item["job_id"] for item in moved], ["w1"])
        self.assertEqual(read_meta(self.root, "w1")["worker"], "muse-normal")
        self.assertIn("did not get its page ready", read_meta(self.root, "w1")["last_event"])

    def test_site_block_left(self):
        now = time.time()
        metas = [{"provider": "glm-web", "reason": "site_down", "ended": now - 600},
                 {"provider": "glm-web", "reason": "worker_error", "ended": now},
                 {"provider": "muse-web", "reason": "site_down", "ended": now - 2000}]
        self.assertAlmostEqual(job_transfer.site_block_left(metas, "glm-web", now), 1200, delta=1)
        self.assertEqual(job_transfer.site_block_left(metas, "muse-web", now), 0)
        self.assertEqual(job_transfer.site_block_left(metas, "deepseek-web", now), 0)

    def test_move_after_an_automatic_hand_over_starts_no_second_job(self):
        # ISS-20261107-173858: job_move and the sweep both started a continuation.
        write_status(self.root, "chatgpt", {"web": ready()})
        write_status(self.root, "muse", {"web": ready()})
        write_job(self.root, "j1", reason="page_unresponsive")
        start = FakeStart(self.root)
        job_transfer.sweep(self.root, start, CONFIG)
        self.assertEqual(len(start.calls), 1)
        with self.assertRaisesRegex(ValueError, "already continues"):
            job_transfer.move_job(self.root, read_meta(self.root, "j1"), start, worker="muse-normal")
        self.assertEqual(len(start.calls), 1, "no second continuation")
        self.assertFalse((self.root / "jobs" / "j1" / job_transfer.CLAIM_FILE).exists(), "the claim is released")

    def test_an_account_that_keeps_hanging_is_skipped(self):
        write_status(self.root, "chatgpt", {"web": ready()})
        write_status(self.root, "muse", {"web": ready()})
        for job_id in ("h1", "h2"):
            write_job(self.root, job_id, reason="page_unresponsive", transfer=False)
        write_job(self.root, "w1", state="waiting_for_desktop", done=False, dispatched_at=time.time() - 6 * 60)
        moved = job_transfer.move_unstarted(self.root, CONFIG)
        self.assertEqual([item["job_id"] for item in moved], ["w1"])
        self.assertEqual(read_meta(self.root, "w1")["worker"], "muse-normal")
        self.assertIn("kept hanging", read_meta(self.root, "w1")["last_event"])

    def test_pause_over(self):
        now = time.time()
        self.assertFalse(job_transfer.pause_over({"attention": {"since": now - 60}}, CONFIG, now))
        self.assertTrue(job_transfer.pause_over({"attention": {"since": now - 6 * 60}}, CONFIG, now))
        self.assertFalse(job_transfer.pause_over({}, CONFIG, now))


if __name__ == "__main__":
    unittest.main()
