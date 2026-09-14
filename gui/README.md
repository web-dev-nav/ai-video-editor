# GUI for ai-video-editor

A local web interface wrapping the CLI. Start it with:

    ~/ai-video-editor/gui/run.sh

It opens http://localhost:8765 in your browser (add `--no-browser` to skip that).

## Layout

```
┌ project name · New / Open / Save ─────────────── API keys · ▶ Render ┐
│ 📁 Media   │                                   │ Inspector            │
│ ✂️ Edit    │            preview                │  export & settings,  │
│ 🎙 Voiceover│   (source with the cuts skipped, │  or the selected     │
│ 🎵 Audio   │    or the rendered file)          │  piece / cue / music │
│            │   transcript strip                │                      │
├────────────┴───────────────────────────────────┴──────────────────────┤
│ 🎞 Video     ▇▇▇▇▇▇▇▇ ┊ ▇▇▇▇▇▇▇▇▇▇▇▇ ┊ ▇▇▇▇          (cuts = red marks)│
│ 🎙 Voiceover  ▇▇▇▇      ▇▇▇▇▇▇     ▇▇▇                                 │
│ 🎵 Music     ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇ │
├ ▴ Jobs ── progress · log · result · history & cost ───────────────────┤
```

1. **Media** — pick a video (Windows folders are mapped), or several to join them.
2. **Edit** — *Auto* (rules) or *AI editor* (Claude / ChatGPT). The top-right button
   runs **Analyze** / **Ask AI for a plan**; the cuts appear on the timeline and in
   the Edit tab. Click a red cut mark or a block to select it; the inspector lets
   you put it back or remove it. The preview skips the cut parts as you play.
3. **Voice** — off by default; tick **Add a text-to-speech voiceover** to use it
   (nothing is added to the video otherwise). Then pick an engine and voice, *Test this voice*, then either
   **Suggest from transcript** (the AI rewrites the edited transcript into a
   narration, one cue per sentence, aligned to the video) or type your own script.
   Generate cues to hear them; drag them on the timeline; the inspector shows
   whether a cue fits its slot. *Narrate over* ducks your voice under the cue;
   *Replace my voice* mutes it while the cue plays.
4. **Audio** — background music (browse audio files or drop one), level, fades,
   start offset, loop, ducking; mixer for original / voiceover / music levels.
5. **Render** — the timeline as it is (cuts + voiceover + music). The output goes
   to its own folder with `project.json`, `analysis_cache.json`, transcript, notes
   and plan. Press **Rendered** under the preview to watch it.

Space plays/pauses, ←/→ steps 1 s (Shift = 5 s), Ctrl+wheel zooms the timeline.

**Hindi in Roman letters** — the **अ→A Roman** button under the preview shows
Devanagari as Hinglish everywhere (transcript, cuts, timeline, cue list):
"कैसा है" → "kaisa hai". It is display only — the AI editor, the script writer
and the Hindi voices still get the original Devanagari (that is what they
pronounce correctly). Output folders also get `transcript_roman.txt`. The
spelling is the usual informal one (`src/utils/translit.py`), not a strict
standard.

## Projects

Everything autosaves to `uploads/.projects/<id>.json` as soon as a video is
added. **Open…** lists your projects; a `project.json` from an output folder can
be imported (its `analysis_cache.json` is restored so re-rendering skips Whisper).
Reopen a project days later, toggle a cut, add a cue, change the music level,
press Render. **Keep editing this result** starts a *new* project whose source is
the rendered file (its transcript is carried over).

## Text-to-speech engines

| Engine | Cost | Needs | Notes |
|---|---|---|---|
| OpenAI `gpt-4o-mini-tts` | ≈ $0.015 / 1k chars | `OPENAI_API_KEY` | most natural; "delivery instructions" steer tone |
| Edge (Microsoft) | free | internet | 300+ neural voices, many languages |
| Kokoro | free | `uv pip install -e ".[tts-local]"` (+ `apt install espeak-ng`), ~330 MB model on first use | offline, runs on CPU |

Generated clips are cached in `uploads/.cache/tts/` by (engine, voice, text,
speed, instructions), so regenerating an unchanged cue is instant and free.

## Multiple clips

Click several videos (or **+ all** for a folder) to build an ordered sequence;
reorder with ↑/↓. They are joined in that order — normalised to the first clip's
resolution and frame rate — and then edited as one video in either mode. The
combined file is cached under `uploads/.cache/combined/`.

## Whisper models

The transcription model dropdown shows which models are already on this machine
and the real download size of the others (`small` ≈ 486 MB, `medium` ≈ 1.5 GB,
`large-v3` ≈ 3.1 GB). Press **Download now** to fetch one with a progress bar,
or just run — a first-use download shows its progress inside the job.

## Usage & cost

Every AI plan or render shows the tokens in/out and the cost (input, output,
total). Prices come live from OpenRouter's model catalogue (covers Claude and
GPT models), with a built-in table as fallback. History shows the session total.

## Two ways to edit

**Auto** — fixed rules, offline: trims dead air (voice detection), removes words
from the filler lists, drops takes marked "cut cut". Press *Analyze & cut*, review,
*Render* (or *Edit & render in one go*).

**AI editor** — Claude / ChatGPT reads the transcript and edits it like a person:
fillers judged in context (any language), stutters, false starts, repeated
sentences (best take kept), stalls, rambling — plus any instructions you type.

1. Header → **API keys** → add a Claude (Anthropic) or ChatGPT (OpenAI) key.
2. Pick a video, choose **AI editor**, optionally type instructions.
3. **Ask AI for a plan** → review every cut (on the timeline or in the list: tick
   to restore, untick to drop), ask for revisions → **Render**.

Hook opener and YouTube chapters (inspector → *Hook opener & chapters*) use the
same provider/model pickers and run on any provider you have a key for.

Speech detection + transcription are cached per input in `uploads/.cache/`, so
re-planning and rendering only pay for the LLM call and the encode.

CLI equivalents:

    ai-video-editor process in.mp4 -i "cut to 60s" --plan-only --analysis-cache c.json
    ai-video-editor process in.mp4 --keep-json keep.json --analysis-cache c.json -o out.mp4
    ai-video-editor process in.mp4 --keep-json keep.json --vo-cues cues.json -c music.yml
