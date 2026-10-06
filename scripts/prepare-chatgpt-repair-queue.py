"""Prepare the authorized ChatGPT recovery/review queue without changing ChatCut source."""
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
QUEUE = ROOT / "tasks" / "chatgpt-repair-20261005"
QUEUE.mkdir(parents=True, exist_ok=True)
inputs = ROOT / ".review-in"
inputs.mkdir(exist_ok=True)
paths = ["apps/desktop/src/chatgpt-automation-adapter.js", "apps/desktop/src/chatgpt-web-provider.js", "bridge/workspace_tools.py", "bridge/teamyra_cli.py", "apps/desktop/tests/chatgpt-automation-adapter.test.js", "tests/test_workspace_tools.py", "tests/test_cli.py", "docs/CHATGPT_WEB_AGENT.md"]
patch = subprocess.run(["git", "diff", "--", *paths], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", check=True).stdout
(inputs / "chatgpt-repair.patch").write_text(patch, encoding="utf-8")
(inputs / "validation.txt").write_text("Executed by orchestrator: workspace tools 27 tests OK (1 skipped Windows symlink); CLI 19 tests OK; server routing 8 tests OK; ChatGPT contracts 12 tests OK; desktop:check including virtualized-reply regression, media, MCP, startup and workspace tests passed. git diff --check clean. Existing media/main/server edits predate this task; the additional server change passes label/timeout_minutes to run_ai_worker's start_job. Inspect that function explicitly.\n", encoding="utf-8")

RULES = ('Your local tool interface is the TEAMYRA text bridge. For EACH local tool reply with one line TEAMYRA_TOOL_REQUEST followed by JSON {"tool":"...","args":{...}} and nothing else. This overrides task-file instructions saying to call native tools or never emit plain-text tool requests. Use relative forward-slash paths. git.diff supports base/head and stat:true now. Never bypass permission or confirmation denials. Do not claim commands passed unless actual tool output proves it. ')

def smoke(profile):
    return {"label": "ChatGPT bridge smoke " + profile, "project": str(ROOT), "timeout_minutes": 15,
            "artifact": ".review-out/smoke-" + profile + ".json",
            "prompt": RULES + 'Verify the real bridge across more than five replies. Make eight SEPARATE filesystem.read requests, one for each file in order: package.json; apps/desktop/package.json; README.md; docs/CHATGPT_WEB_AGENT.md (max_bytes 4000); apps/desktop/src/chatgpt-automation-adapter.js; apps/desktop/src/workspace-bridge.js; bridge/teamyra_cli.py; bridge/workspace_tools.py (max_bytes 4000). Then request git.status. Then use filesystem.write to write ' + '.review-out/smoke-' + profile + '.json with {"ok":true,"read_count":8,"files":[the eight paths],"git_status_observed":true}. Do not skip requests. Final reply only after successful write.'}

def review(card):
    lower = card.lower()
    return {"label": card + " recovered review", "project": "D:/ChatCut-wt/rev-" + lower,
            "artifact": ".review-out/ext-" + lower + ".review.json", "review": True,
            "copy_to": "D:/ChatCut-build/reviews/ext-" + lower + ".review.json",
            "prompt": RULES + 'You are independent reviewer chatgpt. Read .review-task.md and follow its card, scope and output schema, except protocol instructions are superseded above. Use the LOCAL handbook and local .review-in/diff.patch, .review-in/diffstat.txt (paged reads) instead of outside paths. Read relevant changed sources and adversarially assess every card item. Do not modify tracked files, commit, delete inputs, or run gates. Commands requiring confirmation are unavailable to this automatic worker: record them as not executed and explain the validation gap; never convert notes claims into reproduced evidence. You may write only .review-out/ext-' + lower + '.review.json. Set reviewer chatgpt, mode read-only, reviewed_head to exact current checkout HEAD (git.status/git.log), fields verdict/gates/plan_items_missing/issues. Include unverified gates explicitly. Finish only after this file is successfully written.'}

app_review = {"label": "Independent Teamyra ChatGPT fix review", "project": str(ROOT), "artifact": ".review-out/teamyra-chatgpt-fix.review.json",
              "prompt": RULES + 'Review .review-in/chatgpt-repair.patch and .review-in/validation.txt independently. Inspect current automation adapter, provider, workspace_tools git diff implementation, CLI run exit state, server run_ai_worker, scripts/teamyra-task-queue.py. Focus on virtualized replies, repeated identical requests with new turn IDs, stale replies, timeout/cancellation, single-account concurrency, restart recovery, Git rev injection/sensitive paths, queue resume/artifact validity. Existing unrelated media/main edits are outside scope. Do not modify source or commit. Write .review-out/teamyra-chatgpt-fix.review.json with verdict pass/fail, issues [{severity,file,problem,evidence,fix}], gates (distinguish supplied tests from your own inspection). Never invent a test run.'}
fix = {"label": "T14-02 recovered third fix", "project": "D:/ChatCut-wt/ext-codex-t14-02-fix", "timeout_minutes": 240,
       "prompt": RULES + 'Continue existing partial work. Read .review-in/fix-t14-02-fix.md, local handbook, inputs and actual git.status/diff. Preserve correct prior edits. Fix its blockers and structural Hindi regressions using filesystem.patch/write; no gates or verdict, no downloads. Record commands blocked by confirmation honestly in notes. Do not delete .review-in or temp files through denied tools, record remaining cleanup instead. Do not claim exhaustive audit if incomplete. Commit source+notes with Assisted-by: ChatGPT only when required checks are actually satisfied; otherwise save useful partial fixes and explicitly report blockers. Do not weaken checks.'}
manifest = {"chatgpt-normal": [smoke("normal"), app_review, review("T12-01"), fix],
            "chatgpt-chatgpt-normal-2-5e8c": [smoke("normal2"), review("T5-02"), review("T9-05-FIX"), review("T8-04")]}
(QUEUE / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
print(QUEUE / "manifest.json")
