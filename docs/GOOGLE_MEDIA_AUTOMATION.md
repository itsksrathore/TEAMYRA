# Google media automation

Agents submit `teamyra.media_generate` with a media type, prompt, and existing
project directory. The tool returns a durable job ID immediately and wakes the
appropriate browser lane. `teamyra.media_status` reports progress and the final
registered asset. Browser selectors and provider DOM controls are private.

| Type | Default provider settings | Download |
| --- | --- | --- |
| Image | Current supported image model; requested aspect ratio selected in Flow's composer settings | Prefer 4K/4x upscale, then 2K/2x; convert to the requested image format |
| Video | Gemini Omni Flash (currently displayed as Omni 1.1 Flash), 720p generation | Provider 1080p upscale |
| Sound effect | Omni Flash, 360p; one audio event, no music/instruments/melody, voices only when requested | Original video, then bundled FFmpeg audio extraction |
| Music/instrumental/song | Flow Music composer; requested model defaults to Lyria 3.5 | Exact generated song's audio-format menu |

Aspect ratio, mode, model, resolution, duration, and output count are selected in
the provider's settings panel and checked before Generate. Aspect-ratio wording
in the prompt does not replace that selection. Video generation explicitly
selects 720p so a preceding 360p SFX job cannot restrict its upscale choices.

The hidden Flow page is kept active during submission through Chromium's
debugger lifecycle control. This allows its loading transitions and native image
button activation to complete without showing or focusing the desktop window.
Background connection polling does not open settings menus.

Google Flow and Flow Music browser views are muted natively before loading,
including sign-in popups. Autoplay previews stay silent even in hidden views;
the mute persists through navigation and is restored when an unloaded view is
recreated. Downloaded files retain their audio. Loaded provider status reports
`audio_muted` from Electron's actual view state.

Download completion is an Electron download event plus a nonempty local file.
FFmpeg checks decodability, visual dimensions/aspect ratio, requested upscale
size, and audio streams before asset registration. Cover art attached to a music
file is allowed. Image bytes are converted rather than saved with a misleading
extension. A failed 4x download can retry 2x on the same result. Failed SFX
extraction preserves the source; successful registration permits staging cleanup.

## Bulk generation

Images, videos and sound effects can be generated many at a time. In the app,
the Google Media card's **Bulk** button opens a dialog: one prompt per line (or
blocks separated by a `---` line), copies per prompt, aspect ratio, duration,
download quality, how many run at once, and the project folder. A batch holds
up to 50 generations; progress, per-item assets and **Stop batch** stay in the
dialog. Agents use `teamyra.media_batch` with `max_parallel`, then poll
`teamyra.media_status({batch_id})` or stop it with `teamyra.media_cancel({batch_id})`.

The visual worker no longer waits for one result before starting the next. It
submits each job as soon as Flow's composer is free (default 10, at most 30 in
flight), and one shared monitor reads every in-flight result from a single page
snapshot. Music stays one song at a time.

- **Result identity.** Jobs are matched oldest first and each result tile is
  assigned once, so copies of the same prompt get distinct results. Tile prompts
  are cached instead of reopening the info panel every poll.
- **Downloads in parallel.** Flow downloads are anonymous `blob:` URLs. Up to 4
  downloads overlap; while more than one could own a download it lands in a
  neutral file, and its frames are compared with each job's tile thumbnail
  (64-bit difference hash). It is assigned only to a clearly closer match;
  identical requests are interchangeable. If content cannot decide, those
  downloads fail and automatic recovery downloads the existing results again,
  one at a time; nothing is guessed onto a job. A job without a thumbnail
  fingerprint downloads alone.
- **Backpressure.** If Flow will not accept another generation before the
  Generate click (busy message, rate limit, Generate stays disabled while others
  run), the job returns to the queue without using an attempt and the worker
  runs with fewer slots for a while, growing back as jobs complete. A job that
  may have reached Generate is never released for a second click.
- **Refusals.** Flow's refusal text is page-wide. Each submission records the
  count beforehand; a new refusal is assigned only once it accounts for every
  unresolved job that could have produced it.
- **Files.** Output paths are reserved across unfinished jobs, so concurrent
  outputs never share an index or a filename.

### Several Flow tabs (2026-10-27)

One Flow page did everything: each submission, every result poll and every
download click waited for the others. In a 12-video batch Flow itself needed
about a minute per video, but jobs waited a median 7.5 minutes before being
claimed and at most 4 were ever generating together.

Bulk work now runs in several hidden Flow tabs ("lanes", default 3, set with
the `TEAMYRA_FLOW_LANES` environment variable, 1–4). They share the Google
login (one browser session) but each has its own page and page lock.

- **Own project per tab.** Tab 1 keeps the folder's usual Flow project. Tabs 2+
  create one project of their own per folder the first time and reuse it
  afterwards (`media.flow-project` is looked up per lane). Reference images are
  uploaded into a tab's project the first time it needs them.
- **One queue.** All tabs claim from the same queue. A batch's `max_parallel`
  caps its running jobs across all tabs. Extra tabs take batch jobs only;
  single jobs and edits of existing results stay in tab 1 and the main project.
- **Restarts.** Each submission records its tab (`provider_submission.lane`),
  and a submitted job is resumed only by that tab, whose project holds the
  result. A job from a tab that no longer exists (fewer lanes) resumes anywhere.
- **Downloads.** Each tab's downloads are attributed within that tab (by the
  page that started them), so tabs never confuse each other's files.
- **Memory.** An idle extra tab is closed after 45 s and reopened on demand.
- The Bulk dialog shows which tab each item runs in.

Live test (12 × 8 s 16:9 videos, 1080p, 8 with reference images, 3 tabs):
12/12 delivered in 6.8 minutes, against 12.0 minutes for a comparable batch in
one tab; one lost download was re-requested in place.

Quick fixes in the same change:

- **Reference images per tab.** Uploading an image into a Flow project is the
  slow submit step (about 35 s, once per image per project); attaching one that
  is already uploaded takes under a second. A tab prefers the batch's next job
  that uses the images it already has, so each tab uploads fewer of them. If
  Flow still shows the previous job's chips with the same images, they are kept
  (identities are verified before Generate either way).
- **Slow ingredient chips.** A freshly uploaded image may take a while to
  settle when several tabs upload at once; the wait is 60 s for a fresh upload
  (30 s otherwise) instead of 20 s, and a timeout reports what the chips showed.
- **Lost downloads are re-requested.** Successful upscaled downloads land within
  about 2 minutes (p97 105 s), but 37 had waited out a 6-minute timeout and full
  recovery. A download that has not arrived after 150 s is clicked again in
  place (240 s second wait).
- Each submission records per-step timings (`provider_submission.stage_ms`).

### Every Google account at once (2026-10-27)

Bulk Flow work runs in every enabled, signed-in Google Media account at the
same time (Settings → Google Media; `enabled` in each account's
`teamyra-profile.json`). Each account has its own Flow tabs, so capacity is
accounts × tabs (`media_guide` → `capacity.flow_accounts`, `flow_tabs`).

- **Wake.** `media_generate`, `media_batch`, recovery calls and the Bulk dialog
  wake every enabled account (`media.wake` without `profile_id`). An account
  starts claiming only after a probe confirms it is signed in and unchallenged.
  If no account is known to work, the active one starts as before, so jobs
  report that sign-in is needed. Flow Music stays on the active account. At
  desktop start every enabled account resumes from its saved state.
- **Ownership is (account, tab).** A Flow project, its results and its
  downloads exist only in the account that made them; another account opening
  that URL gets Flow's 404 page. Submissions record `provider_submission.
  profile_id` next to `lane`; the folder's Flow project is looked up per
  account and tab; and a submitted job (after a restart, a recovery or a
  sign-in) is reconciled and downloaded only by the account and tab that
  submitted it. Jobs from before this change belong to the built-in account
  `google`.
- **Who takes what.** All accounts claim from one queue. A batch's
  `max_parallel` caps its running jobs per account (each account has its own
  Flow concurrency and credits). Single jobs go to the main account's first tab
  (the active account while it works, else the first working one); edits go to
  the account that made the source asset (`asset.metadata.google_profile_id`).
- **An account that stops working.** If an account is found signed out,
  challenged or out of credits while another account works, it is parked: its
  claimed, never-submitted job goes straight back to the queue
  (`media.handoff`, no retry budget spent) and other accounts take it.
  Signed-out/challenged accounts stop claiming until a later wake or sign-in
  probe finds them working; an account out of credits pauses new claims for 30
  minutes. Jobs it already submitted wait for it (no other account can download
  them) and resume when it is back (`media_resume_auth`). With one account,
  behaviour is unchanged.
- **Upload terms.** A newly added account may show Flow's "I agree" dialog for
  its upload terms on the first reference upload; until someone accepts it no
  uploaded image appears. The worker notices the dialog within ~2 s
  (`upload_terms_required`), parks the account for 20 minutes (or until it is
  opened in TEAMYRA) and hands the job to another account; alone, the job waits
  in `needs_user_auth`. TEAMYRA never accepts terms itself: open the account in
  Settings → Google Media and click "I agree" once.
- **Connection status** is kept per account (`media/connection.json` →
  `profiles`); the top level says whether any account works, so one signed-out
  account no longer reports Flow as disconnected.
- **Reporting.** `media_status` and batch rows show `profile_id`, `lane` and
  `handled_by` (e.g. `google-media-2-479f tab 2`); the Bulk dialog shows the
  same. The desktop status lists each account's tabs, `working` flag and park
  reason.

Before this change the added accounts already started their consumers when
they signed in, but looked up Flow projects by tab number only. They opened the
built-in account's project URLs, got Flow's 404, and failed jobs at
`workspace_ready` ("Flow composer unavailable") before any Generate click (no
credits spent, but retry budgets used up).

### Reliability under heavy bulk use (2026-10-18)

Real teaser batches (~150 jobs) exposed failures that are now handled:

- **Virtualized grid.** Flow renders only tiles near the viewport (16 in a
  700 px view). The hidden view now uses a 1280 × 7200 work area (52+ tiles),
  and an overdue job triggers a scroll search of the whole grid; a found tile is
  scrolled into view before fingerprinting or download.
- **Refused generations.** Flow replaces a refused prompt with a tile reading
  "Failed / This prompt might violate our policies". Failed tiles are counted
  once each and assigned with the deferred rule above, so a refusal fails its job
  at once. A job still absent after a full search fails as `provider_no_result`
  after max(6 min, 4 × the session's typical generation time) instead of holding
  its slot for 20 minutes; neither is retried automatically (reword the prompt).
- **Downloads.** 8 download slots. Look-alike results (thumbnails closer than
  22/64 bits, e.g. shots of one battlefield) never download side by side, which
  removed the "could not be attributed" failures. A held file is never handed to
  the job left over after another download was abandoned.
- **Long paths.** Downloads, conversion and verification happen in the job's
  short staging folder; one move places the file at the project path (Chromium
  aborted downloads to 300-character paths as "interrupted").
- **One Flow project per folder.** Jobs from a local folder return to the Flow
  project holding most of that folder's results. The home page's project list is
  awaited before a new project is created; previously restarts created empty
  projects, where the reference picker had no asset list.
- **Reference picker.** Leftover overlays are dismissed, the trigger is retried
  (last attempt with a native click), an empty project's Upload view counts as
  open, and a persistent failure records the picker state. A project file
  uploaded once is reused by its upload title (43 s → 5 s per submission).
- **Restarts.** Desktop start requeues or reconciles jobs the previous process
  left mid-flight before any worker claims; reconciled jobs keep their original
  submission time. DNS/network errors (`ERR_NAME_NOT_RESOLVED`) are retried.
- Faster turnaround: `download_quality: "source"` skips the upscale wait.

### Result matching after Flow's UI change (2026-10-22)

Flow's tile footer became `<button class="footer-left">` (no `role`), opening
a CDK overlay whose `flow-info-panel .prompt-text .text-part` holds the full
prompt. Result matching read nothing, so every job ended as a misleading
"silent moderation" `provider_no_result` although Flow had generated it.

- The info panel is read through the new footer; another tile's open panel is
  closed first and the overlay is closed afterwards.
- Prompts compare after Unicode/quote/whitespace normalization. Some Flow text
  renders without lowercase "s"; such a lossy match is accepted only when it is
  the single candidate, so near-identical bulk prompts never cross-match.
- Copies of one prompt take the oldest unclaimed tile after their submission
  (Flow lists newest first). Tiles owned by any job are read from core, so a
  desktop restart cannot hand one tile to two jobs; an earlier copy-swap is
  repaired with the remaining identical tile.
- Finished tiles that match no job fail as `result_match_failed` ("do not
  resubmit; credits were used"), never as moderation. Resumed jobs are searched
  before any timeout, and a download re-looks for its tile before failing.
- `media.diagnose` gains `result_info` and `match_job` read-only inspections;
  `teamyra.media_status` trims baseline key arrays to counts for agents.
- The connection status is re-probed after Connect, on startup when stale and
  after Flow Music, so an old "challenged/sign in needed" flag cannot persist.

Live acceptance in `D:\Emmanuel\Esme\Video 5 & 6`: 18 jobs previously reported
as `provider_no_result` were completed from their existing Flow results without
new credits; new jobs passed for an image without references (5504 × 3072), an
image with `Projects/refs/esme_ref.png`, a 16:9 8 s video (720p → 1080p, audio)
and a 3-video batch, each frame checked against its own prompt.

## One TEAMYRA per PC

`%USERPROFILE%\.teamyra\runtime.json` names the canonical checkout
(`D:\AI-Orchestrator`). Any other copy — an installed or portable build, a
worktree or another checkout — shows "Use the main TEAMYRA" and exits, so all
agents share one runtime and one set of Google/ChatGPT sign-ins. Start menu and
desktop shortcuts start `D:\AI-Orchestrator\apps\desktop`; a source launch
rebuilds the renderer bundle when `app.mjs` changed. The MCP wake gateway starts
at Windows sign-in (HKCU Run: `TEAMYRA MCP Gateway`), so agents can connect
before the app is opened. Remove that value to disable it.

## Media helper agents and issue log

An agent that is stuck on media work reports it instead of retrying:

- `teamyra.media_report_issue({description, job_ids | batch_id, reporter, instructions})`
  logs the issue, creates a helper ticket and starts a TEAMYRA helper agent.
  The reported jobs move to state `assisted`; their `recovery_plan` says
  `wait_for_helper`, so any agent polling them stops retrying. The helper
  finishes the work by hand and delivers into the **same job ids**: a waiting
  agent simply sees its job complete with the delivered asset. `take_over:false`
  only logs the issue.
- `teamyra.media_delegate({description, project_path, requests, instructions})`
  hands a whole generation task to a helper, which queues it in bulk, handles
  refusals and re-downloads, follows the instructions and delivers every item.
- `teamyra.media_ticket_status` shows the helper, its notes and the deliveries
  (asset ids and local paths). Helpers use `media_ticket_update` and
  `media_ticket_deliver`; a failed or cancelled ticket returns undelivered jobs
  to their reporter as ordinary failures.

Helpers are tried as **Codex 1 → Codex 2 → Antigravity**; Claude workers run
only when none of those is signed in and free of a usage limit (a busy Codex
is still preferred, its ticket waits in that worker's queue). The same order
applies to automatic failover. Helper jobs get the TEAMYRA MCP connection in
any Codex profile and run in plain (non-Git) project folders; without MCP a
helper can call any tool through `teamyra tool <name> --json '{...}'`.

Any agent can note any TEAMYRA error, not only media ones, with
`teamyra.maintenance_report({summary, details, area, severity, refs})`
(areas: media, worker, chatgpt, mcp, desktop, scheduler, git, other);
`teamyra.maintenance_issues` lists them by area. A helper whose job ends
without closing its ticket is detected: the ticket closes and undelivered jobs
return to their reporter, so nothing waits in `assisted` forever. Long worker
tasks travel as a file (Windows caps command lines at 32,767 characters), and a
helper passes its `ticket_id` to `media_recover`/`media_resume_download` to work
the jobs it owns.

Every reported issue and every failed media job (automatically, once per job
and category) is kept in `media/support/issues/` for maintenance:
`teamyra.media_issues` groups them by category, and `media_issue_update`
acknowledges or closes them. Helpers add notes about TEAMYRA bugs they notice.

Live check (2026-10-18): a delegated image ticket failed over from Codex 1 and
Codex 2 (Codex refused the non-Git folder, now fixed) to Antigravity, which
noted its plan, generated the image, verified it was 1024 × 1024, delivered it
and closed the ticket with a summary and a maintenance note.

## MCP policy and references

`teamyra.media_capabilities` reports the enforced workflow without opening a
browser. Generation and download quality are separate: a video is generated at
720p and its result's Download menu selects **1080p Upscaled**. The job waits for
the actual download and rejects a file below the requested resolution. Setting
`download_quality: "source"` explicitly opts out of upscale. Requests for native
1080p/4K video fail validation before a paid submission.

SFX always uses **360p generation → original-size video download → FFmpeg audio
extraction**. These rules cannot be changed by video-quality overrides; only the
audio file is registered as the sound effect.

Omni supports images directly in its prompt as **ingredients**, not exact
first/last-frame controls. Use `references: ["TYR-IMG-000004"]` and
`reference_mode: "ingredients"` for the same car/character/object. A legacy
`first_frame` is accepted as an ingredient with an explicit no-guarantee note;
`last_frame` and Frames mode are rejected before generation. Unsupported frame modes fail before submission. The same provider image is selected by stable media ID,
not its generated title. Project-local images use the Upload media picker. The
attached ingredient is verified before Generate and recorded in submission and
asset metadata; referenced TEAMYRA asset IDs remain in `parent_asset_ids`.
Stale ingredients are cleared between jobs.

Desktop-dependent MCP requests now start a closed desktop in the background and
wait for readiness. Source and installed builds are supported without `npm start`.
Installed builds record their executable on first startup; `TEAMYRA_DESKTOP_EXE`
can override discovery. A startup failure is returned in the queued result's
`runtime` field, preserving the durable job. Read-only policy/status requests
stay lightweight. Hidden views remain loaded during active/waking jobs and for
45 seconds after activity, then unload; the hidden desktop/core still sleep after
their configured idle period. Automated previews remain muted.

## Recovery

Video setup keeps one settings popover open while mode, Ingredients, resolution,
aspect ratio, output count and duration are selected and verified. Repeatedly
closing/reopening the popover races Flow's overlay teardown and previously failed
at the 720p selection. It closes once after configuration is complete.

Transient browser/selector/download failures get at most two automatic recovery
attempts per job, with durable counters and backoff (5s, then 10s; rate limits wait
at least 60s). Recovery recreates the affected browser view while retaining its
signed-in session. A checkpoint before the paid click distinguishes preparation
from a possibly submitted generation. Submitted jobs only reconcile and download
their existing result; downloaded files and result identities are preserved.

For AI callers, `teamyra.media_status` returns `failure`, `recovery`, `retry_after`
and `recovery_plan` (category, safe action, instruction and remaining automatic
budget). Poll the same job while recovery is scheduled. After correcting a
persistent problem, call **`teamyra.media_recover({job_id})`** to retry that stopped
job explicitly. It wakes the correct media lane only if safely requeued. Do not
replace a failed job with `media_generate` just to retry: an ambiguous submission
may already have consumed credits. Legacy failures explicitly within the intent
setup stage can also recover before submission.

Login/CAPTCHA, exhausted credits and policy refusals do not automatically retry.
Unknown submission history without durable provider identity requires manual
reconciliation. Cancelled/completed/active jobs cannot be recovered by this tool.

Submission identity and result baselines are saved before the one Generate
activation. An uncertain acknowledgement or a restart never causes an automatic
second generation. Visual results are matched by stable identity and their full
provider prompt; music uses stable song IDs, including when titles repeat.

After signing in, call `teamyra.media_resume_auth`. Jobs with possible submission
history are preserved for reconciliation. For a failed job with a known provider
submission, call `teamyra.media_resume_download` with its job ID. This reconciles
and downloads the existing output; it does not call Generate. A completed download
checkpoint can be reused after extraction or verification failure. Jobs without
sufficient provider identity remain stopped for manual reconciliation.

## Acceptance evidence and limits

Bulk acceptance on 2026-10-18 used real `teamyra.media_batch` MCP requests:

- 10 different videos (8 × 16:9, 2 × 9:16, 6 s/8 s, 1080p upscale): all 10
  submitted to Flow within 50 seconds and generated concurrently. With
  thumbnail fingerprints unavailable in-page (Flow serves thumbnails from
  another origin), downloads ran one at a time and the batch took about 10 min.
- After adding the session-fetch thumbnail fingerprint, a second batch of 10
  (including two copies of one prompt) completed in 4 min 5 s with 4
  overlapping downloads. Every download was attributed by content at hash
  distance 0–3 of 64; the two copies received two distinct results.
- Image batches: 4K upscales at 16:9 and 1:1 completed. A 9:16 image exposed an
  older aspect bug: the generic word "portrait" matched Flow's 3:4 option. The
  verifier rejected the 3:4 file; aspect options are now matched by exact ratio
  (9:16 → 3072 × 5504, 3:4 → 3584 × 4800, 4:3 → 4800 × 3584 verified live).
  A result with the wrong shape is no longer auto-retried as a download failure.
- Every video and image frame was checked against its own prompt; none were
  mismatched.

Windows verification on 2026-10-16 reproduced the settings failure on the live
Flow page, then passed the full video configuration after the fix. An existing
failed job resumed through `teamyra.media_recover`, generated once with Omni 1.1
Flash at 720p, downloaded its explicitly requested original/source MP4, passed
FFmpeg decode and 1280 × 720 checks, and registered as `TYR-VID-000005`. Desktop
checks and 55 media/core/security tests passed, including overlay teardown,
bounded recovery, submission ambiguity, backoff, cancellation and MCP routing.

Windows acceptance on 2026-10-05 used real MCP requests and local asset
registration for all four lanes:

- Image: 4096 × 4096 PNG from a provider 4K upscale, with 1:1 selected in settings;
  actual image model recorded as Nano Banana Pro. A mismatched earlier output was
  rejected rather than cropped to satisfy the requested ratio.
- Video: 1920 × 1080 MP4, Omni 1.1 Flash selected, provider 1080p upscale.
- SFX: Omni 1.1 Flash at 360p, original-source download and audio-only WAV
  extraction; source cleanup after registration.
- Music: generated instrumental WAV, exact song overflow/audio download,
  FFmpeg verification and registration. A second request completed automatically
  after stable song identity was added.

The music UI did not expose its actual generation model. Lyria 3.5 remains the
request default; `metadata.actual_model` is null when unverified. Do not infer
the provider's actual model from the requested model. Music transforms fail
before submission rather than generating a fresh song in place of a transform.
Multiple-output download coverage and visual transforms were not part of this acceptance run.
Audio verification checks file structure, not whether a generated recording
perfectly obeys every semantic prompt constraint.

Regression tests inject expired auth, exhausted credits, rate limiting, selector
drift, interrupted/stalled downloads, ambiguous acknowledgement, restart,
duplicate titles, and upscale fallback. These failure cases are simulated;
provider accounts were not deliberately logged out or depleted. Runtime jobs,
sessions, download URLs, and generated user files are excluded from commits.
