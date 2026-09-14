"""Audio mix step — original voice + voiceover cues + background music in one ffmpeg pass.

Runs after assembly (and after the hook is prepended, so cue times are shifted by
context["timeline_offset_sec"]). Video is stream-copied; only the audio is rebuilt.

Graph (branches are omitted when unused):
  original ─ gain ─[replace: mute under cues]─┬─────────────────────────────┐
                                              └ sidechain key ─┐           │
  cues ─ atempo ─ adelay ─ amix ─ pad ─ gain ──────────────────┼─ key ─┐   │
  music ─ trim/offset ─ fades ─ gain ─ sidechaincompress(key) ─┼───────┘   │
                                                              amix ─ loudnorm/limiter → [mix]
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from ..utils.ffmpeg import ffmpeg_bin, probe_duration
from ..utils.ffmpeg import run as run_ffmpeg
from ..utils.json_output import emit_progress

logger = logging.getLogger(__name__)

AFORMAT = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"


def run(context: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    vo_cfg = config.get("voiceover") or {}
    music_cfg = config.get("music") or {}
    mix_cfg = config.get("mix") or {}
    clips: list[dict] = context.get("voiceover_clips") or []
    music_on = bool(music_cfg.get("enabled") and music_cfg.get("path"))
    if not clips and not music_on and float(mix_cfg.get("original_gain_db", 0) or 0) == 0 and not mix_cfg.get("loudnorm"):
        emit_progress("ai", "mix_audio", 1.0, "Audio mix: nothing to mix — skipping.")
        return {}

    assembled = Path(context["assembled_video"])
    work_dir = Path(context["work_dir"])
    out = work_dir / f"{assembled.stem}_mixed{assembled.suffix}"
    duration = float(probe_duration(assembled))
    offset = float(context.get("timeline_offset_sec", 0.0) or 0.0)

    what = [f"{len(clips)} voiceover cue{'s' if len(clips) != 1 else ''}" if clips else None,
            "background music" if music_on else None]
    emit_progress("ai", "mix_audio", 0.1, "Mixing " + " + ".join(w for w in what if w) + "…" if any(what) else "Adjusting audio levels…")
    cmd = build_mix_command(str(assembled), duration, clips, vo_cfg, music_cfg, mix_cfg, str(out), offset)
    run_ffmpeg(cmd)
    emit_progress("ai", "mix_audio", 1.0, "Audio mix complete.")
    return {"assembled_video": str(out)}


# ---------------------------------------------------------------------------
# Pure builders (unit-tested; no ffmpeg needed)
# ---------------------------------------------------------------------------

def atempo_chain(tempo: float) -> str:
    """ffmpeg's atempo accepts 0.5–2.0 per instance; chain for anything beyond."""
    parts: list[float] = []
    t = float(tempo)
    while t > 2.0:
        parts.append(2.0); t /= 2.0
    while t < 0.5:
        parts.append(0.5); t /= 0.5
    parts.append(round(t, 4))
    return ",".join(f"atempo={p:g}" for p in parts)


def duck_ratio(duck_db: float) -> float:
    """Compressor ratio that roughly yields `duck_db` of gain reduction on a loud key."""
    # sidechaincompress ratio ~ how many dB over threshold become 1 dB; 12 dB duck ≈ ratio 8.
    return max(1.5, min(20.0, round(abs(float(duck_db)) / 1.5, 2)))


def _db(x: float) -> str:
    return f"volume={float(x):g}dB"


def build_filter_complex(duration: float, clips: list[dict], vo_cfg: dict, music_cfg: dict, mix_cfg: dict,
                         offset: float = 0.0, music_index: int | None = None) -> str:
    """Build the filter graph. Input 0 = video, inputs 1..N = cues, `music_index` = music file."""
    parts: list[str] = []
    n = len(clips)
    replace = (vo_cfg.get("mix_mode") or "narrate") == "replace" and n > 0
    duck_orig = (vo_cfg.get("mix_mode") or "narrate") == "narrate" and n > 0 and float(vo_cfg.get("duck_original_db", -12) or 0) < 0
    music_on = music_index is not None
    duck_music = music_on and bool(music_cfg.get("duck", True))  # keyed by original speech (+ VO when present)

    # --- original voice -------------------------------------------------
    orig_chain = [AFORMAT, _db(mix_cfg.get("original_gain_db", 0) or 0)]
    if replace:
        windows = "+".join(f"between(t,{c['start'] + offset:.3f},{c['start'] + offset + c['fitted_sec']:.3f})" for c in clips)
        orig_chain.append(f"volume=0:enable='{windows}'")
    key_splits = (1 if duck_music else 0)
    if key_splits:
        parts.append(f"[0:a]{','.join(orig_chain)},asplit=2[orig][orig_k]")
    else:
        parts.append(f"[0:a]{','.join(orig_chain)}[orig]")

    # --- voiceover bed --------------------------------------------------
    if n:
        labels = []
        for i, c in enumerate(clips, start=1):
            chain = []
            if abs(float(c.get("tempo", 1.0)) - 1.0) > 0.001:
                chain.append(atempo_chain(c["tempo"]))
            ms = int(round((float(c["start"]) + offset) * 1000))
            chain += [AFORMAT, f"adelay={ms}:all=1"]
            parts.append(f"[{i}:a]{','.join(chain)}[c{i}]")
            labels.append(f"[c{i}]")
        vo_tail = [f"apad=whole_dur={duration:.3f}", f"atrim=0:{duration:.3f}", _db(vo_cfg.get("gain_db", 0) or 0)]
        mixed = "".join(labels) + (f"amix=inputs={n}:duration=longest:normalize=0," if n > 1 else "") + ",".join(vo_tail)
        n_out = 1 + (1 if duck_orig else 0) + (1 if duck_music else 0)
        if n_out > 1:
            outs = ["[vo]"] + (["[vo_k1]"] if duck_orig else []) + (["[vo_k2]"] if duck_music else [])
            parts.append(f"{mixed},asplit={n_out}{''.join(outs)}")
        else:
            parts.append(f"{mixed}[vo]")

    # narrate mode: original ducks under the voiceover
    orig_label = "[orig]"
    if duck_orig:
        r = duck_ratio(vo_cfg.get("duck_original_db", -12))
        parts.append(f"[orig][vo_k1]sidechaincompress=threshold=0.02:ratio={r:g}:attack=30:release=350:level_sc=1[orig_d]")
        orig_label = "[orig_d]"

    # --- music ------------------------------------------------------------
    music_label = None
    if music_on:
        start = max(0.0, float(music_cfg.get("start_offset_sec", 0) or 0))
        fi = max(0.0, float(music_cfg.get("fade_in_sec", 0) or 0))
        fo = max(0.0, float(music_cfg.get("fade_out_sec", 0) or 0))
        chain = [AFORMAT, f"atrim=start={start:.3f}:end={start + duration:.3f}", "asetpts=PTS-STARTPTS",
                 f"apad=whole_dur={duration:.3f}"]
        if fi > 0:
            chain.append(f"afade=t=in:st=0:d={fi:g}")
        if fo > 0:
            chain.append(f"afade=t=out:st={max(0.0, duration - fo):.3f}:d={fo:g}")
        chain.append(_db(music_cfg.get("gain_db", -18) or 0))
        parts.append(f"[{music_index}:a]{','.join(chain)}[m0]")
        music_label = "[m0]"
        if duck_music:
            if n:
                parts.append("[orig_k][vo_k2]amix=inputs=2:duration=first:normalize=0[key]")
                key = "[key]"
            else:
                key = "[orig_k]"
            r = duck_ratio(music_cfg.get("duck_db", -12))
            parts.append(f"[m0]{key}sidechaincompress=threshold=0.03:ratio={r:g}:attack=50:release=500:level_sc=1[mus]")
            music_label = "[mus]"

    # --- final ------------------------------------------------------------
    inputs = [orig_label] + (["[vo]"] if n else []) + ([music_label] if music_label else [])
    tail = "loudnorm=I={:g}:LRA=11:TP=-1".format(float(mix_cfg.get("loudness_target", -14) or -14)) if mix_cfg.get("loudnorm") else "alimiter=limit=-1dB:level=false"
    if len(inputs) == 1:
        parts.append(f"{inputs[0]}{tail}[mix]")
    else:
        parts.append(f"{''.join(inputs)}amix=inputs={len(inputs)}:duration=first:normalize=0,{tail}[mix]")
    return ";".join(parts)


def build_mix_command(video: str, duration: float, clips: list[dict], vo_cfg: dict, music_cfg: dict, mix_cfg: dict,
                      out: str, offset: float = 0.0, audio_bitrate: str = "192k") -> list[str]:
    cmd = [ffmpeg_bin(), "-y", "-i", video]
    for c in clips:
        cmd += ["-i", str(c["path"])]
    music_index = None
    if music_cfg.get("enabled") and music_cfg.get("path"):
        music_index = 1 + len(clips)
        if music_cfg.get("loop", True):
            cmd += ["-stream_loop", "-1"]
        cmd += ["-i", str(music_cfg["path"])]
    fc = build_filter_complex(duration, clips, vo_cfg, music_cfg, mix_cfg, offset, music_index)
    # No -shortest: it ends early with looped inputs; the graph already pins the mix to the video length.
    cmd += ["-filter_complex", fc, "-map", "0:v", "-map", "[mix]", "-c:v", "copy",
            "-c:a", "aac", "-b:a", audio_bitrate, out]
    return cmd
