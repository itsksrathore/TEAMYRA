# Suno in TEAMYRA

TEAMYRA makes songs with Suno (https://suno.com) from MCP and from the
desktop app. Every request makes Suno's usual **two clips**. TEAMYRA saves each
clip as a **preview** from the audio the Suno page itself streams for playback,
which does not use Suno's download allowance. The caller's AI checks the
previews and then downloads officially only the clips it accepts.

## Accounts

- Agents panel → **Suno** card. The built-in account is `suno`, and **+ Account**
  adds more (`profiles/suno/<id>/teamyra-profile.json`; the built-in account's
  settings are in `profiles/suno/builtin-suno.json`).
- Each account has its own persistent browser session: `persist:teamyra-suno`
  for the built-in account and `persist:teamyra-suno-<id>` for the others.
- **Open** shows the account's Suno page in the main area. The user signs in
  there (Google, Apple, Discord, …). TEAMYRA never types credentials and never
  handles passwords. Sign-in pop-ups open in the same session.
- **On/Off** controls whether the account takes new songs. Only accounts that
  are signed in and On take work. A signed-out account is not ready: a job it
  claimed before anything was created goes back to the queue for another
  account.
- How sign-in is checked: if the session's suno.com cookies are only anonymous
  ones (device id, analytics, Stripe, consent), the account is signed out.
  Otherwise TEAMYRA asks the page in the hidden worker tab: the sign-in
  redirect or "Log in" button, the credits shown, and the page's own
  `/a/api/session/`. The result is reported to the core (`media/suno-accounts.json`)
  and shown in `media_guide` capacity.

## Generating (`media_generate` / `media_batch`, `engine: "suno"`)

| Field | Meaning |
|---|---|
| `type` | `music`, `song`, `instrumental`, `background_music` or `audio` (an alias of music) |
| `prompt` | Simple mode: the song description. Custom mode: used as the lyrics when `lyrics` is not given |
| `suno_mode` | `simple` or `custom`. The default is custom when `lyrics`, `suno_style` or `suno_title` is given |
| `lyrics`, `suno_style`, `suno_title` | Custom mode fields: lyrics, style of music, title |
| `instrumental` | `true` turns on the Instrumental switch (`type` instrumental/background_music implies it) |
| `suno_model` | A model the Create page lists, by name (`v4.5`, `v5`, `v6`, …). By default the page's current model is kept |
| `suno_vocal_gender` | `male` / `female`, if the page shows the option |
| `suno_exclude_styles` | Exclude styles text |
| `suno_weirdness`, `suno_style_influence` | 0-100 (percent of the slider) |
| `suno_options` | `{label: value}` for any other visible Create-page option (text field, switch, slider, choice buttons or menu) |
| `accounts` | Suno account ids or names to run in |

Every option is looked up by its name on the page. If the page doesn't show a
field, switch, slider, model or choice, the job fails with
`option_unavailable` and lists what the page does show. In that case nothing was created.

## Preview capture (no download credit)

What we learned from the live site (November 2026, signed out, public songs):

- `/song/<id>` embeds the clip as JSON in its Next.js payload: title, status,
  `metadata.tags` (style), `metadata.prompt` (lyrics), `metadata.duration`,
  `major_model_version`, and `media_urls` (`m4a-opus`, progressive). Its
  `audio_url` may read `…/api/forbidden`.
- The stored `media_urls` file is obfuscated, so its bytes are not playable audio.
  The page's own service worker (`/sw.js`) turns it into HLS:
  `/_sw-mango/manifest.m3u8?contentId=<id>&src=<media url>&contentType=clip`,
  which lists `init.mp4` and `seg-N.mp4` (fragmented MP4 with Opus audio).
  `audio#active-audio-play` plays these through MediaSource.
- When signed out, the page asks for `muffleAfter=10`, so the stream is muffled after 10 s.

After both clips finish (their status comes from the page's own API responses,
read through DevTools Network; otherwise from each clip's song page every 45 s),
the worker does this for each clip:

1. Opens `/song/<id>` and reads the embedded clip JSON (lyrics, style, model,
   duration).
2. Presses Play in the muted hidden tab so the page requests its own playback
   manifest, finds that URL in the page's resource list, and pauses.
3. Inside the page (same session and service worker), fetches the manifest and
   every segment the manifest lists, joins them, and passes the bytes to Node.
   If the page never requested a manifest, it builds the same manifest URL from
   the clip's progressive media URL (`manifest_source: "media_url"`). If the
   clip has a plain https `audio_url`, it reads that instead.
4. Checks the header (`ftyp`/`moof` → m4a, `ID3` → mp3, …) and decodes the file
   with FFmpeg.
5. Saves the file to `Generated Assets/Music/Previews/<title>_<clip8>.preview.m4a`.
6. Registers it as a media asset with `preview: true` and `status: "preview"`.
   The job's `asset_ids` lists both clips, and `asset_id` is the first one.

The worker never clicks Suno's Download for a preview and never calls a
download endpoint.

### Verification data (asset `metadata`)

- `suno_clip_id`, `suno_profile_id`, `title`, `lyrics`, `style`, `model`,
  `instrumental`, `suno_duration` (as Suno reports it) and `duration` (as decoded).
- `bitrate_kbps`, `codec`, `sample_rate`, `channels`, `bytes`.
- `preview_source`: `via` (`stream_segments`/`audio_url`), segment count,
  playlist duration, `complete_playlist`, and `muffle_after` if the page asked
  for a muffled stream. `no_download_credit: true`.
- `verification`: FFmpeg `volumedetect` (mean/max dB) and `silencedetect`
  (−45 dB, ≥ 2 s), plus `hints` such as `short`, `silent`, `very_quiet`,
  `loud_or_clipping`, `long_silences`, `silent_start`, `gap`, `silent_end`,
  `partial_preview` (the stream is shorter than Suno's duration),
  `muffled_after_Ns`, `instrumental_mismatch`, `vocals_mismatch`.
- `transcript`: only if a local Whisper CLI exists (`TEAMYRA_WHISPER` = path to
  the executable, or `whisper` on PATH; model `TEAMYRA_WHISPER_MODEL`, default
  `base`). Otherwise `transcript_note: "no local whisper found"`. Nothing is
  installed.
- `other_clips_failed`: lists a clip that Suno itself failed, if any. The other clip is still kept.

## Official download (`suno_download`)

`suno_download {asset_id | clip_id, format: "mp3" | "wav"}` queues a job of
surface `suno` with `suno_action: "download"` that only the account that made
the clip can run. The worker:

1. Opens `/song/<id>`.
2. Clicks **More options for <title>** → **Download** → **MP3 audio** / **WAV audio**.
   A WAV is prepared first, and its dialog's **Download "<title>"** button is then clicked.
3. Receives the file through the session's `will-download` handler, checks its
   header, decodes it with FFmpeg and measures it.
4. Saves it to `Generated Assets/Music/<n>_<title>.<mp3|wav>` and registers it
   (`metadata.official_download: true`, `preview_asset_id`).

The preview then records the final file in `metadata.final_assets[format]`.
**This uses the account's download allowance.** If the same clip and format was
already downloaded, the existing asset is returned. If that download is already
queued, the queued job is returned instead. Either way, no second download is
spent.

A clip without a TEAMYRA preview can still be downloaded with `clip_id` plus
`project_path` (and `account` if it isn't the built-in account).

## `suno_clips`

`suno_clips {account?, limit}` loads the account's Library (`/me`) in a
temporary hidden tab. It does not generate or download anything. It lists the
clips with their id, title, status, duration, model and style, read from the
page and from the API responses the page loaded. Each clip shows the TEAMYRA
preview and final assets it has. If the desktop can't be reached, the result
contains the clips TEAMYRA knows from its assets (`live: false`).

## Limits and failures

- The worker detects Suno's out-of-credits, download-limit and rate-limit
  wording in toasts, dialogs and the clip menu. When it sees one, it rests the
  account through `media.suno-limit` (`media/engine-cooldowns.json`, engine
  `suno`) with scope `generate`, `download` or `all`, and the job becomes
  `rate_limited`:
  - A generation goes back to the queue, and any other signed-in account that
    isn't resting takes it.
  - A download waits until its own account's limit resets, because the clip
    exists only in that account.
- Failure categories:
  - `login_required`: sign in with Open.
  - `option_unavailable`: pick one of the listed options.
  - `rate_limited`
  - `selector_failure`: recoverable.
  - `generation_failure`: Suno failed or timed out after 15 minutes. `media_recover` follows the same clips.
  - `policy_refusal`: Suno's moderation, an artist name, and similar. Reword the request.
  - `download_failure`
  - `provider_no_result`: no new clip appeared after Create.
- After Create is clicked, the job records `submission_phase` and
  `provider_submission.clip_ids`. After a restart the worker follows the same
  clips again and never clicks Create a second time.

## Files

- `bridge/media_suno.py`: request validation, accounts, preview registration,
  downloads, limits, `suno_clips` merge, capabilities.
- `bridge/media_engine.py`: engine hook, queue claims (`surface: "suno"`),
  cooldown scopes, multi-asset jobs, final↔preview link.
- `bridge/server.py`: `media_generate`/`media_batch` fields, `suno_download`, `suno_clips`.
- `bridge/media_guide.py`: guide, instructions and capacity.
- `apps/desktop/src/media/suno-provider.js`: sessions, views, URL guard, downloads.
- `apps/desktop/src/media/suno-adapter.js`: page probes, option matching, limits, clip JSON.
- `apps/desktop/src/media/suno-job-consumer.js`: the generate, preview and download worker.
- `apps/desktop/src/media/suno-audio.js`: header sniffing, FFmpeg loudness/silence, optional Whisper.
- `apps/desktop/src/media/suno-engine.js`: accounts, Open view, wake, clips listing.
- Tests: `tests/test_media_suno.py` and `apps/desktop/tests/media-suno.test.js`.

## Not yet checked live (signed in)

The signed-in Create page was not available while this was built: when signed
out, `/create` redirects to the sign-in page. The parts below are matched by
label and need a live check with a signed-in account:

- The Create page's field, switch, slider and button labels: Simple/Custom
  (or Advanced), the model picker button text, Instrumental, Lyrics, Styles,
  Title, More Options, Vocal Gender, Weirdness, Style Influence.
- The Create button, and which API call returns the new clips (`/generate`).
- The signed-in cookie names and the `session` response.
- Whether the owner's playback stream comes without `muffleAfter`.
- The exact wording of the Download submenu and WAV dialog, and of the
  credit, download-limit and rate-limit messages.
