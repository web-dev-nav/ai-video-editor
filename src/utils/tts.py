"""Text-to-speech for the voiceover step.

Three engines, selected by name:
  - "openai" — OpenAI TTS (gpt-4o-mini-tts supports delivery `instructions`), key from OPENAI_API_KEY
  - "edge"   — Microsoft Edge neural voices via the ``edge-tts`` package (free, needs internet, no key)
  - "kokoro" — Kokoro-82M running locally on CPU (free, offline; ``pip install -e ".[tts-local]"``)

Every engine writes an MP3 so the mixer can treat clips uniformly. Clips are cached by a
hash of everything that influences the audio (engine, model, voice, text, speed, instructions).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from .ffmpeg import ffmpeg_bin, probe_duration
from .llm import classify_http

ENGINES = ("openai", "edge", "kokoro")

OPENAI_MODELS = ["gpt-4o-mini-tts", "tts-1-hd", "tts-1"]
OPENAI_VOICES = [
    ("alloy", "Alloy — neutral, balanced"), ("ash", "Ash — warm male"), ("ballad", "Ballad — soft, expressive"),
    ("coral", "Coral — bright female"), ("echo", "Echo — deep male"), ("fable", "Fable — storyteller"),
    ("onyx", "Onyx — authoritative male"), ("nova", "Nova — friendly female"), ("sage", "Sage — calm"),
    ("shimmer", "Shimmer — clear female"), ("verse", "Verse — versatile"),
]
# USD per 1k characters (OpenAI pricing page, 2026).
OPENAI_TTS_PRICE_PER_1K = {"gpt-4o-mini-tts": 0.015, "tts-1": 0.015, "tts-1-hd": 0.030}
OPENAI_CHAR_LIMIT = 4096

KOKORO_VOICES = [
    ("af_heart", "Heart — American female (best)"), ("af_bella", "Bella — American female"),
    ("af_nicole", "Nicole — American female, soft"), ("af_sarah", "Sarah — American female"),
    ("af_sky", "Sky — American female"), ("am_adam", "Adam — American male"),
    ("am_michael", "Michael — American male"), ("am_fenrir", "Fenrir — American male, deep"),
    ("bf_emma", "Emma — British female"), ("bf_isabella", "Isabella — British female"),
    ("bm_george", "George — British male"), ("bm_lewis", "Lewis — British male"),
    ("hf_alpha", "Alpha — Hindi female"), ("hm_omega", "Omega — Hindi male"),
]
KOKORO_LANG_BY_PREFIX = {"a": "a", "b": "b", "h": "h", "e": "e", "f": "f", "i": "i", "j": "j", "p": "p", "z": "z"}

# Shown if the live edge-tts voice list cannot be fetched.
EDGE_FALLBACK_VOICES = [
    ("en-US-AriaNeural", "Aria — en-US female"), ("en-US-JennyNeural", "Jenny — en-US female"),
    ("en-US-AvaMultilingualNeural", "Ava — en-US female, multilingual"), ("en-US-GuyNeural", "Guy — en-US male"),
    ("en-US-AndrewMultilingualNeural", "Andrew — en-US male, multilingual"), ("en-US-BrianMultilingualNeural", "Brian — en-US male"),
    ("en-GB-SoniaNeural", "Sonia — en-GB female"), ("en-GB-RyanNeural", "Ryan — en-GB male"),
    ("en-IN-NeerjaNeural", "Neerja — en-IN female"), ("en-IN-PrabhatNeural", "Prabhat — en-IN male"),
    ("hi-IN-SwaraNeural", "Swara — hi-IN female"), ("hi-IN-MadhurNeural", "Madhur — hi-IN male"),
    ("ru-RU-SvetlanaNeural", "Svetlana — ru-RU female"), ("ru-RU-DmitryNeural", "Dmitry — ru-RU male"),
]

DEFAULT_INSTRUCTIONS = ("Warm, natural, conversational delivery like a friendly YouTuber. "
                        "Natural pacing with short pauses at commas and sentence ends. Not a newsreader.")

DEFAULT_VOICE = {"openai": "nova", "edge": "en-US-AriaNeural", "kokoro": "af_heart"}


class TTSError(RuntimeError):
    """TTS failure. `kind`: auth | quota | rate_limit | engine_missing | network | other."""

    def __init__(self, message: str, kind: str = "other") -> None:
        self.kind = kind
        super().__init__(f"[{kind}] {message}")


# ---------------------------------------------------------------------------
# Engine availability & voices
# ---------------------------------------------------------------------------

def _importable(name: str) -> bool:
    import importlib.util
    return importlib.util.find_spec(name) is not None


def engine_status() -> dict[str, dict]:
    """Which engines can run right now, and why not otherwise."""
    return {
        "openai": {"available": bool(os.environ.get("OPENAI_API_KEY")), "free": False,
                   "note": "needs OPENAI_API_KEY" if not os.environ.get("OPENAI_API_KEY") else "≈ $0.015 per 1k characters"},
        "edge": {"available": _importable("edge_tts"), "free": True,
                 "note": "free · online (Microsoft voices)" if _importable("edge_tts") else "pip install edge-tts"},
        "kokoro": {"available": _importable("kokoro") and _importable("soundfile"), "free": True,
                   "note": "free · offline · CPU" if _importable("kokoro") else 'pip install -e ".[tts-local]" (≈330 MB model on first use)'},
    }


_EDGE_VOICES_CACHE: tuple[float, list[dict]] | None = None


def list_voices(engine: str) -> list[dict]:
    """[{id, name, lang, gender}] for an engine. Edge voices come from the live catalogue (cached 1 h)."""
    global _EDGE_VOICES_CACHE
    if engine == "openai":
        return [{"id": v, "name": n, "lang": "multi", "gender": ""} for v, n in OPENAI_VOICES]
    if engine == "kokoro":
        return [{"id": v, "name": n, "lang": {"a": "en-US", "b": "en-GB", "h": "hi"}.get(v[0], v[0]),
                 "gender": "female" if v[1] == "f" else "male"} for v, n in KOKORO_VOICES]
    if engine == "edge":
        if _EDGE_VOICES_CACHE and time.time() - _EDGE_VOICES_CACHE[0] < 3600:
            return _EDGE_VOICES_CACHE[1]
        voices: list[dict] = []
        try:
            import edge_tts
            raw = asyncio.run(edge_tts.list_voices())
            for v in raw:
                short = v.get("ShortName", "")
                if not short:
                    continue
                friendly = re.sub(r"^Microsoft |Online \(Natural\) - .*$", "", v.get("FriendlyName", "")).strip() or short
                voices.append({"id": short, "name": f"{friendly} — {v.get('Locale', '')} {v.get('Gender', '').lower()}",
                               "lang": v.get("Locale", ""), "gender": v.get("Gender", "").lower(),
                               "tags": (v.get("VoiceTag") or {}).get("VoicePersonalities", [])})
            # English + Hindi + Russian first (the languages the editor targets), then everything else.
            rank = {"en-US": 0, "en-GB": 1, "en-IN": 2, "en-AU": 3, "hi-IN": 4, "ru-RU": 5}
            voices.sort(key=lambda v: (rank.get(v["lang"], 6 if v["lang"].startswith("en") else 9), v["lang"], v["id"]))
        except Exception:  # noqa: BLE001 — offline or catalogue changed: fall back to a static list
            voices = [{"id": v, "name": n, "lang": v[:5], "gender": ""} for v, n in EDGE_FALLBACK_VOICES]
        _EDGE_VOICES_CACHE = (time.time(), voices)
        return voices
    raise TTSError(f"unknown engine '{engine}'")


# ---------------------------------------------------------------------------
# Synthesis
# ---------------------------------------------------------------------------

def normalise_spec(spec: dict[str, Any]) -> dict[str, Any]:
    """Only the fields that change the audio, with defaults filled in."""
    engine = (spec.get("engine") or "edge").lower()
    model = (spec.get("model") or "gpt-4o-mini-tts") if engine == "openai" else None
    instructions = (spec.get("instructions") or "").strip() if engine == "openai" and (model or "").startswith("gpt-4o") else ""
    return {
        "engine": engine,
        "model": model,
        "voice": spec.get("voice") or DEFAULT_VOICE.get(engine, ""),
        "text": (spec.get("text") or "").strip(),
        "speed": round(float(spec.get("speed") or 1.0), 3),
        "instructions": instructions,
    }


def cache_key(spec: dict[str, Any]) -> str:
    return hashlib.sha1(json.dumps(normalise_spec(spec), sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def estimate_cost_usd(engine: str, model: str | None, chars: int) -> float:
    if engine != "openai":
        return 0.0
    return round(chars / 1000 * OPENAI_TTS_PRICE_PER_1K.get(model or "gpt-4o-mini-tts", 0.015), 5)


def synthesize_cached(spec: dict[str, Any], cache_dir: str | Path) -> dict[str, Any]:
    """Synthesize (or reuse) a clip. Returns {path, duration_sec, chars, cost_usd, cached, hash, spec}."""
    spec = normalise_spec(spec)
    if not spec["text"]:
        raise TTSError("empty text")
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    key = cache_key(spec)
    mp3 = cache_dir / f"{key}.mp3"
    meta_file = cache_dir / f"{key}.json"
    if mp3.exists() and mp3.stat().st_size > 0:
        try:
            meta = json.loads(meta_file.read_text())
        except (OSError, ValueError):
            meta = {"duration_sec": probe_duration(mp3), "chars": len(spec["text"]), "cost_usd": 0.0}
        return {**meta, "path": str(mp3), "cached": True, "hash": key, "spec": spec}
    synthesize(spec["engine"], spec["voice"], spec["text"], mp3, model=spec["model"], speed=spec["speed"],
               instructions=spec["instructions"])
    meta = {"duration_sec": round(probe_duration(mp3), 3), "chars": len(spec["text"]),
            "cost_usd": estimate_cost_usd(spec["engine"], spec["model"], len(spec["text"])), "spec": spec,
            "created": time.strftime("%Y-%m-%d %H:%M:%S")}
    meta_file.write_text(json.dumps(meta, ensure_ascii=False))
    return {**meta, "path": str(mp3), "cached": False, "hash": key}


def synthesize(engine: str, voice: str, text: str, out_path: str | Path, *, model: str | None = None,
               speed: float = 1.0, instructions: str | None = None) -> dict[str, Any]:
    """Write an MP3 for `text` with the chosen engine. Returns {path, duration_sec, chars}."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_suffix(".part.mp3")
    try:
        if engine == "openai":
            _openai(text, voice, tmp, model or "gpt-4o-mini-tts", speed, instructions)
        elif engine == "edge":
            _edge(text, voice, tmp, speed)
        elif engine == "kokoro":
            _kokoro(text, voice, tmp, speed)
        else:
            raise TTSError(f"unknown engine '{engine}'")
        os.replace(tmp, out_path)
    finally:
        tmp.unlink(missing_ok=True)
    return {"path": str(out_path), "duration_sec": round(probe_duration(out_path), 3), "chars": len(text)}


def _chunk_text(text: str, limit: int = 3800) -> list[str]:
    """Split long text at sentence boundaries so every chunk is under `limit` characters."""
    text = text.strip()
    if len(text) <= limit:
        return [text]
    sentences = re.split(r"(?<=[.!?…।])\s+", text)
    chunks: list[str] = []
    cur = ""
    for s in sentences:
        while len(s) > limit:  # a single monster sentence: hard-split on whitespace
            cut = s.rfind(" ", 0, limit)
            cut = cut if cut > 0 else limit
            if cur:
                chunks.append(cur); cur = ""
            chunks.append(s[:cut].strip())
            s = s[cut:].strip()
        if cur and len(cur) + 1 + len(s) > limit:
            chunks.append(cur); cur = s
        else:
            cur = f"{cur} {s}".strip() if cur else s
    if cur:
        chunks.append(cur)
    return chunks


def _concat_mp3(parts: list[Path], out: Path) -> None:
    lst = out.with_suffix(".txt")
    lst.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts))
    try:
        subprocess.run([ffmpeg_bin(), "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
                        "-i", str(lst), "-c", "copy", str(out)], check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as e:
        raise TTSError(f"ffmpeg concat failed: {e.stderr[-300:]}") from e
    finally:
        lst.unlink(missing_ok=True)


def _openai(text: str, voice: str, out: Path, model: str, speed: float, instructions: str | None) -> None:
    if not os.environ.get("OPENAI_API_KEY"):
        raise TTSError("OPENAI_API_KEY is not set — add it under API keys or pick a free engine.", "auth")
    import openai

    client = openai.OpenAI()
    chunks = _chunk_text(text, OPENAI_CHAR_LIMIT - 300)
    parts: list[Path] = []
    try:
        for i, chunk in enumerate(chunks):
            part = out.with_name(f"{out.stem}.{i}.mp3") if len(chunks) > 1 else out
            kwargs: dict[str, Any] = {"model": model, "voice": voice, "input": chunk, "response_format": "mp3"}
            if abs(speed - 1.0) > 0.01:
                kwargs["speed"] = max(0.25, min(4.0, speed))
            if model.startswith("gpt-4o") and instructions:
                kwargs["instructions"] = instructions
            try:
                with client.audio.speech.with_streaming_response.create(**kwargs) as resp:
                    resp.stream_to_file(part)
            except openai.AuthenticationError as e:
                raise TTSError(f"OpenAI: invalid API key ({e})", "auth") from e
            except openai.PermissionDeniedError as e:
                raise TTSError(f"OpenAI: key lacks permission ({e})", "auth") from e
            except openai.NotFoundError as e:
                raise TTSError(f"OpenAI: unknown model/voice ({e})", "model") from e
            except openai.RateLimitError as e:
                raise TTSError(f"OpenAI: {e}", classify_http(429, str(e))) from e
            except openai.APIStatusError as e:
                raise TTSError(f"OpenAI API error {e.status_code}: {e}", classify_http(e.status_code, str(e))) from e
            except openai.APIConnectionError as e:
                raise TTSError(f"OpenAI: connection error ({e})", "network") from e
            parts.append(part)
        if len(parts) > 1:
            _concat_mp3(parts, out)
    finally:
        for p in parts:
            if p != out:
                p.unlink(missing_ok=True)


def _edge(text: str, voice: str, out: Path, speed: float) -> None:
    try:
        import edge_tts
    except ImportError as e:
        raise TTSError("edge-tts is not installed (pip install edge-tts)", "engine_missing") from e
    rate = f"{int(round((speed - 1.0) * 100)):+d}%"

    async def _go() -> None:
        comm = edge_tts.Communicate(text, voice, rate=rate)
        await comm.save(str(out))

    try:
        asyncio.run(_go())
    except Exception as e:  # noqa: BLE001 — network / token / voice errors all surface here
        msg = str(e)
        kind = "network" if any(k in msg.lower() for k in ("connect", "timeout", "403", "401", "handshake", "websocket", "ssl")) else "other"
        raise TTSError(f"edge-tts failed: {msg[:300]}", kind) from e
    if not out.exists() or out.stat().st_size == 0:
        raise TTSError("edge-tts produced no audio (voice id wrong, or text empty?)", "other")


_KOKORO_PIPELINES: dict[str, Any] = {}


def _kokoro(text: str, voice: str, out: Path, speed: float) -> None:
    try:
        from kokoro import KPipeline
        import soundfile as sf
        import numpy as np
    except ImportError as e:
        raise TTSError('Kokoro is not installed — run: uv pip install -e ".[tts-local]" (and apt install espeak-ng)',
                       "engine_missing") from e
    lang = KOKORO_LANG_BY_PREFIX.get(voice[:1], "a")
    pipe = _KOKORO_PIPELINES.get(lang)
    if pipe is None:
        try:
            pipe = KPipeline(lang_code=lang, repo_id="hexgrad/Kokoro-82M")
        except Exception as e:  # noqa: BLE001
            raise TTSError(f"Kokoro could not load its model: {str(e)[:300]}", "network") from e
        _KOKORO_PIPELINES[lang] = pipe
    chunks = []
    try:
        for _, _, audio in pipe(text, voice=voice, speed=speed):
            if audio is not None:
                chunks.append(np.asarray(audio, dtype="float32"))
    except Exception as e:  # noqa: BLE001
        raise TTSError(f"Kokoro synthesis failed: {str(e)[:300]}") from e
    if not chunks:
        raise TTSError("Kokoro produced no audio")
    wav = out.with_suffix(".wav")
    sf.write(str(wav), np.concatenate(chunks), 24000)
    try:
        subprocess.run([ffmpeg_bin(), "-y", "-hide_banner", "-loglevel", "error", "-i", str(wav),
                        "-c:a", "libmp3lame", "-q:a", "2", str(out)], check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as e:
        raise TTSError(f"ffmpeg mp3 encode failed: {e.stderr[-300:]}") from e
    finally:
        wav.unlink(missing_ok=True)
