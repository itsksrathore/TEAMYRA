# TEAMYRA Crash Recovery

TEAMYRA persists enough runtime state to safely reconcile work after the app, MCP gateway, worker bridge, or PC restarts.

## Startup behavior

The long-lived TEAMYRA HTTP MCP gateway runs one recovery scan before it begins accepting MCP requests.

Manual scan:

```powershell
teamyra recover
```

MCP tool:

```text
teamyra.recovery_scan
```

## Jobs

Each detached worker job persists:

- runner PID
- worker PID
- provider session ID when the provider exposes one
- runner heartbeat
- original command and provider-specific resume command
- timeout/deadline metadata
- transcript/events/final state

On recovery:

1. A live runner is trusted only when both its PID is alive and its heartbeat is recent.
2. If the runner is gone but a provider session ID + resume command exist, TEAMYRA resumes the **same job ID** and same provider session.
3. If no resumable session exists, TEAMYRA does **not** blindly rerun the original task. It marks the job failed with `crash_recovery_session_missing` and `manual_retry_required` metadata so partial workspace changes remain inspectable.

This avoids duplicate edits and accidental repeated destructive work.

## Task graphs

Conductor processes persist a PID and heartbeat.

If a graph is non-terminal and its conductor is no longer alive/recent, TEAMYRA restarts only the conductor monitor. Existing node job IDs and worktrees remain authoritative, so the recovered conductor first reconciles those persisted jobs instead of relaunching completed/running nodes.

## Review cycles

Reviewer/fixer loops are multi-step state machines. Re-entering the current monitor implementation from the top can duplicate reviewer or fixer jobs.

Therefore, when a non-terminal review monitor disappears, recovery preserves all review state and marks the cycle:

```text
state = interrupted
recovery_state = manual_resume_required
```

TEAMYRA deliberately does not spawn a duplicate review loop. A future review-state-machine upgrade can add deterministic automatic continuation from an exact persisted step.

## Failover monitors

Automatic failover supervisors persist:

- monitor PID
- heartbeat
- active failover job
- attempt counters
- previous-worker lineage

If the root failover chain is incomplete and its supervisor is dead/stale, TEAMYRA restarts the failover monitor after job recovery has already reconciled the underlying job state.

## PID reuse protection

Windows may reuse process IDs after a restart. TEAMYRA therefore does not treat PID existence alone as proof that a persisted process is still its process.

Runner, conductor, review, and failover monitor liveness checks require a recent heartbeat in addition to a live PID. If a PID is alive but its heartbeat is stale, TEAMYRA returns `stale_pid_unverified` with `requires_manual_check=true`; it does not trust that process and does not spawn a duplicate process automatically.

## Safety properties

- Recovery never uses shell command strings.
- Original tasks are not blindly replayed.
- Existing job IDs, sessions, worktrees, transcripts, and lineage are preserved.
- Terminal jobs/graphs/reviews are left unchanged.
- Alive/recent processes are not duplicated.
- Recovery reports errors per item rather than aborting the entire scan.
