import json
import struct
import sys
import tempfile
import time
import unittest
import zlib
from contextlib import ExitStack
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bridge"))
import chatgpt_images
import server


def png_bytes(width=1536, height=1024):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(b"\x00" * 7)) + chunk(b"IEND", b"")


REGISTRY = {
    "codex1": {"provider": "codex", "label": "Codex Default"},
    "chatgpt-normal": {"provider": "chatgpt-web", "label": "ChatGPT Normal", "profile_id": "web",
                       "execution": "desktop-web", "enabled": True, "priority": 250},
    "chatgpt-2": {"provider": "chatgpt-web", "label": "ChatGPT Normal 2", "profile_id": "2",
                  "execution": "desktop-web", "enabled": True, "priority": 251},
    "deepseek-normal": {"provider": "deepseek-web", "label": "DeepSeek", "profile_id": "web",
                        "execution": "desktop-web", "enabled": True},
}


class FakeStart:
    """Stands in for server.start_job: writes a queued job like the real one."""

    def __init__(self, root):
        self.root = Path(root)
        self.calls = []

    def __call__(self, worker, task, project, **options):
        job_id = f"job-{len(self.calls) + 1}-{worker}"
        folder = self.root / "jobs" / job_id
        folder.mkdir(parents=True)
        meta = {"id": job_id, "worker": worker, "provider": REGISTRY[worker]["provider"],
                "worker_label": REGISTRY[worker]["label"], "state": "queued", "created": time.time()}
        (folder / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
        self.calls.append({"worker": worker, "task": task, "project": project, **options, "job_id": job_id})
        return job_id, worker


class ChatGPTImageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "runtime"
        (self.root / "jobs").mkdir(parents=True)
        self.project = Path(self.tmp.name) / "project"
        (self.project / "refs").mkdir(parents=True)
        (self.project / "refs" / "hero.png").write_bytes(png_bytes(512, 512))
        self.start = FakeStart(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def batch(self, requests, account=None):
        return chatgpt_images.create_batch(self.root, requests, str(self.project), account=account,
                                           start_job=self.start, registry=REGISTRY)

    def status(self, batch_id, start=True):
        return chatgpt_images.batch_status(self.root, batch_id, start_job=self.start if start else None,
                                           registry=REGISTRY)

    def finish(self, job_id, **meta):
        folder = self.root / "jobs" / job_id
        current = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
        current.update(ended=time.time(), **meta)
        (folder / "meta.json").write_text(json.dumps(current), encoding="utf-8")
        (folder / "DONE").write_text(current["state"], encoding="utf-8")

    def test_each_image_is_one_chatgpt_job_with_its_references(self):
        result = self.batch([
            {"prompt": "A hero in the rain, like Image 1", "output": "out/a.png", "references": ["refs/hero.png"]},
            {"prompt": "A city at dawn", "output": str(self.project / "out" / "b.webp"), "size": "1024x1536"},
        ])
        self.assertTrue(result["batch_id"].startswith("gimg-"))
        self.assertEqual([item["status"] for item in result["items"]], ["queued", "queued"])
        first, second = self.start.calls
        self.assertEqual(first["worker"], "chatgpt-normal")
        # The default account is not pinned (the scheduler spreads the jobs),
        # and an image job is never handed to another kind of agent.
        self.assertFalse(first["pin"])
        self.assertFalse(first["account_fixed"])
        self.assertIs(first["transfer"], False)
        self.assertTrue(first["queue"])
        self.assertEqual(first["expect_files"], ["out/a.png"])
        self.assertEqual(first["attachments"], ["refs/hero.png"])
        self.assertEqual(second["attachments"], [])
        self.assertIn('TEAMYRA_TOOL_REQUEST {"tool": "chatgpt.save_image", "args": {"path": "out/a.png", "index": 0}}',
                      first["task"])
        self.assertIn("Image 1) are the reference images", first["task"])
        self.assertIn("A hero in the rain", first["task"])
        self.assertIn("portrait", second["task"])
        self.assertIn("out/b.webp", second["task"])

    def test_bad_requests_are_refused_before_any_job(self):
        outside = Path(self.tmp.name) / "elsewhere.png"
        outside.write_bytes(png_bytes(10, 10))
        for request, message in [
            ({"prompt": "x", "output": "../escape.png"}, "inside project_path"),
            ({"prompt": "x", "output": "a.gif"}, ".png, .jpg or .webp"),
            ({"prompt": "", "output": "a.png"}, "prompt is required"),
            ({"prompt": "x", "output": "a.png", "references": ["refs/missing.png"]}, "reference not found"),
            ({"prompt": "x", "output": "a.png", "references": [str(outside)]}, "must be inside project_path"),
            ({"prompt": "x", "output": "a.png", "size": "800x600"}, "size must be one of"),
        ]:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                self.batch([request])
        with self.assertRaisesRegex(ValueError, "its own output"):
            self.batch([{"prompt": "x", "output": "a.png"}, {"prompt": "y", "output": "A.png"}])
        with self.assertRaisesRegex(ValueError, "unknown ChatGPT account"):
            self.batch([{"prompt": "x", "output": "a.png"}], account="deepseek-normal")
        self.assertEqual(self.start.calls, [])

    def test_status_follows_the_job_and_checks_the_saved_image(self):
        result = self.batch([{"prompt": "a", "output": "out/a.png"}, {"prompt": "b", "output": "out/b.png"},
                             {"prompt": "c", "output": "out/c.png"}, {"prompt": "d", "output": "out/d.png"}])
        jobs = [call["job_id"] for call in self.start.calls]
        meta = json.loads((self.root / "jobs" / jobs[0] / "meta.json").read_text())
        meta["state"] = "running"
        (self.root / "jobs" / jobs[0] / "meta.json").write_text(json.dumps(meta))
        self.assertEqual(self.status(result["batch_id"])["items"][0]["status"], "running")

        (self.project / "out").mkdir()
        (self.project / "out" / "a.png").write_bytes(png_bytes(1536, 1024))
        self.finish(jobs[0], state="done", reason=None)
        # Done, but nothing was saved / the file is not an image.
        self.finish(jobs[1], state="done", reason=None)
        (self.project / "out" / "c.png").write_text("not an image")
        self.finish(jobs[2], state="done", reason=None)
        self.finish(jobs[3], state="failed", reason="worker_error", last_event="error: page broke")
        status = self.status(result["batch_id"])
        first = status["items"][0]
        self.assertEqual((first["status"], first["width"], first["height"]), ("done", 1536, 1024))
        self.assertEqual(first["output"], str((self.project / "out" / "a.png").resolve()))
        self.assertEqual(first["worker"], "chatgpt-normal")
        self.assertEqual([item["status"] for item in status["items"][1:]], ["failed", "failed", "failed"])
        self.assertIn("no new image was saved", status["items"][1]["error"])
        self.assertIn("page broke", status["items"][3]["error"])
        self.assertTrue(status["done"])
        self.assertEqual(status["counts"], {"done": 1, "failed": 3})

    def test_a_limited_account_hands_the_image_to_another_chatgpt_account(self):
        result = self.batch([{"prompt": "a", "output": "out/a.png"}])
        first = self.start.calls[0]["job_id"]
        self.finish(first, state="failed", reason="usage_or_rate_limit",
                    limit_notice="You've hit your limit. Please try again in 2 hours.")
        status = self.status(result["batch_id"])
        item = status["items"][0]
        self.assertEqual(item["status"], "queued")
        self.assertEqual(item["worker"], "chatgpt-2")
        self.assertEqual(item["attempts"], 2)
        self.assertAlmostEqual(item["reset_at"], time.time() + 7200, delta=30)
        retry = self.start.calls[1]
        # A job for a named account stays on it.
        self.assertTrue(retry["pin"])
        self.assertTrue(retry["account_fixed"])

        # Both accounts at their limit: rate_limited with the reset time, and
        # nothing is started while they rest.
        self.finish(retry["job_id"], state="failed", reason="usage_or_rate_limit",
                    limit_notice="You've reached the message limit. It resets after 5:30 PM.")
        status = self.status(result["batch_id"])
        item = status["items"][0]
        self.assertEqual(item["status"], "rate_limited")
        self.assertIsNone(item["job_id"])
        self.assertEqual(datetime.fromtimestamp(item["reset_at"]).strftime("%H:%M"), "17:30")
        self.assertAlmostEqual(item["retry_at"], time.time() + 1800, delta=30)
        self.assertIn("next_retry_at", status)
        self.assertFalse(status["done"])
        self.assertEqual(len(self.start.calls), 2)
        self.assertEqual(self.status(result["batch_id"])["items"][0]["status"], "rate_limited")

        # The rest is over (cooldown cleared): the next status starts it again.
        (self.root / "jobs" / "_cooldown_cleared.json").write_text(json.dumps(
            {"chatgpt-normal": time.time() + 1, "chatgpt-2": time.time() + 1}))
        item = self.status(result["batch_id"])["items"][0]
        self.assertEqual(item["status"], "queued")
        self.assertEqual(item["attempts"], 3)
        self.assertEqual(len(self.start.calls), 3)

        # MAX_ATTEMPTS jobs hit a limit: the image fails.
        self.finish(self.start.calls[2]["job_id"], state="failed", reason="usage_or_rate_limit", limit_notice="Too many requests")
        (self.root / "jobs" / "_cooldown_cleared.json").write_text(json.dumps(
            {"chatgpt-normal": time.time() + 1, "chatgpt-2": time.time() + 1}))
        item = self.status(result["batch_id"])["items"][0]
        self.assertEqual(item["status"], "failed")
        self.assertIn("gave up after 3 attempts", item["error"])

    def test_accounts_cooling_down_are_skipped_at_start(self):
        limited = self.root / "jobs" / "old-chatgpt-normal"
        limited.mkdir()
        (limited / "meta.json").write_text(json.dumps({
            "id": "old-chatgpt-normal", "worker": "chatgpt-normal", "provider": "chatgpt-web", "state": "failed",
            "reason": "usage_or_rate_limit", "created": time.time() - 60, "ended": time.time() - 60,
            "limit_notice": "You've hit your limit. Try again in 30 minutes."}))
        (limited / "DONE").write_text("failed")
        self.batch([{"prompt": "a", "output": "a.png"}])
        self.assertEqual(self.start.calls[0]["worker"], "chatgpt-2")
        self.assertTrue(self.start.calls[0]["account_fixed"])

        # Only the resting account is allowed: nothing starts, rate_limited.
        result = self.batch([{"prompt": "b", "output": "b.png"}], account="ChatGPT Normal")
        item = result["items"][0]
        self.assertEqual(item["status"], "rate_limited")
        self.assertAlmostEqual(item["reset_at"], time.time() + 1740, delta=30)
        self.assertEqual(len(self.start.calls), 1)
        self.assertEqual(result["account"], "chatgpt-normal")

    def test_a_named_account_pins_every_job(self):
        self.batch([{"prompt": "a", "output": "a.png"}], account="chatgpt-normal")
        self.assertTrue(self.start.calls[0]["pin"])
        self.assertTrue(self.start.calls[0]["account_fixed"])
        self.assertEqual(self.start.calls[0]["worker"], "chatgpt-normal")

    def test_cancel_stops_jobs_and_waiting_images(self):
        result = self.batch([{"prompt": "a", "output": "a.png"}, {"prompt": "b", "output": "b.png"}])
        self.finish(self.start.calls[1]["job_id"], state="failed", reason="usage_or_rate_limit", limit_notice="Rate limited")
        for worker in ("chatgpt-normal", "chatgpt-2"):
            folder = self.root / "jobs" / f"limit-{worker}"
            folder.mkdir()
            (folder / "meta.json").write_text(json.dumps({"worker": worker, "provider": "chatgpt-web", "state": "failed",
                                                          "reason": "usage_or_rate_limit", "created": time.time(),
                                                          "ended": time.time()}))
        self.assertEqual(self.status(result["batch_id"])["items"][1]["status"], "rate_limited")
        cancelled = []

        def cancel(job_id):
            cancelled.append(job_id)
            self.finish(job_id, state="cancelled", reason="cancelled")

        status = chatgpt_images.cancel_batch(self.root, result["batch_id"], cancel)
        self.assertEqual(cancelled, [self.start.calls[0]["job_id"]])
        self.assertEqual([item["status"] for item in status["items"]], ["cancelled", "cancelled"])
        self.assertTrue(status["done"])
        self.assertEqual(len(self.start.calls), 2)

    def test_limit_reset_wording(self):
        base = datetime(2026, 11, 21, 14, 0).timestamp()
        self.assertEqual(chatgpt_images.limit_reset("Try again in 3 hours.", base), base + 3 * 3600)
        self.assertEqual(chatgpt_images.limit_reset("Your limit resets in 45 minutes", base), base + 45 * 60)
        self.assertEqual(chatgpt_images.limit_reset("You can generate more images after 9:15 PM.", base),
                         datetime(2026, 11, 21, 21, 15).timestamp())
        self.assertEqual(chatgpt_images.limit_reset("resets at 10:00 AM", base), datetime(2026, 11, 22, 10, 0).timestamp())
        self.assertIsNone(chatgpt_images.limit_reset("You've hit your limit. Please try again later.", base))
        self.assertIsNone(chatgpt_images.limit_reset("Upgrade for more", base))

    def test_image_header_sizes(self):
        self.assertEqual(chatgpt_images.image_header_size(png_bytes(640, 480)), (640, 480))
        jpeg = b"\xff\xd8\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00" + b"\x00" * 9 + \
            b"\xff\xc0" + struct.pack(">HBHH", 17, 8, 1024, 1536) + b"\x03" + b"\x00" * 9
        self.assertEqual(chatgpt_images.image_header_size(jpeg), (1536, 1024))
        webp = b"RIFF" + b"\x00" * 4 + b"WEBPVP8X" + b"\x00" * 8 + (1535).to_bytes(3, "little") + (1023).to_bytes(3, "little")
        self.assertEqual(chatgpt_images.image_header_size(webp), (1536, 1024))
        self.assertIsNone(chatgpt_images.image_header_size(b"<html>not an image</html>"))


class ChatGPTImageServerTests(unittest.TestCase):
    def test_tools_are_listed_with_their_schemas(self):
        tools = {tool["name"]: tool for tool in server.TOOLS}
        batch = tools["chatgpt_image_batch"]["inputSchema"]
        self.assertEqual(batch["required"], ["project_path", "requests"])
        self.assertEqual(set(batch["properties"]), {"project_path", "requests", "account"})
        item = batch["properties"]["requests"]["items"]
        self.assertEqual(set(item["properties"]), {"prompt", "output", "references", "size"})
        self.assertEqual(item["required"], ["prompt", "output"])
        self.assertEqual(tools["chatgpt_image_status"]["inputSchema"]["required"], ["batch_id"])
        self.assertIn("chatgpt_image_cancel", tools)

    def test_batch_runs_through_the_real_start_job(self):
        with tempfile.TemporaryDirectory() as td, ExitStack() as stack:
            root = Path(td)
            jobs = root / "jobs"
            jobs.mkdir()
            project = root / "project"
            (project / "refs").mkdir(parents=True)
            (project / "refs" / "a.png").write_bytes(png_bytes(64, 64))
            registry = {name: info for name, info in REGISTRY.items() if info["provider"] == "chatgpt-web"}
            for name, value in {"ROOT": root, "JOBS": jobs}.items():
                stack.enter_context(patch.object(server, name, value))
            for name, value in {"worker_registry": registry, "worker_auth_status": (True, "ready"),
                                "worker_settings": {}, "git": "head", "config": {}, "dispatch_queue": None,
                                "_wake_desktop_async": None}.items():
                stack.enter_context(patch.object(server, name, return_value=value))
            stack.enter_context(patch.object(server.desktop_runtime, "desktop_ready", return_value=True))
            result = server.tool_call("chatgpt_image_batch", {"project_path": str(project), "requests": [
                {"prompt": "a cat like Image 1", "output": "img/cat.png", "references": ["refs/a.png"]}]})
            item = result["items"][0]
            self.assertEqual(item["status"], "queued")
            spec = json.loads((jobs / item["job_id"] / "spec.json").read_text(encoding="utf-8"))
            meta = json.loads((jobs / item["job_id"] / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(spec["attachments"], ["refs/a.png"])
            self.assertEqual(spec["expect_files"], ["img/cat.png"])
            self.assertIs(meta["transfer"], False)
            self.assertEqual(meta["state"], "queued")
            self.assertIn("chatgpt.save_image", (jobs / item["job_id"] / "task.txt").read_text(encoding="utf-8"))
            status = server.tool_call("chatgpt_image_status", {"batch_id": result["batch_id"]})
            self.assertEqual(status["items"][0]["status"], "queued")
            with self.assertRaisesRegex(ValueError, "attachment not found"):
                server.start_job("chatgpt-normal", "x", str(project), attachments=["refs/none.png"])
            with self.assertRaisesRegex(ValueError, "inside project_path"):
                server.start_job("chatgpt-normal", "x", str(project), attachments=["../outside.png"])


if __name__ == "__main__":
    unittest.main()
