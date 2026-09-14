"""Voiceover step — synthesizes every TTS cue and works out how it fits its slot.

Cues are authored on the EDITED timeline (what the viewer sees after cuts):
  {start, end?, text, voice?, speed?, instructions?, audio?}
`audio` is a ready-made clip (the GUI generates and previews clips up front); when it
is missing the clip is synthesized here with the engine settings in config["voiceover"].

The step does not touch the video — it returns `voiceover_clips` for mix_audio.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from ..utils import tts
from ..utils.json_output import emit_progress

logger = logging.getLogger(__name__)


def run(context: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    vo_cfg = config.get("voiceover") or {}
    if not vo_cfg.get("enabled"):
        emit_progress("ai", "voiceover", 1.0, "Voiceover disabled — skipping.")
        return {}
    cues = load_cues(vo_cfg)
    if not cues:
        emit_progress("ai", "voiceover", 1.0, "Voiceover: no cues — skipping.")
        return {}

    cache_dir = vo_cfg.get("cache_dir") or str(Path(context["work_dir"]) / "tts")
    fit_mode = vo_cfg.get("fit", "tempo")
    max_tempo = float(vo_cfg.get("max_tempo", 1.3))
    clips: list[dict] = []
    chars = 0
    cost = 0.0
    n = len(cues)
    for i, cue in enumerate(cues):
        emit_progress("ai", "voiceover", i / n, f"Voiceover {i + 1}/{n}: {cue['text'][:60]}…")
        audio = cue.get("audio")
        if audio and Path(audio).is_file():
            duration = tts.probe_duration(audio)
        else:
            spec = {"engine": cue.get("engine") or vo_cfg.get("engine", "edge"),
                    "model": cue.get("model") or vo_cfg.get("model"),
                    "voice": cue.get("voice") or vo_cfg.get("voice"),
                    "speed": cue.get("speed") or vo_cfg.get("speed", 1.0),
                    "instructions": cue.get("instructions") or vo_cfg.get("instructions"),
                    "text": cue["text"]}
            try:
                meta = tts.synthesize_cached(spec, cache_dir)
            except tts.TTSError as e:
                raise RuntimeError(f"Voiceover cue {i + 1} failed: {e}") from e
            audio, duration = meta["path"], float(meta["duration_sec"])
            if not meta.get("cached"):
                chars += meta.get("chars", 0)
                cost += meta.get("cost_usd", 0.0)
        slot = slot_for(cue, cues[i + 1] if i + 1 < n else None)
        tempo, fitted, overrun = fit_cue(duration, slot, fit_mode, max_tempo)
        clips.append({"start": float(cue["start"]), "path": audio, "duration_sec": round(duration, 3),
                      "slot_sec": slot and round(slot, 3), "tempo": tempo, "fitted_sec": round(fitted, 3),
                      "overrun": overrun, "text": cue["text"]})
    overruns = [c for c in clips if c["overrun"]]
    emit_progress("ai", "voiceover", 1.0,
                  f"Voiceover: {n} cue{'s' if n != 1 else ''} ready" + (f", {len(overruns)} longer than their slot" if overruns else "") + ".")
    return {"voiceover_clips": clips,
            "voiceover_cost": {"cues": n, "chars": chars, "cost_usd": round(cost, 5),
                               "overruns": [{"start": c["start"], "over_sec": round(c["fitted_sec"] - c["slot_sec"], 2)}
                                            for c in overruns]}}


def load_cues(vo_cfg: dict[str, Any]) -> list[dict]:
    """Inline `cues` win over `cues_file`. Drops empty cues, sorts by start."""
    raw = vo_cfg.get("cues") or []
    if not raw and vo_cfg.get("cues_file"):
        with open(vo_cfg["cues_file"]) as f:
            raw = json.load(f)
    cues = []
    for c in raw:
        text = (c.get("text") or "").strip()
        if not text:
            continue
        cue = {**c, "text": text, "start": max(0.0, float(c.get("start") or 0.0))}
        if c.get("end") is not None:
            cue["end"] = float(c["end"])
        cues.append(cue)
    cues.sort(key=lambda c: c["start"])
    return cues


def slot_for(cue: dict, next_cue: dict | None) -> float | None:
    """How long the cue may play: its explicit end, else until the next cue starts, else unlimited."""
    if cue.get("end") is not None and cue["end"] > cue["start"]:
        return float(cue["end"]) - float(cue["start"])
    if next_cue is not None:
        gap = float(next_cue["start"]) - float(cue["start"])
        return gap if gap > 0 else None
    return None


def fit_cue(clip_sec: float, slot_sec: float | None, fit_mode: str = "tempo", max_tempo: float = 1.3) -> tuple[float, float, bool]:
    """(tempo, resulting duration, overrun) for a clip in a slot.

    tempo: speed factor for ffmpeg atempo (1.0 = unchanged). overrun: True when the clip
    still spills past the slot after fitting.
    """
    if slot_sec is None or slot_sec <= 0 or clip_sec <= slot_sec + 0.05:
        return 1.0, clip_sec, False
    if fit_mode != "tempo":
        return 1.0, clip_sec, True
    tempo = min(max_tempo, clip_sec / slot_sec)
    tempo = round(tempo, 3)
    fitted = clip_sec / tempo
    return tempo, fitted, fitted > slot_sec + 0.05
