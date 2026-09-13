# GUI for ai-video-editor

A local web interface wrapping the CLI. Start it with:

    ~/ai-video-editor/gui/run.sh

It opens http://localhost:8765 in your browser (add `--no-browser` to skip that).
Pick a video from your Windows Downloads/Videos/Desktop, adjust settings, press
**Process video**. Output lands next to the input as `<name>_edited.mp4`.

## AI Director

Let Claude or ChatGPT decide *what content* to keep:

1. Header → **API keys** → pick Claude (Anthropic) or ChatGPT (OpenAI), paste the key.
2. Pick a video, optionally press **Analyze / transcribe** to read the transcript.
3. Write instructions in the AI Director box, press **Ask AI for a plan**.
4. Review the plan (untick kept pieces / tick removed ones to restore), revise if
   needed, then **Render this plan**.

Speech detection + transcription are cached per input in `uploads/.cache/`, so
re-planning and rendering only pay for the LLM call and the encode.

CLI equivalents:

    ai-video-editor process in.mp4 -i "cut to 60s" --plan-only --analysis-cache c.json
    ai-video-editor process in.mp4 --keep-json keep.json --analysis-cache c.json -o out.mp4
