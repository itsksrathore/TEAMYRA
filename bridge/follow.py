"""Streams one job's live transcript until the job ends.

    python follow.py <job_id>

Prints transcript.md as it grows and exits when DONE appears: exit 0 if the job
finished, 1 if it failed or was cancelled. Run it as a background task so the
task view shows the worker's live process and its exit signals completion.
"""
import argparse, os, sys, time
from pathlib import Path

JOBS = Path(os.environ.get("TEAMYRA_ROOT") or Path(__file__).resolve().parent.parent) / "jobs"


def main(job_id, runtime_root=None):
    job = (Path(runtime_root) / "jobs" if runtime_root else JOBS) / job_id
    if not job.exists():
        print(f"no such job: {job_id}")
        return 2
    transcript, done = job / "transcript.md", job / "DONE"
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    pos = 0
    while True:
        finished = done.exists()  # check before reading so the last lines are never missed
        if transcript.exists():
            with open(transcript, encoding="utf-8", errors="replace") as f:
                f.seek(pos)
                chunk = f.read()
                pos = f.tell()
            if chunk:
                sys.stdout.write(chunk)
                sys.stdout.flush()
        if finished:
            state = done.read_text(encoding="utf-8").strip()
            print(f"\n[job {job_id} {state}]")
            return 0 if state == "done" else 1
        time.sleep(2)


def cli(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("job_id")
    parser.add_argument("--runtime-root")
    args = parser.parse_args(argv)
    return main(args.job_id, args.runtime_root)


if __name__ == "__main__":
    sys.exit(cli())
