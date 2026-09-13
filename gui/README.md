# GUI for ai-video-editor

A local web interface wrapping the CLI. Start it with:

    ~/ai-video-editor/gui/run.sh

It opens http://localhost:8765 in your browser (add `--no-browser` to skip that).
Pick a video from your Windows Downloads/Videos/Desktop, adjust settings, press
**Process video**. Output lands next to the input as `<name>_edited.mp4`.

## Multiple clips

Click several videos (or **+ all** for a folder) to build an ordered sequence;
reorder with ↑/↓. They are joined in that order — normalised to the first clip's
resolution and frame rate — and then edited as one video in either mode. The
combined file is cached under `uploads/.cache/combined/`.

## Usage & cost

Every AI plan or render shows the tokens in/out and the cost (input, output,
total). Prices come live from OpenRouter's model catalogue (covers Claude and
GPT models), with a built-in table as fallback. History shows the session total.

## Two ways to edit

**Auto** — fixed rules, offline: trims dead air (voice detection), removes words
from the filler lists, drops takes marked "cut cut". Press *Edit video*.

**AI editor** — Claude / ChatGPT reads the transcript and edits it like a person:
fillers judged in context (any language), stutters, false starts, repeated
sentences (best take kept), stalls, rambling — plus any instructions you type.

1. Header → **API keys** → add a Claude (Anthropic) or ChatGPT (OpenAI) key.
2. Pick a video, choose **AI editor**, optionally type instructions.
3. **Ask AI for a plan** → review every cut (tick to restore, untick to drop),
   ask for revisions → **Render this plan**.

Speech detection + transcription are cached per input in `uploads/.cache/`, so
re-planning and rendering only pay for the LLM call and the encode.

CLI equivalents:

    ai-video-editor process in.mp4 -i "cut to 60s" --plan-only --analysis-cache c.json
    ai-video-editor process in.mp4 --keep-json keep.json --analysis-cache c.json -o out.mp4
