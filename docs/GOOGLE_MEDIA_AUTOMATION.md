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

## Recovery

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
