"""AI Director — an LLM decides *what content* to keep, based on your instructions.

Runs after edit_decisions. The model sees the word-timestamped transcript plus the
user's instructions ("cut to 60s, drop the tangent about X, keep the best intro")
and returns keep ranges in playback order. In "refine" mode those ranges are
intersected with the rule-based keep_segments so silences/fillers stay removed;
in "full" mode the model's ranges are used as-is.
"""

from __future__ import annotations

import json
import re
from typing import Any

from ..utils.json_output import emit_progress
from ..utils.llm import LLMError, complete

SYSTEM_PROMPT = """You are a senior video editor cutting a talking-head video.
You receive the full transcript with timestamps (seconds), the speech segments the
automatic pass already kept, and the editor's instructions. Decide which parts of
the talk to KEEP so the result follows the instructions.

Rules:
- Output ONLY a JSON object, no prose, no markdown fences.
- "keep" is a list of {"start": float, "end": float, "note": str} in the ORDER they
  should play. Keep chronological order unless the instructions call for moving
  something (e.g. "put the best moment first").
- Cut on word boundaries: start = the start time of the first word you keep,
  end = the end time of the last word you keep. Never cut mid-word or mid-sentence
  unless asked. Prefer whole sentences.
- Do not invent timestamps; copy them from the transcript.
- "removed" lists what you cut, with a short reason each, so the editor can review.
- If a target duration is given, make the kept total land at or just under it.
- If the instructions ask for nothing specific, tighten the piece: remove repetition,
  tangents, rambling and weak takes while keeping the message intact.
- The transcript may be in any language, including Hindi/Hinglish (Devanagari or
  Latin script); judge content in that language but write "summary", "note" and
  "reason" in English.
- "summary": 2-4 sentences on what you did and why.

JSON shape:
{"summary": "...", "keep": [{"start": 0.0, "end": 0.0, "note": "..."}],
 "removed": [{"start": 0.0, "end": 0.0, "reason": "..."}]}"""

MAX_WORDS_WITH_TIMESTAMPS = 8000  # beyond this, send sentence-level timing only


def run(context: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    cfg = config.get("director", {}) or {}
    instructions = (cfg.get("instructions") or "").strip()
    if not cfg.get("enabled") and not instructions:
        emit_progress("analysis", "director", 1.0, "AI Director disabled — skipping.")
        return {}

    transcript: list[dict] = context.get("transcript") or []
    if not transcript:
        emit_progress("analysis", "director", 1.0, "AI Director: no transcript — skipping.")
        return {}

    provider = cfg.get("provider", "anthropic")
    model = cfg.get("model") or None
    mode = cfg.get("mode", "refine")
    pad = float(cfg.get("boundary_padding_sec", 0.15))
    total = float(context.get("total_duration", 0.0))
    rule_keep: list[dict] = context.get("keep_segments") or []

    emit_progress("analysis", "director", 0.1, f"AI Director: asking {provider}/{model or 'default'}...")
    prompt = _build_prompt(transcript, rule_keep, total, instructions or "(no specific instructions)")

    try:
        text, usage = complete(prompt, SYSTEM_PROMPT, provider, model)
    except LLMError as e:
        raise RuntimeError(f"AI Director failed: {e}") from e

    plan = _parse_plan(text)
    ai_keep = _sanitise(plan.get("keep", []), total)
    if not ai_keep:
        raise RuntimeError("AI Director returned no keep ranges. Try clearer instructions or a different model.")

    emit_progress("analysis", "director", 0.7, f"AI Director: {len(ai_keep)} kept ranges, applying ({mode} mode)...")

    if mode == "full" or not rule_keep:
        final = [{"start": max(0.0, s["start"] - pad), "end": min(total, s["end"] + pad)} for s in ai_keep]
    else:
        final = _intersect(ai_keep, rule_keep, pad, total)
    final = _merge_touching(final)
    if not final:
        raise RuntimeError("AI Director plan removed everything after combining with the automatic cut.")

    words = _all_words(transcript)
    kept_sec = sum(s["end"] - s["start"] for s in final)
    rule_sec = sum(s["end"] - s["start"] for s in rule_keep) if rule_keep else total
    removed = _sanitise(plan.get("removed", []), total)
    plan_out = {
        "summary": plan.get("summary", ""),
        "provider": provider,
        "model": usage.get("model") or model,
        "mode": mode,
        "instructions": instructions,
        "usage": usage,
        "keep": [
            {**s, "note": s.get("note", ""), "text": _text_in(words, s["start"], s["end"])}
            for s in ai_keep
        ],
        "removed": [
            {**s, "reason": s.get("reason", ""), "text": _text_in(words, s["start"], s["end"])}
            for s in removed
        ],
        "final_keep_segments": final,
        "duration_before_sec": round(rule_sec, 2),
        "duration_after_sec": round(kept_sec, 2),
        "reordered": any(final[i]["start"] > final[i + 1]["start"] for i in range(len(final) - 1)),
    }

    stats = dict(context.get("edit_stats") or {})
    stats["director_removed_sec"] = round(max(0.0, rule_sec - kept_sec), 2)
    emit_progress(
        "analysis", "director", 1.0,
        f"AI Director: {rule_sec:.1f}s → {kept_sec:.1f}s ({len(final)} segments)",
    )
    return {"keep_segments": final, "director_plan": plan_out, "edit_stats": stats}


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------

def _build_prompt(transcript: list[dict], rule_keep: list[dict], total: float, instructions: str) -> str:
    words = _all_words(transcript)
    with_words = len(words) <= MAX_WORDS_WITH_TIMESTAMPS
    lines = []
    for i, seg in enumerate(transcript, 1):
        lines.append(f"#{i} [{seg['start']:.2f}–{seg['end']:.2f}] {seg.get('text', '').strip()}")
        if with_words and seg.get("words"):
            lines.append("   " + " ".join(
                f"{w['word'].strip()}@{w['start']:.2f}-{w['end']:.2f}" for w in seg["words"]
            ))
    kept_desc = ", ".join(f"{s['start']:.2f}–{s['end']:.2f}" for s in rule_keep) or "(none)"
    kept_sec = sum(s["end"] - s["start"] for s in rule_keep)
    return (
        f"VIDEO DURATION: {total:.2f}s\n"
        f"AUTOMATIC PASS ALREADY KEEPS ({kept_sec:.1f}s, silences/fillers removed): {kept_desc}\n\n"
        f"EDITOR'S INSTRUCTIONS:\n{instructions}\n\n"
        f"TRANSCRIPT (segment [start–end] text; then word@start-end):\n" + "\n".join(lines)
    )


def _all_words(transcript: list[dict]) -> list[dict]:
    out: list[dict] = []
    for seg in transcript:
        out.extend(seg.get("words") or [])
    return out


def _text_in(words: list[dict], start: float, end: float) -> str:
    mid = [w["word"].strip() for w in words if (w["start"] + w["end"]) / 2 >= start and (w["start"] + w["end"]) / 2 <= end]
    text = " ".join(mid)
    return text if len(text) <= 240 else text[:120] + " … " + text[-110:]


# ---------------------------------------------------------------------------
# Response handling
# ---------------------------------------------------------------------------

def _parse_plan(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.S)
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, flags=re.S)
        if not m:
            raise RuntimeError(f"AI Director returned non-JSON output: {text[:300]}")
        data = json.loads(m.group(0))
    if not isinstance(data, dict):
        raise RuntimeError("AI Director returned JSON that is not an object.")
    return data


def _sanitise(ranges: list, total: float) -> list[dict]:
    out = []
    for r in ranges or []:
        try:
            s, e = float(r["start"]), float(r["end"])
        except (KeyError, TypeError, ValueError):
            continue
        s, e = max(0.0, s), min(total or e, e)
        if e - s < 0.1:
            continue
        item = {"start": round(s, 3), "end": round(e, 3)}
        for k in ("note", "reason"):
            if r.get(k):
                item[k] = str(r[k])
        out.append(item)
    return out


def _intersect(ai_keep: list[dict], rule_keep: list[dict], pad: float, total: float) -> list[dict]:
    """Clip each AI range to the rule-based keep list, preserving AI ordering."""
    rules = sorted(rule_keep, key=lambda s: s["start"])
    out = []
    for a in ai_keep:
        a_s, a_e = max(0.0, a["start"] - pad), min(total, a["end"] + pad)
        for r in rules:
            s, e = max(a_s, r["start"]), min(a_e, r["end"])
            if e - s >= 0.2:
                out.append({"start": round(s, 3), "end": round(e, 3)})
    return out


def _merge_touching(segs: list[dict], gap: float = 0.05) -> list[dict]:
    """Merge consecutive segments that overlap or nearly touch (padding can make
    neighbouring word-boundary cuts overlap, which would repeat frames)."""
    out: list[dict] = []
    for s in segs:
        prev = out[-1] if out else None
        if prev and prev["start"] <= s["start"] <= prev["end"] + gap:
            prev["end"] = max(prev["end"], s["end"])
        else:
            out.append(dict(s))
    return out
