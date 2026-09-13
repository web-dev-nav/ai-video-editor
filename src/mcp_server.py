"""MCP server for AI Video Editor — exposes process_video, video_info, list_models, list_skills."""

from __future__ import annotations

import json
from pathlib import Path

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("ai-video-editor")


@mcp.tool()
def process_video(
    video_path: str,
    output_path: str | None = None,
    whisper_model: str | None = None,
    config_path: str | None = None,
    no_hook: bool = True,
    no_chapters: bool = True,
    instructions: str | None = None,
    skill: str | None = None,
    plan_only: bool = False,
    analysis_cache: str | None = None,
) -> str:
    """Edit a talking-head video. Without `instructions`/`skill` the rule-based Auto edit runs
    (silences, filler-word lists, "cut cut" takes). With either, the AI editor runs: an LLM
    reads the word-timestamped transcript and removes fillers, stutters, repeats, stalls and
    rambling by judgement, following the chosen editing skill and the instructions.

    Args:
        video_path: Absolute path to the input video file.
        output_path: Output file path. Default: {input_name}_edited.mp4 in same directory.
        whisper_model: Whisper model size: tiny, base, small, medium, large, large-v2, large-v3.
            On CPU-only machines prefer "small" or "medium".
        config_path: Path to a custom YAML config file (merged over defaults).
        no_hook: Skip smart hook generation (OpenRouter). Default: true.
        no_chapters: Skip YouTube chapter generation (OpenRouter). Default: true.
        instructions: Natural-language editing instructions for the AI editor, e.g.
            "cut to under 60 seconds, drop the part about pricing, open with the strongest line".
        skill: Editing skill id from list_skills(): clean, film-director, youtube-retention,
            shorts, tutorial, interview (or a user-added one). Enables the AI editor.
        plan_only: Return the AI's plan (kept/removed pieces with reasons) without rendering.
        analysis_cache: JSON file to cache/reuse speech detection + transcription for this
            video, so repeated plans/renders skip Whisper.

    Returns:
        JSON string with status, output_video path, duration stats, edit counts, and — when
        the AI editor ran — director_plan (summary, keep, removed with reasons, usage).
    """
    from .pipeline import run_pipeline, PipelineError

    try:
        result = run_pipeline(
            input_video=Path(video_path),
            config_path=Path(config_path) if config_path else None,
            whisper_model=whisper_model,
            output_path=Path(output_path) if output_path else None,
            no_hook=no_hook,
            no_chapters=no_chapters,
            instructions=instructions,
            skill=skill,
            plan_only=plan_only,
            analysis_cache=Path(analysis_cache) if analysis_cache else None,
        )
        return json.dumps(result, indent=2, ensure_ascii=False)
    except PipelineError as e:
        return json.dumps({"status": "error", "error": {"code": "PIPELINE_ERROR", "message": str(e)}}, indent=2)
    except FileNotFoundError as e:
        return json.dumps({"status": "error", "error": {"code": "FILE_NOT_FOUND", "message": str(e)}}, indent=2)
    except Exception as e:
        return json.dumps({"status": "error", "error": {"code": "UNEXPECTED_ERROR", "message": str(e)}}, indent=2)


@mcp.tool()
def video_info(video_path: str) -> str:
    """Get metadata about a video file: duration, resolution, codec, FPS, audio info.

    Args:
        video_path: Absolute path to the video file.

    Returns:
        JSON string with file, format, duration_sec, size_mb, video and audio stream info.
    """
    from .utils.ffmpeg import probe_video_info

    try:
        data = probe_video_info(Path(video_path))
    except Exception as e:
        return json.dumps({"status": "error", "error": str(e)}, indent=2)

    fmt = data.get("format", {})
    streams = data.get("streams", [])
    video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)

    info: dict = {
        "file": video_path,
        "format": fmt.get("format_long_name", fmt.get("format_name")),
        "duration_sec": round(float(fmt.get("duration", 0)), 2),
        "size_mb": round(int(fmt.get("size", 0)) / (1024 * 1024), 2),
        "bit_rate_kbps": round(int(fmt.get("bit_rate", 0)) / 1000, 1),
    }

    if video_stream:
        fps_str = video_stream.get("avg_frame_rate", "0/1")
        try:
            parts = fps_str.split("/")
            fps = round(int(parts[0]) / int(parts[1]), 3) if len(parts) == 2 else float(fps_str)
        except (ValueError, ZeroDivisionError):
            fps = None
        info["video"] = {
            "codec": video_stream.get("codec_name"),
            "width": video_stream.get("width"),
            "height": video_stream.get("height"),
            "fps": fps,
        }

    if audio_stream:
        info["audio"] = {
            "codec": audio_stream.get("codec_name"),
            "sample_rate": audio_stream.get("sample_rate"),
            "channels": audio_stream.get("channels"),
        }

    return json.dumps(info, indent=2, ensure_ascii=False)


@mcp.tool()
def list_skills() -> str:
    """List the editing skills the AI editor can follow (id, name, description).

    Pass an id as `skill` to process_video. Skills are Markdown briefs in skills/;
    users can add their own.
    """
    from .skills import load_skills

    return json.dumps(
        [{k: v for k, v in sk.items() if k in ("id", "name", "emoji", "description")} for sk in load_skills()],
        indent=2, ensure_ascii=False,
    )


@mcp.tool()
def list_models() -> str:
    """List available Whisper transcription models with size, speed, and accuracy information.

    Returns:
        JSON array of model objects with name, size, speed_cpu, and notes.
    """
    models = [
        {"name": "tiny",     "size": "~39 MB",   "speed_cpu": "~32x realtime", "notes": "Basic accuracy"},
        {"name": "base",     "size": "~74 MB",   "speed_cpu": "~16x realtime", "notes": "Decent accuracy"},
        {"name": "small",    "size": "~244 MB",  "speed_cpu": "~6x realtime",  "notes": "Good accuracy"},
        {"name": "medium",   "size": "~769 MB",  "speed_cpu": "~2x realtime",  "notes": "Great accuracy"},
        {"name": "large",    "size": "~1.5 GB",  "speed_cpu": "~1x realtime",  "notes": "Excellent accuracy"},
        {"name": "large-v2", "size": "~1.5 GB",  "speed_cpu": "~1x realtime",  "notes": "Improved large"},
        {"name": "large-v3", "size": "~1.5 GB",  "speed_cpu": "~1x realtime",  "notes": "Best accuracy (default)"},
    ]
    return json.dumps(models, indent=2)


if __name__ == "__main__":
    mcp.run(transport="stdio")
