import json
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
import zlib
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bridge"))
import codex_images


def png_bytes(width=1536, height=1024):
    raw = b"".join(b"\x00" + b"\x00" * (width * 3) for _ in range(1))
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


class FakeCodex:
    """Stands in for `codex exec`: writes an image into CODEX_HOME/generated_images/<thread>."""

    def __init__(self, behaviour=None, delay=0.05):
        self.behaviour = behaviour or {}
        self.delay = delay
        self.calls = []
        self.active = 0
        self.peak = 0
        self.lock = threading.Lock()

    def __call__(self, command, env=None, **kwargs):
        home = Path(env["CODEX_HOME"])
        with self.lock:
            self.calls.append({"home": home.name, "command": command})
            self.active += 1
            self.peak = max(self.peak, self.active)
        time.sleep(self.delay)
        with self.lock:
            self.active -= 1
        mode = self.behaviour.get(home.name, "ok")
        thread = f"thread-{uuid.uuid4().hex[:8]}-{home.name}"
        events = [{"type": "thread.started", "thread_id": thread}]
        if mode == "ok":
            folder = home / "generated_images" / thread
            folder.mkdir(parents=True)
            (folder / "exec-1.png").write_bytes(png_bytes())
            events.append({"type": "item.completed", "item": {"type": "agent_message", "text": "DONE"}})
        elif mode == "refused":
            events.append({"type": "item.completed", "item": {"type": "agent_message", "text": "REFUSED: violence"}})
        stderr = "ERROR: You've hit your usage limit." if mode == "limited" else ""
        return subprocess.CompletedProcess(command, 0, "\n".join(json.dumps(e) for e in events), stderr)


class CodexImageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.root = base / "root"
        self.project = base / "project"
        self.project.mkdir(parents=True)
        (self.project / "refs").mkdir()
        (self.project / "refs" / "hero.png").write_bytes(png_bytes(64, 64))
        self.homes = {}
        for name in ("codex1", "codex2"):
            home = base / name
            home.mkdir()
            (home / "auth.json").write_text("{}", encoding="utf-8")
            self.homes[name] = str(home)

    def batch(self, count=4, **kwargs):
        requests = [{"prompt": f"shot {i}", "output": f"out/img_{i}.png", "references": ["refs/hero.png"]}
                    for i in range(count)]
        return codex_images.create_batch(self.root, requests, str(self.project), spawn=False, **kwargs)

    def run_batch(self, batch, fake):
        folder = codex_images._batch_dir(self.root, batch["batch_id"])
        accounts = list(self.homes.items())
        with patch.object(codex_images, "codex_accounts", lambda root, wanted=None: accounts), \
                patch.object(codex_images, "codex_launch", lambda: ["codex"]), \
                patch.object(codex_images, "share_codex_sandbox", lambda home: []):
            codex_images.run_batch(self.root, folder, runner=fake)
        return codex_images.batch_status(self.root, batch["batch_id"])

    def test_requests_are_validated(self):
        with self.assertRaisesRegex(ValueError, "inside project_path"):
            codex_images.create_batch(self.root, [{"prompt": "x", "output": "../escape.png"}], str(self.project), spawn=False)
        with self.assertRaisesRegex(ValueError, "reference not found"):
            codex_images.create_batch(self.root, [{"prompt": "x", "output": "a.png", "references": ["nope.png"]}],
                                      str(self.project), spawn=False)
        with self.assertRaisesRegex(ValueError, "own output"):
            codex_images.create_batch(self.root, [{"prompt": "x", "output": "a.png"}, {"prompt": "y", "output": "A.png"}],
                                      str(self.project), spawn=False)

    def test_images_run_in_parallel_across_accounts(self):
        fake = FakeCodex(delay=0.2)
        status = self.run_batch(self.batch(6), fake)
        self.assertTrue(status["done"])
        self.assertEqual(status["counts"], {"completed": 6})
        self.assertGreater(fake.peak, 2, "more than one image per account at a time")
        self.assertLessEqual(fake.peak, 4, "two per account by default")
        self.assertEqual({call["home"] for call in fake.calls}, {"codex1", "codex2"})
        for item in status["items"]:
            self.assertTrue(Path(item["output"]).is_file())
            self.assertEqual((item["width"], item["height"]), (1536, 1024))
        command = fake.calls[0]["command"]
        self.assertIn("-i", command, "reference images are attached directly")
        self.assertEqual(command[command.index("--") - 1], str((self.project / "refs" / "hero.png").resolve()))
        self.assertIn("read-only", command)
        self.assertNotIn('model_reasoning_effort="low"', command, "image work keeps the usual effort")

    def test_account_at_its_limit_hands_work_to_the_other(self):
        fake = FakeCodex({"codex1": "limited"})
        status = self.run_batch(self.batch(3), fake)
        self.assertEqual(status["counts"], {"completed": 3})
        self.assertTrue(all(item["account"] == "codex2" for item in status["items"]))

    def test_refusal_is_reported_not_retried(self):
        fake = FakeCodex({"codex1": "refused", "codex2": "refused"})
        status = self.run_batch(self.batch(1), fake)
        self.assertEqual(status["items"][0]["status"], "refused")
        self.assertIn("violence", status["items"][0]["error"])
        self.assertEqual(len(fake.calls), 1)

    def test_cancel_stops_queued_images(self):
        batch = self.batch(3)
        status = codex_images.cancel_batch(self.root, batch["batch_id"])
        self.assertEqual(status["counts"], {"cancelled": 3})
        self.assertTrue(status["done"])

    def test_jpeg_output_is_converted(self):
        batch = codex_images.create_batch(self.root, [{"prompt": "x", "output": "out/a.jpg"}], str(self.project), spawn=False)
        try:
            import PIL  # noqa: F401
        except ImportError:
            self.skipTest("PIL not installed")
        fake = FakeCodex()
        with patch.object(codex_images, "_save_output", wraps=codex_images._save_output):
            status = self.run_batch(batch, fake)
        out = Path(status["items"][0]["output"])
        self.assertEqual(out.read_bytes()[:2], b"\xff\xd8")


if __name__ == "__main__":
    unittest.main()
