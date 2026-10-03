"""Detached bounded reviewer/fixer loop for TEAMYRA."""
import sys
import time
from pathlib import Path

BRIDGE = Path(__file__).resolve().parent
sys.path.insert(0, str(BRIDGE))

import review_cycle
import server


def original_task(job_id):
    root_id = server.read_meta(job_id).get("failover_root") or job_id
    path = server.JOBS / root_id / "task.txt"
    return path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""


def review_prompt(source_job_id, implementation_job_id, task_text):
    return f"""You are the TEAMYRA reviewer.

Review the current workspace after implementation job {implementation_job_id}.
The original task was:

{task_text}

Inspect git status, git diff, relevant code, and tests. Do not modify files.
Be specific about correctness, regressions, security, and missing requirements.

End your response with exactly one marker line:
TEAMYRA_REVIEW: PASS
or
TEAMYRA_REVIEW: CHANGES

Use PASS only if the implementation is ready. Use CHANGES if concrete fixes are required.
Source job: {source_job_id}
"""


def fix_prompt(task_text, review_text):
    return f"""TEAMYRA review requested changes to your implementation.

Original task:
{task_text}

Reviewer feedback:
{review_text}

Inspect the current workspace and your previous work. Fix the concrete issues without undoing correct completed work.
Run appropriate tests and finish the original task. Do not merely explain the fixes.
"""


def cancel_active(state):
    job_id = state.get("active_job_id")
    if not job_id:
        return
    terminal_id = server.failover_terminal_job_id(job_id)
    if not server.is_done(terminal_id):
        (server.JOBS / terminal_id / "CANCEL").write_text("cancel", encoding="utf-8")


def finish(state, status, decision=None, error=None):
    state["state"] = status
    state["decision"] = decision
    state["error"] = error
    state["active_job_id"] = None
    review_cycle.save(server.ROOT, state)


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: review_monitor.py <review_id>")

    review_id = sys.argv[1]
    state = review_cycle.load(server.ROOT, review_id)
    state["state"] = "running"
    review_cycle.save(server.ROOT, state)

    source_job_id = state["source_job_id"]
    if not server.chain_is_complete(source_job_id):
        finish(state, "failed", error="source job is not complete")
        return

    source_result = server.job_result(source_job_id)
    if source_result.get("state") != "done":
        finish(state, "failed", error=f"source job ended in {source_result.get('state')}")
        return

    task_text = original_task(source_job_id)
    implementation_job_id = state.get("implementation_job_id") or source_job_id

    for round_no in range(1, int(state["max_rounds"]) + 1):
        state = review_cycle.load(server.ROOT, review_id)
        if state.get("cancel_requested"):
            cancel_active(state)
            finish(state, "cancelled", error="review cycle cancelled")
            return

        impl_terminal = server.failover_terminal_job_id(implementation_job_id)
        impl_meta = server.read_meta(impl_terminal)
        allow_self_review = state.get("allow_self_review", False)
        exclude = []
        if not allow_self_review and impl_meta.get("worker"):
            exclude = [impl_meta.get("worker")]
        requested_reviewer = state.get("reviewer_worker") or "auto"
        reviewer = requested_reviewer
        if reviewer == "auto":
            reviewer = server.pick_worker("auto", exclude=exclude)
        elif not allow_self_review and reviewer == impl_meta.get("worker"):
            finish(state, "failed", error="reviewer worker matched implementation worker")
            return

        review_job_id, review_worker = server.start_job(
            reviewer,
            review_prompt(source_job_id, implementation_job_id, task_text),
            impl_meta["cwd"],
            f"review {round_no}: {impl_meta.get('label') or source_job_id}"[:80],
            int(server.config().get("job_timeout_minutes", 180)),
            False,
            parent=implementation_job_id,
            auto_failover=requested_reviewer == "auto",
            max_failovers=server.config().get("max_failovers", 2),
        )
        server.patch_job_meta(
            review_job_id,
            review_cycle_id=review_id,
            review_round=round_no,
            review_role="reviewer",
            review_of=implementation_job_id,
        )
        state["round"] = round_no
        state["active_job_id"] = review_job_id
        state["review_jobs"].append(review_job_id)
        review_cycle.save(server.ROOT, state)

        server.job_wait([review_job_id], "all", int(server.config().get("job_timeout_minutes", 180)) * 60)
        review_result = server.job_result(review_job_id)
        if review_result.get("state") != "done":
            finish(state, "failed", error=f"review worker ended in {review_result.get('state')}")
            return

        review_text = review_result.get("final_message") or ""
        decision = review_cycle.parse_decision(review_text)
        state = review_cycle.load(server.ROOT, review_id)
        state["decision"] = decision
        state["active_job_id"] = None
        review_cycle.save(server.ROOT, state)

        if decision == "PASS":
            finish(state, "done", decision="PASS")
            return
        if decision != "CHANGES":
            finish(state, "failed", error="review response did not contain a TEAMYRA_REVIEW marker")
            return
        if round_no >= int(state["max_rounds"]):
            finish(state, "exhausted", decision="CHANGES", error="maximum review rounds reached")
            return

        impl_terminal = server.failover_terminal_job_id(implementation_job_id)
        impl_meta = server.read_meta(impl_terminal)
        session_id = impl_meta.get("session_id")
        fix_job_id, fix_worker = server.start_job(
            impl_meta["worker"],
            fix_prompt(task_text, review_text),
            impl_meta["cwd"],
            f"review fixes {round_no}: {impl_meta.get('label') or source_job_id}"[:80],
            int(server.config().get("job_timeout_minutes", 180)),
            True,
            session_id=session_id,
            parent=review_job_id,
            auto_failover=False,
        )
        server.patch_job_meta(
            fix_job_id,
            review_cycle_id=review_id,
            review_round=round_no,
            review_role="fixer",
            review_job_id=review_job_id,
        )
        state["active_job_id"] = fix_job_id
        state["fix_jobs"].append(fix_job_id)
        review_cycle.save(server.ROOT, state)

        server.job_wait([fix_job_id], "all", int(server.config().get("job_timeout_minutes", 180)) * 60)
        fix_result = server.job_result(fix_job_id)
        if fix_result.get("state") != "done":
            finish(state, "failed", error=f"fix worker ended in {fix_result.get('state')}")
            return

        implementation_job_id = fix_job_id
        state["implementation_job_id"] = implementation_job_id
        state["active_job_id"] = None
        review_cycle.save(server.ROOT, state)

    finish(state, "exhausted", decision=state.get("decision"), error="maximum review rounds reached")


if __name__ == "__main__":
    main()
