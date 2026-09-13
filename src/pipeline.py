"""Pipeline orchestrator — runs all steps in sequence and tracks progress."""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any

from .config import load_config, get_openrouter_api_key
from .utils.json_output import emit_progress, Timer
from .utils.ffmpeg import probe_duration, probe_video_info

logger = logging.getLogger(__name__)


class PipelineError(RuntimeError):
    """Raised when a pipeline step fails unrecoverably."""
    pass


def run_pipeline(
    input_video: str | Path,
    config_path: str | Path | None = None,
    whisper_model: str | None = None,
    lut_path: str | Path | None = None,
    output_path: str | Path | None = None,
    no_hook: bool = False,
    no_chapters: bool = False,
    instructions: str | None = None,
    skill: str | None = None,
    plan_only: bool = False,
    analysis_cache: str | Path | None = None,
    keep_override: list[dict] | None = None,
) -> dict[str, Any]:
    """Execute the full video editing pipeline.

    Args:
        input_video: Path to the input video file.
        config_path: Optional path to a user YAML config file.
        whisper_model: Override the Whisper model (e.g., "medium", "large-v3").
        lut_path: Optional path to a .cube LUT file for color grading.
        output_path: Optional explicit output file path.
        no_hook: If True, skip the smart hook step.
        no_chapters: If True, skip the chapter generation step.
        instructions: Natural-language editing instructions for the AI Director.
            Enables the director step when given.
        plan_only: Stop after analysis and return the AI Director's plan
            (status "plan") without assembling or encoding.
        analysis_cache: JSON file caching VAD + transcription results for this
            input, so re-planning or re-rendering skips the slow Whisper pass.
        keep_override: Explicit keep segments [{start, end}] in playback order;
            skips edit_decisions and the director entirely (used to render a
            reviewed plan).

    Returns:
        A result dict suitable for JSON serialization:
        {status, input, output_video, chapters_file, duration_original_sec,
         duration_edited_sec, segments_removed, silence_removed_sec,
         restarts_removed, fillers_removed, hook_segment, chapters,
         processing_time_sec}
    """
    timer = Timer()
    input_video = Path(input_video)

    # Load and apply CLI overrides to config
    config = load_config(config_path)
    if whisper_model:
        config["whisper"]["model"] = whisper_model
    if lut_path:
        config["video"]["lut_path"] = str(lut_path)
    if no_hook:
        config["hook"]["enabled"] = False
    if no_chapters:
        config["chapters"]["enabled"] = False
    config.setdefault("director", {})
    if instructions is not None:
        config["director"]["instructions"] = instructions
        config["director"]["enabled"] = True
    if skill:
        config["director"]["skill"] = skill
        config["director"]["enabled"] = True

    # Probe original video duration
    emit_progress("setup", "probe", 0.0, "Probing input video...")
    try:
        duration_original = probe_duration(input_video)
    except Exception as e:
        raise PipelineError(f"Cannot read input video: {e}") from e

    emit_progress("setup", "probe", 1.0, f"Input: {input_video.name} ({duration_original:.1f}s)")

    # Determine output path
    if output_path:
        resolved_output = Path(output_path)
    else:
        resolved_output = input_video.parent / f"{input_video.stem}_edited{input_video.suffix}"

    # Build initial pipeline context
    context: dict[str, Any] = {
        "input_video": str(input_video),
        "output_video": str(resolved_output),
        "total_duration": duration_original,
    }

    with tempfile.TemporaryDirectory(prefix="ai-video-editor-") as work_dir:
        context["work_dir"] = work_dir

        # ------------------------------------------------------------------ #
        # Phase 1: Analysis
        # ------------------------------------------------------------------ #
        emit_progress("analysis", "start", 0.0, "Starting analysis phase...")

        cached = _load_analysis_cache(analysis_cache, input_video, config)
        if cached:
            emit_progress("analysis", "cache", 1.0, "Loaded cached speech detection + transcript.")
            context.update(cached)
        else:
            from .steps.extract_audio import run as extract_audio
            context.update(extract_audio(context, config))

            from .steps.detect_speech import run as detect_speech
            context.update(detect_speech(context, config))

            from .steps.transcribe import run as transcribe
            context.update(transcribe(context, config))

            _save_analysis_cache(analysis_cache, input_video, config, context)

        if keep_override:
            context["keep_segments"] = [
                {"start": float(s["start"]), "end": float(s["end"])} for s in keep_override
            ]
            context.setdefault("edit_stats", {})
            emit_progress("analysis", "edit_decisions", 1.0,
                          f"Using reviewed plan: {len(keep_override)} segments.")
        else:
            from .steps.edit_decisions import run as edit_decisions
            context.update(edit_decisions(context, config))

            from .steps.ai_director import run as ai_director
            context.update(ai_director(context, config))

        if plan_only:
            return {
                "status": "plan",
                "input": str(input_video),
                "duration_original_sec": round(duration_original, 2),
                "plan": context.get("director_plan"),
                "keep_segments": context.get("keep_segments", []),
                "edit_stats": context.get("edit_stats", {}),
                "transcript": [
                    {"start": t["start"], "end": t["end"], "text": t.get("text", "").strip()}
                    for t in context.get("transcript", [])
                ],
                "processing_time_sec": timer.elapsed(),
            }

        # ------------------------------------------------------------------ #
        # Phase 2: Assembly
        # ------------------------------------------------------------------ #
        emit_progress("assembly", "start", 0.0, "Starting assembly phase...")

        # Convert keep_segments to the format assemble.py expects: [(start, end), ...]
        keep_segs_raw = context.get("keep_segments", [])
        context["keep_segments"] = [(s["start"], s["end"]) for s in keep_segs_raw]

        from .steps.assemble import run as assemble
        context.update(assemble(context, config))

        from .steps.enhance_audio import run as enhance_audio
        context.update(enhance_audio(context, config))

        from .steps.color_grade import run as color_grade
        context.update(color_grade(context, config))

        # ------------------------------------------------------------------ #
        # Phase 3: AI Enhancement
        # ------------------------------------------------------------------ #
        emit_progress("ai_enhancement", "start", 0.0, "Starting AI enhancement phase...")

        from .steps.smart_hook import run as smart_hook
        context.update(smart_hook(context, config))

        if context.get("hook_segment"):
            _prepend_hook(context, config)

        from .steps.chapters import run as chapters
        context.update(chapters(context, config))

        # ------------------------------------------------------------------ #
        # Phase 4: Final Encode
        # ------------------------------------------------------------------ #
        emit_progress("encode", "start", 0.0, "Starting final encode phase...")

        from .steps.encode import run as encode
        context.update(encode(context, config))

    # ------------------------------------------------------------------ #
    # Build result
    # ------------------------------------------------------------------ #
    edit_stats: dict = context.get("edit_stats", {})
    output_video_path = context.get("output_video", str(resolved_output))

    try:
        duration_edited = probe_duration(output_video_path)
    except Exception:
        duration_edited = 0.0

    result: dict[str, Any] = {
        "status": "complete",
        "input": str(input_video),
        "output_video": output_video_path,
        "chapters_file": context.get("chapters_file"),
        "duration_original_sec": round(duration_original, 2),
        "duration_edited_sec": round(duration_edited, 2),
        "segments_removed": edit_stats.get("segments_removed", 0),
        "silence_removed_sec": edit_stats.get("silence_removed_sec", 0.0),
        "restarts_removed": edit_stats.get("restarts_removed", 0),
        "fillers_removed": edit_stats.get("fillers_removed", 0),
        "hook_segment": context.get("hook_segment"),
        "chapters": context.get("chapters"),
        "director_plan": context.get("director_plan"),
        "director_removed_sec": edit_stats.get("director_removed_sec", 0.0),
        # Kept ranges of the *input* in playback order — lets a GUI map the transcript
        # onto the output so the result can be edited again without re-transcribing.
        "keep_segments": [
            {"start": float(s[0]), "end": float(s[1])} if isinstance(s, (tuple, list)) else s
            for s in context.get("keep_segments", [])
        ],
        "processing_time_sec": timer.elapsed(),
    }

    return result


# ---------------------------------------------------------------------------
# Analysis cache (VAD + transcript) so re-planning skips Whisper
# ---------------------------------------------------------------------------

def _cache_key(input_video: Path, config: dict[str, Any]) -> dict[str, Any]:
    st = input_video.stat()
    return {
        "input": str(input_video.resolve()),
        "size": st.st_size,
        "mtime": int(st.st_mtime),
        "whisper_model": config["whisper"].get("model"),
        "language": config["whisper"].get("language", "auto"),
    }


def _load_analysis_cache(path: str | Path | None, input_video: Path, config: dict[str, Any]) -> dict | None:
    if not path or not Path(path).exists():
        return None
    try:
        with open(path) as f:
            data = json.load(f)
        if data.get("key") != _cache_key(input_video, config):
            return None
        return {
            "speech_segments": data["speech_segments"],
            "transcript": data["transcript"],
            "detected_language": data.get("detected_language"),
        }
    except (OSError, KeyError, ValueError) as e:
        logger.warning("Ignoring unreadable analysis cache %s: %s", path, e)
        return None


def _save_analysis_cache(path: str | Path | None, input_video: Path, config: dict[str, Any], context: dict) -> None:
    if not path:
        return
    try:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w") as f:
            json.dump({
                "key": _cache_key(input_video, config),
                "speech_segments": context.get("speech_segments", []),
                "transcript": context.get("transcript", []),
                "detected_language": context.get("detected_language"),
            }, f)
    except OSError as e:
        logger.warning("Could not write analysis cache %s: %s", path, e)


def _prepend_hook(context: dict[str, Any], config: dict[str, Any]) -> None:
    """Prepend the hook segment to the assembled video with a crossfade transition.

    Extracts the hook clip from the original video, then uses FFmpeg's xfade
    filter to join it with the assembled video with a brief crossfade.
    """
    from .utils.ffmpeg import ffmpeg_bin, run as run_ffmpeg

    hook = context["hook_segment"]
    assembled = context["assembled_video"]
    work_dir = context["work_dir"]

    hook_start = hook["start"]
    hook_end = hook["end"]
    crossfade_sec = config.get("hook", {}).get("crossfade_sec", 0.5)

    # Extract hook clip
    hook_clip = str(Path(work_dir) / "hook_clip.mp4")
    hook_duration = hook_end - hook_start
    cmd_extract = [
        ffmpeg_bin(),
        "-y",
        "-ss", str(hook_start),
        "-i", context["input_video"],
        "-t", str(hook_duration),
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "18",
        "-c:a", "aac",
        hook_clip,
    ]
    try:
        run_ffmpeg(cmd_extract)
    except Exception as e:
        logger.warning("Failed to extract hook clip: %s — skipping hook prepend.", e)
        return

    # Prepend hook with xfade crossfade into assembled video
    output_with_hook = str(Path(work_dir) / "assembled_with_hook.mp4")
    xfade_offset = max(0.1, hook_duration - crossfade_sec)

    filter_str = (
        f"[0:v][1:v]xfade=transition=fade:duration={crossfade_sec}:offset={xfade_offset}[outv];"
        f"[0:a][1:a]acrossfade=d={crossfade_sec}[outa]"
    )

    cmd_join = [
        ffmpeg_bin(),
        "-y",
        "-i", hook_clip,
        "-i", assembled,
        "-filter_complex", filter_str,
        "-map", "[outv]",
        "-map", "[outa]",
        "-c:v", "libx264",
        "-crf", "18",
        "-preset", "fast",
        output_with_hook,
    ]

    try:
        run_ffmpeg(cmd_join)
        context["assembled_video"] = output_with_hook
        emit_progress("ai_enhancement", "hook_prepend", 1.0, "Hook prepended to video.")
    except Exception as e:
        logger.warning("Failed to prepend hook: %s — proceeding without hook.", e)
