---
name: AI Video Editor
description: Edit talking-head videos — rule-based clean-up (silences, filler words, failed takes) or an AI editor that cuts by judgement following an editing skill (film director, YouTube retention, Shorts, tutorial, interview) and the user's instructions.
---

# AI Video Editor

## When to Use

Use this skill when the user mentions:
- Editing a talking-head video, recording, or screen capture
- Removing silences, pauses, or dead air from a video
- Removing filler words ("um", "uh", "ну", "типа") from speech
- Cutting restart phrases ("cut cut", "кат кат") from raw footage
- Processing a raw video recording for YouTube or social media

## Two ways to edit

- **Auto** — `process_video(video_path=...)` with no `instructions`/`skill`: rule-based
  (voice detection for silences, filler-word lists, "cut cut" takes). Free, offline.
- **AI editor** — pass `skill` and/or `instructions`: an LLM reads the word-timestamped
  transcript and removes fillers, stutters, repeated sentences, stalls and rambling by
  judgement, following the skill. Needs one of ANTHROPIC_API_KEY / OPENAI_API_KEY /
  OPENROUTER_API_KEY / NVIDIA_API_KEY (configured under `director:` in config).

If the user describes a *goal* ("make it punchy", "cut it for Shorts", "edit it like a
film", "keep every step") use the AI editor and pick the matching skill:

| User intent | `skill` |
|---|---|
| just clean it up, keep everything | `clean` |
| cinematic / story / emotional / "like a film director" | `film-director` |
| long YouTube video, retention, keep people watching | `youtube-retention` |
| Shorts / Reels / TikTok / under a minute | `shorts` |
| tutorial, how-to, course, must not lose steps | `tutorial` |
| interview, podcast, conversation | `interview` |

Call `list_skills()` to see the current list (users can add their own).

Recommended AI-editor flow:
1. `process_video(..., skill=..., instructions=..., plan_only=True, analysis_cache="<video>.cache.json")`
   → show the user the plan's `summary` and the `removed` list (each has a reason).
2. Adjust `instructions` if needed and re-run with the same `analysis_cache` (seconds — no re-transcription).
3. Run again without `plan_only` to render.

## Recommended Workflow

### 1. Inspect the video first

```
video_info(video_path="/absolute/path/to/video.mp4")
```

Check: duration, resolution, codec. This informs model selection and sets expectations.

### 2. Choose a Whisper model based on duration

| Video duration | Recommended model | Reason |
|----------------|-------------------|--------|
| < 5 min        | `large-v3` (GPU/Apple Silicon) · `medium` (CPU) | Best accuracy |
| 5–15 min       | `medium`          | Good accuracy, manageable |
| 15–30 min      | `small`           | Faster, still good |
| > 30 min       | `small`           | Significantly faster |

First use of a model downloads it (`small` ≈ 486 MB, `medium` ≈ 1.5 GB, `large-v3` ≈ 3.1 GB); warn the user.

### 3. Process the video

```
process_video(
    video_path="/absolute/path/to/video.mp4",
    output_path="/absolute/path/to/video_edited.mp4",
    whisper_model="large-v3",
    no_hook=True,
    no_chapters=True
)
```

**Hook and chapters** — ask the user if they want these:

- `no_hook=False` — AI picks the most engaging ~8-second clip and moves it to the start as an opener (great for YouTube/social media)
- `no_chapters=False` — AI generates timestamped YouTube chapter markers from the transcript

Both require `OPENROUTER_API_KEY` in the `.env` file. If the key is missing, these steps skip silently. If the user wants to publish on YouTube or social media, suggest enabling both.

### 4. Report results to the user

From the result JSON, summarize:
- Duration saved: `duration_original_sec - duration_edited_sec`
- Auto edit: `fillers_removed`, `restarts_removed`
- AI editor: `director_plan.summary`, number of `director_plan.removed` cuts, and
  `director_plan.usage` (tokens) so the user knows what the call cost
- Output file location: `output_video`

## Config Tips

The default config handles most talking-head recordings well. Common overrides:

```yaml
# my-config.yml — pass as config_path argument
whisper:
  language: ru       # force Russian if auto-detect is unreliable
silence:
  min_gap_sec: 3.0   # keep longer natural pauses (default: 2.0s)
  padding_sec: 0.3   # less breathing room around cuts (default: 0.5s)
audio:
  enabled: true      # enable noise reduction + loudness normalization
```

## Performance Expectations

- 4K 2–5 min video: ~8–15 min processing (Apple Silicon)
- 1080p 2–5 min video: ~3–7 min
- 4K 10–15 min video: ~20–40 min
- Whisper model loading adds ~30s on first run; cached in `~/.cache/huggingface/` after.

## Limitations

- **macOS only for hardware encoding** — VideoToolbox (`h264_videotoolbox`) requires Apple Silicon. Falls back to libx264 on Linux/Windows (slower).
- **RAM** — Whisper `large-v3` needs ~4 GB. Use `medium` or `small` if RAM is constrained.
- **No GPU acceleration** — Runs on CPU only (CTranslate2 optimized for Apple Silicon via Metal is not yet supported in faster-whisper).
- **Input formats** — Any format FFmpeg can read (MP4, MOV, MKV, WebM, etc.).
