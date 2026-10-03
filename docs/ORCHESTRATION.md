# TEAMYRA Orchestration

## Core model

TEAMYRA separates orchestration state from provider-native sessions.

- Jobs are provider worker executions.
- Failover chains represent bounded automatic reassignment after eligible worker/provider failure.
- Task graphs represent dependency-ordered multi-step work.
- Review cycles represent bounded reviewer -> fixer -> reviewer loops.
- Approval gates prevent sensitive graph nodes from starting without an explicit decision.
- Job handoffs send compact context from one completed worker to another worker/account.

## Automatic failover

For worker=auto, eligible provider/worker failures can be reassigned to another ready worker.

Eligible examples:
- usage/rate limit
- worker error
- runner crash
- provider-reported error

TEAMYRA does not automatically retry permission denial, explicit cancellation, or timeout as a failover condition.

Failover is bounded and preserves root/child lineage. job_wait and job_result are chain-aware.

## Task graphs and Conductor

A graph contains nodes with:
- id
- task
- worker
- dependencies
- write/read-only mode
- optional approval gate

The current Phase 3 Conductor executes one graph node at a time in dependency order in the same workspace. This is intentional.

Parallel write execution is deferred until Phase 4 provides first-class worktree merge/rebase semantics, so the orchestrator does not create unsafe concurrent writes to the same checkout.

MCP tools:
- graph_create
- graph_start
- graph_status
- graph_cancel
- graph_approve

## Approval gates

A graph node may set requires_approval=true and provide an approval_reason.

The Conductor enters waiting_approval instead of starting that node. graph_approve can explicitly approve or deny it.

Approval metadata is persisted in graph state.

## Reviewer/fixer loop

review_start launches a detached bounded review cycle for a completed implementation job.

The reviewer:
- is chosen from another ready worker when reviewer_worker=auto
- receives a read-only review task
- inspects the actual workspace
- must end with TEAMYRA_REVIEW: PASS or TEAMYRA_REVIEW: CHANGES

PASS closes the cycle.

CHANGES sends reviewer feedback back to the implementation worker/session for fixes, then starts another review round until PASS or max_rounds is reached.

MCP tools:
- review_start
- review_status
- review_cancel

## Structured cross-agent handoff

job_handoff passes compact source-job context to another worker/account:
- source and terminal job ids
- source worker/state
- diffstat
- compact git status
- clipped final message
- explicit handoff request

The target worker is instructed to inspect the actual workspace instead of trusting the source summary.

This supports patterns such as:
- Claude -> Codex implementation review
- Codex -> Claude architecture review
- Claude account A -> Claude account B
- Antigravity -> Codex continuation
- implementation -> testing worker

## Still pending

- dedicated deterministic tester loop / test-policy stage
- safe parallel graph execution
- first-class visual worktree merge/rebase flow
- richer UI for graphs, approvals, review cycles and handoffs
