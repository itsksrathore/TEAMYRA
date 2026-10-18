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
