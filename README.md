# AI Video Editor

> **This fork** of [timkulbaev/ai-video-editor](https://github.com/timkulbaev/ai-video-editor) adds a
> **web GUI**, an **AI Director** (Claude / ChatGPT / OpenRouter decides what to keep from your
> instructions), **Hindi** support, and Linux/WSL fixes. See [What's new in this fork](#whats-new-in-this-fork).

A local, open-source CLI tool that automatically edits talking-head videos using AI. Point it at a raw recording and it removes silences, filler words ("um", "uh", "ну", "типа"), and failed takes (say "cut cut" to mark a restart). It uses Silero VAD for speech detection, Whisper large-v3 for transcription with word-level timestamps, and FFmpeg for frame-accurate assembly. Optionally generates a smart hook opener and YouTube chapter markers via LLM. Runs entirely on your machine — no cloud APIs required for the core pipeline. Designed to be invoked by AI agents (structured JSON output) or used as an MCP server in Claude Desktop.

## Features

- **Silence removal** — Silero VAD strips dead air; short natural pauses are preserved
- **Filler word removal** — English and Russian filler words ("um", "uh", "ну", "типа", "эээ", ...)
- **Restart detection** — "cut cut" / "кат кат" removes the entire failed take; short isolated bursts (coughs, false starts) are auto-removed via VAD duration filtering
- **Repeated sentence detection** — auto-detects and cuts duplicate sentence starts
- **Smart hook generation** — OpenRouter LLM picks the best 8-second opener (optional)
- **YouTube chapter markers** — LLM generates timestamped chapters from the transcript (optional)
- **Hardware encoding** — `h264_videotoolbox` on Apple Silicon for fast final encode
- **Configurable YAML pipeline** — every threshold, model, and feature toggle is overridable

## What's new in this fork

### Web GUI

```bash
gui/run.sh            # opens http://localhost:8765
```

A video-editor style workspace (media panel · preview that skips the cuts ·
inspector · multi-track timeline with **Video / Voiceover / Music** tracks · jobs
drawer). Browse your videos (Windows drives are mapped under WSL), review and
toggle every cut, add a **text-to-speech voiceover** and **background music**,
render, and come back later — every edit is a **project** that reopens exactly
as you left it. Details in [`gui/README.md`](gui/README.md).

### Voiceover (text-to-speech), music & mixer

- **Engines**: OpenAI (`gpt-4o-mini-tts` with delivery instructions — the most
  natural), **Edge** (Microsoft neural voices, free, online, no key) and
  **Kokoro** (free, offline, `uv pip install -e ".[tts-local]"`).
- **Script**: type it, or let the AI rewrite the (edited) transcript into a
  polished narration — one cue per sentence, aligned to the video. Cues can be
  narrated *over* the original (ducked) or *replace* your voice.
- Cues that run longer than their slot are sped up a little (≤ 1.3×) or flagged.
- **Music**: any audio file, level, fades, start offset, loop, auto-ducking under
  speech; a **mixer** for original / voiceover / music levels and loudness
  normalisation. All mixing is a single ffmpeg pass (`src/steps/mix_audio.py`).
- CLI: `ai-video-editor process in.mp4 --vo-cues cues.json -c my.yml` with a
  `voiceover:` / `music:` / `mix:` section in the config.

### Re-editable projects

Every edit is saved as JSON under `uploads/.projects/` (autosave) and copied into
the output bundle as `project.json` together with `analysis_cache.json`. **Open…**
restores the source, the cuts, the plan, voiceover cues and music; change
anything and press **Render** again — no re-transcription. A bundle folder can be
imported on another machine.

### Hook & chapters on any provider

The smart hook and chapter generator now use the same provider/model picker as
the AI editor (Claude, ChatGPT, OpenRouter, NVIDIA NIM) instead of requiring
OpenRouter; their token usage is added to the job cost.

### AI Director

An LLM edits the talk the way a person would: it reads the word-timestamped
transcript (pauses marked) and removes fillers judged in context (any language),
stutters, false starts, repeated sentences (keeping the best take), stalls and
rambling — no word lists — plus whatever *you* ask for ("cut to 60 s, drop the
tangent about the weather, open with the strongest line"). Every cut comes with a
reason; you review the plan in the GUI, restore or drop pieces, ask for
revisions, then render. Dead air is still trimmed by voice detection.

Providers: **Anthropic** (`ANTHROPIC_API_KEY`), **OpenAI** (`OPENAI_API_KEY`),
**OpenRouter** (`OPENROUTER_API_KEY`), or **NVIDIA NIM** (`NVIDIA_API_KEY`, from
[build.nvidia.com](https://build.nvidia.com) — Nemotron, DeepSeek, Kimi, Mistral, Gemma…).
Model lists are fetched live from the provider in the GUI; recommended models are
starred and listed first.

#### Editing skills

The AI editor follows an **editing skill** — a Markdown brief in [`skills/`](skills/)
that encodes a craft: how aggressively to cut, what structure to build, how to
open and end. Built-in:

| Skill | Use for |
|---|---|
| 🧹 Clean-up | Same talk, minus fillers, stumbles, repeats (default) |
| 🎬 Film Director | Emotion and story first — Walter Murch's Rule of Six, dramatic beats, deliberate rhythm, a resonant ending; may reorder to open in tension |
| 📈 YouTube Retention | Long-form: front-load the promise, kill lead-ins and flat landings, keep re-hooks, never announce the ending |
| 📱 Shorts / Reels | One idea, hook in 3 s, 15–45 s, ends on the payoff |
| 🎓 Tutorial / Educational | Every step and warning kept in order; digressions and tech trouble cut |
| 🎙️ Interview / Podcast | Best answer per question, natural flow kept, crosstalk and tangents cut |

Pick one in the GUI (AI editor → Editing skill, "view brief" shows the text) or
with `--skill film-director` on the CLI. Add your own by dropping a `.md` file in
`skills/` — format and sources in [`skills/README.md`](skills/README.md).
Precedence: your instructions > the skill > the core rules.

#### Which model should I pick?

The job is: read a word-timestamped transcript (a 10-minute talk ≈ 15k tokens),
judge the speech, and return exact JSON time ranges. That needs precise
instruction-following and careful number copying more than raw size.

| Tier | Model | Notes |
|---|---|---|
| **Default** | **Claude Sonnet 5** (`claude-sonnet-5`) | Best quality per dollar for this task. ≈ $0.02 per 1-minute clip, ≈ $0.10 per 20-minute talk. |
| Hardest edits | **Claude Opus 5** (`claude-opus-5`) | Better judgement on messy speech, reordering, and Hindi/Hinglish. ≈ 2.5× the price. |
| ChatGPT | `gpt-5` (full model, not mini/nano) | Comparable to Sonnet 5 if OpenAI credit is what you have. |
| NVIDIA NIM | `nvidia/nemotron-3-super-120b-a12b`, `deepseek-ai/deepseek-v4-pro-0813` | Effectively free on trial credits; open models drift on timestamps more often, so review the plan carefully. Avoid models under ~30B. |
| OpenRouter | the same Claude / GPT models | Only useful if you prefer a single bill. |

Rule of thumb: start every video with **Sonnet 5**; if one revision doesn't fix
the plan, switch that video to **Opus 5** — the transcript is cached, so switching
costs only the new call. Avoid mini / nano / flash / haiku-class models: they are
cheap but invent timestamps and cut mid-sentence, which costs more in re-runs.
The two Claude models were verified on real footage; the others are ranked from
their general capabilities — the cheapest way to check is to run the same clip
through two models back-to-back and compare the plans in History.

```bash
# plan only (cached analysis → re-planning is seconds)
ai-video-editor process talk.mp4 -i "cut to 60s, keep the demo" --plan-only --analysis-cache talk.cache.json
# render the reviewed plan
ai-video-editor process talk.mp4 --keep-json keep.json --analysis-cache talk.cache.json -o talk_final.mp4
# or all in one go
ai-video-editor process talk.mp4 -i "tighten it, under 2 minutes"
```

Config lives under `director:` in `config.default.yml`.

### Multi-clip sequences & cost tracking

Select several clips in the GUI, order them, and they are joined (normalised to
the first clip's size/fps) before the Auto or AI edit. Every AI call shows tokens
in/out and the dollar cost (prices live from OpenRouter's catalogue; NIM bills in
credits, so it shows tokens only); History keeps a session total.

### Platform fit & iterative editing

The Clips card and every result show a **platform fit** line — duration class
(short-form / long-form), whether it fits YouTube Shorts, Instagram Reels,
Facebook Reels or long-form limits, and an orientation warning where a vertical
9:16 is expected. Target chips in the AI panel ("Instagram Reel ≤ 3:00") add the
length constraint to the instructions.

After a render, **✂ Keep editing this result** loads the edited video as the new
source with its transcript remapped from the original — no re-transcription — so
"remove the part about pricing" or "cut 0:42–0:55" is one AI call plus a render.

### Output bundle, short-form format, limit alerts

- Every render lands in **its own folder** next to the source: the video,
  `transcript.txt` (edited timeline), `transcript_original.txt`, `edit_plan.json`
  and a readable `edit_notes.md` (every cut with its reason, cost). Toggle in
  Shared settings → Output.
- **Output format**: keep source, **vertical 9:16** (crop, with a crop-focus
  setting, or fit over a blurred background) or square. Picking a Shorts/Reel
  target chip switches to vertical automatically; the platform-fit line reflects
  the real output size.
- **Limit alerts**: when a call fails because credits/quota are exhausted,
  you are rate-limited, the key is rejected or the model was retired, a banner
  says so and what to do. No balances are polled or displayed.

### Whisper model downloads

The transcription-model dropdown shows which models are already on disk and the
real download size of the rest (`small` ≈ 486 MB, `medium` ≈ 1.5 GB, `large-v3`
≈ 3.1 GB). **Download now** pre-fetches one with a progress bar; a first-use
download inside a job shows its progress in the status line. On a CPU-only
machine `small` or `medium` is the sweet spot.

### Other changes

- **Hindi**: `whisper.language: hi`, a Hindi/Hinglish filler list, and "कट कट" as a restart trigger.
  Filler lists are now read for every language key under `fillers.words`.
- **Linux / WSL**: works with `libx264` (set `encoding.codec: libx264` to skip the VideoToolbox attempt).
- Extra dependencies the upstream `pyproject.toml` doesn't list: `torchaudio` (needed by Silero VAD),
  `mcp<2` (upstream targets the 1.x API), `anthropic`, `openai`. All handled by `./install.sh`.

## Requirements

| | |
|---|---|
| **OS** | Linux, **WSL2** on Windows (recommended), macOS, or native Windows |
| **Python** | 3.11 – 3.13 — the installer provisions **3.12** for you via `uv`; nothing to install by hand |
| **FFmpeg** | 6 or newer, on your `PATH` (see below) |
| **RAM** | 4 GB for the `small` Whisper model, 8 GB+ for `large-v3` |
| **GPU** | Optional. CPU works fine; an NVIDIA GPU is auto-detected and used if present |
| **Disk** | ~1.5 GB for the app (CPU build) + Whisper models you choose (78 MB – 3 GB each, downloaded on first use) |

Install FFmpeg first:

```bash
# Ubuntu / Debian / WSL2
sudo apt-get update && sudo apt-get install -y ffmpeg
# macOS
brew install ffmpeg
# Windows (native)
winget install Gyan.FFmpeg      # then open a new terminal
```

## Installation

### Linux · WSL2 · macOS

```bash
git clone https://github.com/web-dev-nav/ai-video-editor.git
cd ai-video-editor
./install.sh
```

### Windows (native PowerShell)

```powershell
git clone https://github.com/web-dev-nav/ai-video-editor.git
cd ai-video-editor
powershell -ExecutionPolicy Bypass -File install.ps1
```

The installer is idempotent (re-run it any time) and takes care of the things
that usually go wrong on a fresh machine:

- installs [`uv`](https://docs.astral.sh/uv/) and a private **Python 3.12** — your
  system Python is never touched (and Python 3.14 is refused, because PyTorch
  and faster-whisper have no wheels for it yet)
- installs the **CPU build of PyTorch (~200 MB)** unless an NVIDIA GPU is
  detected — a plain `pip install torch` on Linux silently pulls a 5 GB CUDA
  build that is useless without a GPU (`FORCE_TORCH=cpu|cuda ./install.sh` overrides)
- pins the dependencies this fork needs (`torchaudio` for Silero VAD, `mcp<2`
  for the MCP server, `anthropic`, `openai`, `starlette`, `uvicorn`)
- verifies every import, checks `ffmpeg`, and creates `.env` from `.env.example`

### Start

```bash
./gui/run.sh            # Linux / WSL2 / macOS  → opens http://localhost:8765
.\gui\run.ps1           # Windows
```

The run scripts call the installer automatically if `.venv` is missing, so on a
new machine `git clone` + `./gui/run.sh` is enough.

Add API keys (only needed for the AI editor / hook / chapters) either in the
GUI via **API keys**, or in `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...     # Claude
OPENAI_API_KEY=sk-...            # ChatGPT
OPENROUTER_API_KEY=sk-or-...     # OpenRouter (also used by hook/chapters)
NVIDIA_API_KEY=nvapi-...         # NVIDIA NIM
```

### CLI only

```bash
source .venv/bin/activate        # Windows: .venv\Scripts\activate
ai-video-editor process video.mp4 --whisper-model small --no-hook --no-chapters
ai-video-editor info video.mp4
ai-video-editor models
```

### Troubleshooting

| Symptom | Fix |
|---|---|
| `ffmpeg: command not found` / "ffmpeg missing!" in the GUI header | Install FFmpeg (above) and open a new terminal |
| `No module named 'torchaudio'` | `./install.sh` again — it installs torchaudio next to torch |
| `No module named 'mcp.server.fastmcp'` | You have `mcp` 2.x; `./install.sh` pins `mcp<2` |
| `.venv` is 5 GB / install downloads NVIDIA packages | You got the CUDA torch build. `rm -rf .venv && FORCE_TORCH=cpu ./install.sh` |
| "Loading Whisper model…" for a long time | It is downloading the model (up to 3 GB). The GUI shows the progress; use **Download now** under the model dropdown to pre-fetch |
| Browser doesn't open from WSL | Open http://localhost:8765 yourself; the server binds to 127.0.0.1 |
| Windows paths | Paste `C:\Users\you\Videos\x.mp4` anywhere a path is accepted — they are converted for WSL automatically |
| Python 3.14 error | Expected: use the installer's Python 3.12 (`uv python install 3.12` if you want it manually) |

### Tested with

Ubuntu 24.04 on WSL2 · Python 3.12 · ffmpeg 8.0 · torch 2.14 (CPU) · faster-whisper 1.x ·
anthropic 1.5 · openai 3.x · mcp 1.x · 6-core CPU / 15 GB RAM, no GPU.

## Quick Start

```bash
# Core editing only (no API calls)
ai-video-editor process video.mp4 --no-hook --no-chapters

# Full pipeline with smart hook opener + YouTube chapters (requires OPENROUTER_API_KEY)
ai-video-editor process video.mp4
```

Example output (stdout):

```json
{
  "status": "complete",
  "input": "video.mp4",
  "output_video": "video_edited.mp4",
  "duration_original_sec": 154.6,
  "duration_edited_sec": 145.9,
  "segments_removed": 1,
  "silence_removed_sec": 2.1,
  "restarts_removed": 1,
  "fillers_removed": 4
}
```

Progress events are emitted to stderr as JSON lines during processing.

## CLI Commands

### `process` — Edit a video

```
ai-video-editor process VIDEO [OPTIONS]
```

| Option | Description |
|--------|-------------|
| `--config, -c PATH` | Custom YAML config file (merged over defaults) |
| `--whisper-model, -m MODEL` | Whisper model size: tiny / base / small / medium / large / large-v3 |
| `--lut PATH` | Path to a `.cube` LUT file for color grading |
| `--output, -o PATH` | Output file path (default: `{input}_edited.mp4`) |
| `--no-hook` | Skip smart hook generation (no LLM call) |
| `--no-chapters` | Skip YouTube chapter generation (no LLM call) |
| `--instructions, -i TEXT` | AI Director instructions (enables the director) |
| `--skill NAME` | AI Director editing skill from `skills/` |
| `--plan-only` | Stop after analysis and print the plan as JSON |
| `--analysis-cache PATH` | Cache/reuse speech detection + transcript for this input |
| `--keep-json PATH` | Render exactly these `[{start, end}]` segments |
| `--vo-cues PATH` | Voiceover: JSON list of `{start, text, ...}` cues on the edited timeline |

### `info` — Inspect a video file

```
ai-video-editor info VIDEO
```

Prints codec, resolution, FPS, duration, and bitrate as JSON.

### `models` — List Whisper model sizes

```
ai-video-editor models
```

## Configuration

The default config lives in `config.default.yml`. Override any section with `--config my.yml` — your file is deep-merged over the defaults, so you only need to specify what changes.

| Section | Key settings |
|---------|-------------|
| `whisper` | `model`, `language`, `device` |
| `silence` | `min_gap_sec` (merge threshold), `padding_sec` (breathing room at cuts) |
| `restarts` | `enabled`, `trigger_phrases`, `detect_repeated_starts`, `max_burst_duration_sec` |
| `fillers` | `enabled`, `min_filler_duration_sec`, `words.en`, `words.ru` |
| `audio` | `enabled` (off by default), noise reduction and loudness settings |
| `video` | `lut_path` |
| `hook` | `enabled`, `duration_sec`, `provider`, `model` (null = same as `director`) |
| `chapters` | `enabled`, `provider`, `model` |
| `director` | `enabled`, `provider`, `model`, `mode`, `skill`, `instructions` |
| `voiceover` | `enabled`, `engine` (openai / edge / kokoro), `model`, `voice`, `speed`, `instructions`, `mix_mode` (narrate / replace), `fit`, `max_tempo`, `gain_db`, `duck_original_db`, `cues` / `cues_file` |
| `music` | `enabled`, `path`, `gain_db`, `fade_in_sec`, `fade_out_sec`, `start_offset_sec`, `loop`, `duck`, `duck_db` |
| `mix` | `original_gain_db`, `loudnorm`, `loudness_target` |
| `encoding` | `codec`, `quality`, `audio_codec`, `audio_bitrate` |

Example override — use a smaller Whisper model and enable audio enhancement:

```yaml
# my-config.yml
whisper:
  model: small
audio:
  enabled: true
```

```bash
ai-video-editor process video.mp4 --config my-config.yml
```

## How It Works

The pipeline runs four sequential phases:

1. **Analysis** — Extract audio → Silero VAD (speech segments) → Whisper transcription → edit decisions (remove short bursts, merge short gaps, remove restarts and fillers, apply padding)
2. **Assembly** — Frame-accurate FFmpeg segment extraction → concat → optional audio enhancement → optional LUT color grade
3. **AI Enhancement** — Smart hook selection and YouTube chapters via OpenRouter (skipped if `--no-hook --no-chapters` or no API key)
4. **Encode** — Final h264_videotoolbox (or libx264) encode with AAC audio, optimized for web playback

## Claude Desktop (MCP Server)

The tool includes a built-in MCP server so Claude Desktop can use it as a native capability.

**Setup:**

1. Add to your `claude_desktop_config.json` (see `claude_desktop_config.example.json` for the template):

```json
"ai-video-editor": {
  "command": "/path/to/ai-video-editor/.venv/bin/python",
  "args": ["-m", "src.mcp_server"],
  "cwd": "/path/to/ai-video-editor"
}
```

2. Restart Claude Desktop.
3. Optionally install `SKILL.md` as a capability for model selection guidance and workflow tips.

Claude gets three tools: `process_video`, `video_info`, and `list_models`.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` / `NVIDIA_API_KEY` | Keys for the AI editor, script writer, hook and chapters (any one provider is enough). `OPENAI_API_KEY` also enables OpenAI voices. Set them in a `.env` file next to `pyproject.toml` (the GUI's **API keys** dialog writes it) or export in your shell. Without a key the LLM steps are skipped gracefully. |
| `OPENROUTER_REFERER` | Optional. Shown in your OpenRouter usage dashboard for attribution tracking. |

## License

MIT — see [LICENSE](LICENSE).
