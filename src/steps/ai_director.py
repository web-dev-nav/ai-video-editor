"""AI Director — an LLM edits the talk itself: fillers, stutters, repeats, rambling.

Runs after edit_decisions. The model sees the word-timestamped transcript (with
pauses marked) plus optional user instructions and returns word-precise keep
ranges in playback order, with a reason for every cut.

Modes (config["director"]["mode"]):
  - "ai"     (default) The model judges every word in context — no filler word
             lists, no trigger phrases. Its ranges are clipped to the voice-
             activity segments so dead air is still trimmed by the audio pass.
  - "refine" Legacy: the model picks *content* on top of the rule-based cut
             (word lists + triggers still apply).
  - "full"   The model's ranges are used exactly as returned.
"""

from __future__ import annotations

import copy
import json
import re
from typing import Any

from ..utils.json_output import emit_progress
from ..utils.llm import LLMError, complete

SYSTEM_PROMPT = """You are a professional video editor and the user's editing assistant for a
talking-head video. You receive the transcript with a timestamp for every word
(seconds) and pauses of 0.5s or longer marked like ⏸1.8s. You may also receive
instructions from the user. Produce a clean, tight edit yourself.

What to remove (judge each case in context — there is no word list):
1. Filler words and sounds in any language: um, uh, er, hmm, like, you know, I mean,
   basically, so (when it's a verbal tic), मतलब, यानी, ну, типа, etc. Keep the same
   words when they carry meaning ("I like this").
2. Stutters, false starts and restarts ("the thing— the thing is"), and duplicate or
   near-duplicate sentences. When the speaker repeats a take, keep the best one —
   usually the last complete, fluent version — and drop the others.
3. Spoken director notes ("cut cut", "let me start again"), coughs, long rambling
   that adds nothing, off-topic tangents.
4. Hesitation pauses: dead air is trimmed automatically, but when a ⏸ pause sits
   inside a sentence you keep, split your range at it if it feels like a stall;
   keep short natural breaths.
5. Anything the user's instructions ask for (target length, drop a topic, reorder,
   open with the strongest line…). Instructions win over the defaults above.

How to cut:
- Word precision: a range starts at the start time of its first kept word and ends
  at the end time of its last kept word. Copy timestamps exactly; never invent them.
- Never cut mid-word. Prefer whole phrases so the speech still flows naturally.
- Don't over-cut: if the talk is already clean, keep it. Never remove content that
  changes the meaning unless instructed.
- Keep chronological order unless instructed to reorder.

Output ONLY a JSON object, no prose, no markdown fences:
{"summary": "...", "keep": [{"start": 0.0, "end": 0.0, "note": "..."}],
 "removed": [{"start": 0.0, "end": 0.0, "reason": "..."}]}
- "keep": ranges in playback order. "note" is optional (why this piece matters).
- "removed": every cut with a short reason starting with a category:
  "filler", "repeat", "false start", "stall", "rambling", "instruction", "other".
- "summary": speak to the user as their assistant, 2-4 sentences in English:
  what you removed (with counts), what you kept, anything they may want to check.
- The transcript may be in any language (including Hindi/Hinglish in Devanagari or
  Latin script); judge it in that language, write notes in English."""

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
    mode = cfg.get("mode", "ai")
    pad = float(cfg.get("boundary_padding_sec", 0.15))
    total = float(context.get("total_duration", 0.0))
    rule_keep: list[dict] = base_segments(context, config, mode) or []

    emit_progress("analysis", "director", 0.1, f"AI Director: asking {provider}/{model or 'default'}...")
    prompt = _build_prompt(transcript, rule_keep, total, instructions or "(none — do a standard clean-up)", mode)

    try:
        text, usage = complete(prompt, SYSTEM_PROMPT, provider, model)
    except LLMError as e:
        raise RuntimeError(f"AI Director failed: {e}") from e

    plan = _parse_plan(text)
    ai_keep = _sanitise(plan.get("keep", []), total)
    if not ai_keep:
        raise RuntimeError("AI Director returned no keep ranges. Try clearer instructions or a different model.")

    emit_progress("analysis", "director", 0.7, f"AI Director: {len(ai_keep)} kept ranges, applying ({mode} mode)...")

    words = _all_words(transcript)
    final = finalize(ai_keep, rule_keep, words, mode, pad, total)
    if not final:
        raise RuntimeError("AI Director plan removed everything after combining with the automatic cut.")
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

PAUSE_MARK_SEC = 0.5


def _build_prompt(transcript: list[dict], rule_keep: list[dict], total: float, instructions: str, mode: str = "ai") -> str:
    words = _all_words(transcript)
    with_words = len(words) <= MAX_WORDS_WITH_TIMESTAMPS
    lines = []
    prev_end: float | None = None
    for i, seg in enumerate(transcript, 1):
        lines.append(f"#{i} [{seg['start']:.2f}–{seg['end']:.2f}] {seg.get('text', '').strip()}")
        if with_words and seg.get("words"):
            toks = []
            for w in seg["words"]:
                if prev_end is not None and w["start"] - prev_end >= PAUSE_MARK_SEC:
                    toks.append(f"⏸{w['start'] - prev_end:.1f}s")
                toks.append(f"{w['word'].strip()}@{w['start']:.2f}-{w['end']:.2f}")
                prev_end = w["end"]
            lines.append("   " + " ".join(toks))
    kept_sec = sum(s["end"] - s["start"] for s in rule_keep)
    if mode == "refine":
        kept_desc = ", ".join(f"{s['start']:.2f}–{s['end']:.2f}" for s in rule_keep) or "(none)"
        auto = f"AUTOMATIC PASS ALREADY KEEPS ({kept_sec:.1f}s, silences/fillers removed): {kept_desc}"
    else:
        auto = (f"SPEECH DETECTED: {kept_sec:.1f}s of {total:.1f}s. Dead air outside speech is trimmed "
                f"automatically; you decide about every word.")
    return (
        f"VIDEO DURATION: {total:.2f}s\n{auto}\n\n"
        f"USER'S INSTRUCTIONS:\n{instructions}\n\n"
        f"TRANSCRIPT (segment [start–end] text; then word@start-end, ⏸ = pause):\n" + "\n".join(lines)
    )


def base_segments(context: dict[str, Any], config: dict[str, Any], mode: str) -> list[dict] | None:
    """Segments the model's ranges are clipped to.

    "ai": voice-activity segments only (silence trimmed, no word lists, no padding —
          padding is applied per word later). "refine": the rule-based keep list.
          "full": nothing (None).
    """
    if mode == "full":
        return None
    if mode == "refine":
        return list(context.get("keep_segments") or [])
    from .edit_decisions import run as edit_decisions

    cfg = copy.deepcopy(config)
    cfg["fillers"]["enabled"] = False
    cfg["restarts"]["enabled"] = False
    cfg["silence"]["padding_sec"] = 0.0
    ctx = {
        "speech_segments": context.get("speech_segments", []),
        "transcript": context.get("transcript", []),
        "total_duration": context.get("total_duration", float("inf")),
    }
    return edit_decisions(ctx, cfg)["keep_segments"]


def finalize(ai_keep: list[dict], base: list[dict] | None, words: list[dict], mode: str, pad: float, total: float) -> list[dict]:
    """Turn the model's word-level ranges into final keep segments."""
    padded = _pad_to_neighbours(ai_keep, words, pad, total)
    if mode == "full" or not base:
        final = padded
    else:
        final = _intersect(padded, base, 0.0, total)
    return _merge_touching(final)


def _pad_to_neighbours(ranges: list[dict], words: list[dict], pad: float, total: float) -> list[dict]:
    """Extend each range by `pad` for safety, but never into a neighbouring word
    that was cut — otherwise a removed 'um' would leak back in on both sides."""
    ws = sorted(words, key=lambda w: w["start"])
    out = []
    for r in ranges:
        lo = max(0.0, r["start"] - pad)
        hi = min(total, r["end"] + pad)
        for w in ws:
            mid = (w["start"] + w["end"]) / 2
            if mid < r["start"]:          # word before the range → clamp start
                lo = max(lo, w["end"])
            elif mid > r["end"]:          # first word after the range → clamp end, stop
                hi = min(hi, w["start"])
                break
        if hi - lo >= 0.1:
            out.append({"start": round(lo, 3), "end": round(hi, 3)})
    return out


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
