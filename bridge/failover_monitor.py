"""Detached bounded failover supervisor for one TEAMYRA job chain.

Usage:
    python failover_monitor.py <root_job_id> <max_failovers>

The monitor never retries permission denials, explicit cancellation, or timeouts.
It only reassigns eligible worker/provider failures to another ready worker and
keeps lineage in each job's metadata.
"""
import sys
import time
from pathlib import Path

BRIDGE = Path(__file__).resolve().parent
sys.path.insert(0, str(BRIDGE))

import server


def main():
    root_job_id = sys.argv[1]
    max_failovers = max(0, min(int(sys.argv[2]), 5))
    current = root_job_id
    previous_workers = []
    attempt = 0

    server.patch_job_meta(
        root_job_id,
        auto_failover_enabled=True,
        max_failovers=max_failovers,
        failover_complete=False,
        failover_active_job=root_job_id,
    )

    while True:
        while not server.is_done(current):
            time.sleep(2)

        meta = server.read_meta(current)
        worker = meta.get("worker")
        if worker and worker not in previous_workers:
            previous_workers.append(worker)

        if not server.failover_eligible(meta):
            server.patch_job_meta(
                root_job_id,
                failover_complete=True,
                failover_active_job=current,
                failover_attempts=attempt,
                failover_terminal_state=meta.get("state"),
                failover_terminal_reason=meta.get("reason"),
            )
            return

        if attempt >= max_failovers:
            server.patch_job_meta(
                current,
                failover_exhausted=True,
                failover_error="maximum failover attempts reached",
            )
            server.patch_job_meta(
                root_job_id,
                failover_complete=True,
                failover_active_job=current,
                failover_attempts=attempt,
                failover_exhausted=True,
            )
            return

        attempt += 1
        try:
            info = server.start_failover_from_job(
                current,
                root_job_id=root_job_id,
                attempt=attempt,
                max_failovers=max_failovers,
                previous_workers=previous_workers,
            )
        except Exception as exc:
            server.patch_job_meta(
                current,
                failover_exhausted=True,
                failover_error=str(exc),
            )
            server.patch_job_meta(
                root_job_id,
                failover_complete=True,
                failover_active_job=current,
                failover_attempts=attempt - 1,
                failover_exhausted=True,
                failover_error=str(exc),
            )
            return

        current = info["job_id"]
        server.patch_job_meta(
            root_job_id,
            failover_active_job=current,
            failover_attempts=attempt,
        )


if __name__ == "__main__":
    main()
