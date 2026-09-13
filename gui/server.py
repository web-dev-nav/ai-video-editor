"""Local web GUI for ai-video-editor.

Wraps the existing CLI (``ai-video-editor process``) in a small Starlette app so
videos can be picked, configured and processed from a browser. Runs on
127.0.0.1 only. Start it with ``gui/run.sh``.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

import yaml
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse
from starlette.routing import Route

REPO = Path(__file__).resolve().parent.parent
GUI_DIR = Path(__file__).resolve().parent
VENV_BIN = REPO / ".venv" / ("Scripts" if os.name == "nt" else "bin")
CLI = VENV_BIN / ("ai-video-editor.exe" if os.name == "nt" else "ai-video-editor")
UPLOADS = REPO / "uploads"
JOBS_DIR = REPO / "uploads" / ".jobs"
CACHE_DIR = REPO / "uploads" / ".cache"
LUTS_DIR = REPO / "luts"
ENV_FILE = REPO / ".env"

VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".mts", ".wmv"}
WHISPER_MODELS = ["tiny", "base", "small", "medium", "large", "large-v2", "large-v3"]

# Overall-progress slice per pipeline step (start%, end%), in pipeline order.
# Whisper transcription and the final encode dominate wall-clock time.
STEP_RANGES = {
    ("combine", "concat"): (0, 12),
    ("setup", "probe"): (0, 2),
    ("analysis", "extract_audio"): (2, 4),
    ("analysis", "vad"): (4, 8),
    ("analysis", "whisper"): (8, 50),
    ("analysis", "cache"): (2, 50),
    ("analysis", "edit_decisions"): (50, 51),
    ("analysis", "director"): (51, 56),
    ("assembly", "assemble"): (56, 62),
    ("assembly", "enhance_audio"): (62, 66),
    ("assembly", "color_grade"): (66, 68),
    ("ai", "smart_hook"): (68, 74),
    ("ai", "chapters"): (74, 78),
    ("encode", "encode"): (78, 96),
    ("finish", "format"): (96, 99),
}


KEY_ENV = {"anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY", "openrouter": "OPENROUTER_API_KEY",
           "nvidia": "NVIDIA_API_KEY"}
DEFAULT_MODELS = {"anthropic": "claude-opus-5", "openai": "gpt-5", "openrouter": "anthropic/claude-sonnet-4",
                  "nvidia": "nvidia/nemotron-3-super-120b-a12b"}
NVIDIA_NIM_BASE_URL = "https://integrate.api.nvidia.com/v1"
# Models that do this job well (precise timestamps, good speech judgement); shown first with a ★.
RECOMMENDED = {
    "anthropic": {"claude-sonnet-5": "best value", "claude-opus-5": "best quality"},
    "openai": {"gpt-5": "good"},
    "openrouter": {"anthropic/claude-sonnet-5": "best value", "anthropic/claude-opus-5": "best quality", "openai/gpt-5": "good"},
    "nvidia": {"nvidia/nemotron-3-super-120b-a12b": "good, free tier", "deepseek-ai/deepseek-v4-pro-0813": "good, free tier"},
}


def _load_env_file() -> None:
    """Load KEY=VALUE lines from .env into os.environ (env wins)."""
    if not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env_file()


def _keys_present() -> dict[str, bool]:
    return {p: bool(os.environ.get(env)) for p, env in KEY_ENV.items()}


_MODEL_CACHE: dict[str, tuple[float, list[dict]]] = {}

# Fallback USD per 1M tokens (input, output) when OpenRouter has no entry.
STATIC_PRICING = {
    "claude-fable-5-1": (10, 50), "claude-fable-5": (10, 50), "claude-opus-5": (5, 25),
    "claude-opus-4-8": (5, 25), "claude-opus-4-7": (5, 25), "claude-opus-4-6": (5, 25),
    "claude-sonnet-5": (2, 10), "claude-sonnet-4-6": (3, 15), "claude-haiku-4-5": (1, 5),
}


def _pricing(provider: str, model: str) -> dict | None:
    """USD per 1M tokens for a model: live from OpenRouter's catalogue, else the static table."""
    if not model:
        return None
    or_id = model if provider in ("openrouter", "nvidia") else f"{provider}/{model}"
    try:
        for m in list_models("openrouter"):
            if m["id"] == or_id and m.get("pricing"):
                return {"in": m["pricing"][0], "out": m["pricing"][1], "source": "openrouter catalogue"}
    except Exception:  # noqa: BLE001
        pass
    base = model.split("/")[-1]
    for k, (i, o) in STATIC_PRICING.items():
        if base.startswith(k):
            return {"in": i, "out": o, "source": "built-in table"}
    return None


def cost_for(provider: str, usage: dict | None) -> dict | None:
    """Turn {input_tokens, output_tokens, model} into a cost record (or None)."""
    if not usage or usage.get("input_tokens") is None:
        return None
    model = usage.get("model") or ""
    rec = {"provider": provider, "model": model,
           "input_tokens": int(usage.get("input_tokens") or 0),
           "output_tokens": int(usage.get("output_tokens") or 0)}
    pr = _pricing(provider, model)
    if pr:
        rec["cost_in"] = round(rec["input_tokens"] / 1e6 * pr["in"], 5)
        rec["cost_out"] = round(rec["output_tokens"] / 1e6 * pr["out"], 5)
        rec["cost_total"] = round(rec["cost_in"] + rec["cost_out"], 5)
        rec["price_in_per_m"], rec["price_out_per_m"], rec["price_source"] = pr["in"], pr["out"], pr["source"]
    return rec


def list_models(provider: str, force: bool = False) -> list[dict]:
    """Fetch chat-capable model ids from the provider's API using the stored key."""
    now = time.time()
    if not force and provider in _MODEL_CACHE and now - _MODEL_CACHE[provider][0] < 600:
        return _MODEL_CACHE[provider][1]

    models: list[dict] = []
    if provider == "anthropic":
        import anthropic
        client = anthropic.Anthropic()
        for m in client.models.list():
            models.append({"id": m.id, "name": m.display_name or m.id, "created": m.created_at.timestamp() if m.created_at else 0})
        models.sort(key=lambda m: -m["created"])
    elif provider == "openai":
        import openai
        client = openai.OpenAI()
        skip = ("embedding", "tts", "whisper", "dall-e", "realtime", "audio", "image", "moderation",
                "transcribe", "search", "instruct", "davinci", "babbage", "computer-use", "sora", "codex-mini")
        for m in client.models.list():
            mid = m.id
            if (mid.startswith("gpt") or mid.startswith("o1") or mid.startswith("o3") or mid.startswith("o4")) \
                    and not any(k in mid for k in skip):
                models.append({"id": mid, "name": mid, "created": getattr(m, "created", 0) or 0})
        models.sort(key=lambda m: -m["created"])
    elif provider == "nvidia":
        import openai
        client = openai.OpenAI(base_url=NVIDIA_NIM_BASE_URL, api_key=os.environ.get("NVIDIA_API_KEY") or "public")
        skip = ("embed", "rerank", "vision", "vila", "clip", "guard", "safety", "asr", "tts", "parakeet", "riva",
                "stt", "ocr", "paddle", "yolo", "molmim", "diffusion", "sdxl", "cosmos", "fuyu", "omni", "kosmos",
                "neva", "deplot", "reward", "parse", "detector", "calibration", "code", "starcoder", "muse")
        for m in client.models.list():
            mid = m.id
            if not any(k in mid.lower() for k in skip):
                models.append({"id": mid, "name": mid, "created": getattr(m, "created", 0) or 0})
        rank = {"nvidia": 0, "deepseek-ai": 1, "moonshotai": 2, "mistralai": 3, "google": 4, "meta": 5, "openai": 6}
        models.sort(key=lambda m: (rank.get(m["id"].split("/")[0], 9), m["id"]))
    elif provider == "openrouter":
        import httpx
        r = httpx.get("https://openrouter.ai/api/v1/models", timeout=20)
        r.raise_for_status()
        for m in r.json().get("data", []):
            mid = m.get("id", "")
            pr = m.get("pricing") or {}
            try:
                pricing = (float(pr.get("prompt", 0)) * 1e6, float(pr.get("completion", 0)) * 1e6)
            except (TypeError, ValueError):
                pricing = None
            models.append({"id": mid, "name": m.get("name") or mid, "created": m.get("created", 0) or 0, "pricing": pricing})
        # Big list: lead with the major vendors, newest first within each
        rank = {"anthropic": 0, "openai": 1, "google": 2}
        models.sort(key=lambda m: (rank.get(m["id"].split("/")[0], 9), -m["created"]))
    else:
        raise ValueError("unknown provider")

    rec = RECOMMENDED.get(provider, {})
    for m in models:
        if m["id"] in rec:
            m["recommended"] = rec[m["id"]]
    models.sort(key=lambda m: 0 if m.get("recommended") else 1)  # stable: keeps existing order within groups
    _MODEL_CACHE[provider] = (now, models)
    return models


# ---------------------------------------------------------------------------
# Whisper model downloads (faster-whisper pulls from Hugging Face on first use)
# ---------------------------------------------------------------------------

HF_CACHE = Path(os.environ.get("HF_HUB_CACHE") or os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface") / "hub")
if os.environ.get("HF_HOME") and not os.environ.get("HF_HUB_CACHE"):
    HF_CACHE = Path(os.environ["HF_HOME"]) / "hub"
# Real on-disk sizes of the CTranslate2 int8/fp16 models (the upstream README lists OpenAI's sizes).
WHISPER_FALLBACK_BYTES = {"tiny": 75_500_000, "base": 145_000_000, "small": 484_000_000, "medium": 1_530_000_000,
                          "large": 3_090_000_000, "large-v2": 3_090_000_000, "large-v3": 3_090_000_000}
WHISPER_FILES = ("config.json", "preprocessor_config.json", "model.bin", "tokenizer.json", "vocabulary.txt", "vocabulary.json")
_WHISPER_SIZE_CACHE: dict[str, int] = {}
WHISPER_DOWNLOADS: dict[str, dict] = {}   # model -> {"state": downloading|done|error, "error": str}


def _whisper_dir(model: str) -> Path:
    return HF_CACHE / f"models--Systran--faster-whisper-{model}"


def whisper_downloaded(model: str) -> bool:
    snaps = _whisper_dir(model) / "snapshots"
    if not snaps.is_dir():
        return False
    for snap in snaps.iterdir():
        f = snap / "model.bin"
        try:
            if f.exists() and f.stat().st_size > 0:
                return True
        except OSError:
            continue
    return False


def whisper_local_bytes(model: str) -> int:
    blobs = _whisper_dir(model) / "blobs"
    if not blobs.is_dir():
        return 0
    total = 0
    for f in blobs.iterdir():
        try:
            total += f.stat().st_size
        except OSError:
            pass
    return total


def whisper_expected_bytes(model: str) -> int:
    if model in _WHISPER_SIZE_CACHE:
        return _WHISPER_SIZE_CACHE[model]
    size = WHISPER_FALLBACK_BYTES.get(model, 0)
    try:
        import httpx
        r = httpx.get(f"https://huggingface.co/api/models/Systran/faster-whisper-{model}/tree/main", timeout=8)
        if r.status_code == 200:
            live = sum(int(f.get("size", 0)) for f in r.json() if f.get("path") in WHISPER_FILES)
            if live > 0:
                size = live
    except Exception:  # noqa: BLE001
        pass
    _WHISPER_SIZE_CACHE[model] = size
    return size


def whisper_status(model: str) -> dict:
    dl = WHISPER_DOWNLOADS.get(model, {})
    done = whisper_downloaded(model) and dl.get("state") != "downloading"
    expected = whisper_expected_bytes(model)
    local = whisper_local_bytes(model)
    return {
        "model": model, "downloaded": done, "state": "done" if done else dl.get("state", "idle"),
        "bytes": local, "total": expected, "pct": (min(100, round(local / expected * 100)) if expected else 0),
        "error": dl.get("error"),
    }


def start_whisper_download(model: str) -> None:
    if WHISPER_DOWNLOADS.get(model, {}).get("state") == "downloading":
        return
    WHISPER_DOWNLOADS[model] = {"state": "downloading"}

    def _dl():
        try:
            from faster_whisper.utils import download_model
            download_model(model)
            WHISPER_DOWNLOADS[model] = {"state": "done"}
        except Exception as exc:  # noqa: BLE001
            WHISPER_DOWNLOADS[model] = {"state": "error", "error": str(exc)[:300]}

    threading.Thread(target=_dl, daemon=True).start()


def _fmt_mb(b: int) -> str:
    return f"{b / 1e9:.2f} GB" if b >= 1e9 else f"{b / 1e6:.0f} MB"


FORMATS = {
    "source": None,
    "vertical-crop": {"w": 1080, "h": 1920},
    "vertical-blur": {"w": 1080, "h": 1920},
    "square": {"w": 1080, "h": 1080},
}


def _video_dims(path: str) -> tuple[int, int]:
    info = _probe(path)
    v = next((st for st in info.get("streams", []) if st.get("codec_type") == "video"), {})
    return int(v.get("width", 0) or 0), int(v.get("height", 0) or 0)


def _convert_format(job: "Job", path: str, kind: str, focus: str = "center") -> None:
    """Re-frame the rendered video in place: vertical 9:16 (crop or blurred fit) or square."""
    spec = FORMATS.get(kind)
    if not spec:
        return
    w, h = _video_dims(path)
    if not w or not h:
        raise RuntimeError("cannot read output dimensions")
    tw, th = spec["w"], spec["h"]
    fx = {"left": "0", "center": "(iw-ow)/2", "right": "iw-ow"}.get(focus, "(iw-ow)/2")
    if kind == "vertical-blur":
        vf = (f"split[bg][fg];[bg]scale={tw}:{th}:force_original_aspect_ratio=increase,crop={tw}:{th},"
              f"boxblur=luma_radius=30:luma_power=2[bg];[fg]scale={tw}:{th}:force_original_aspect_ratio=decrease[fg];"
              f"[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p")
    else:
        # crop to the target aspect (keeping full height for landscape sources), then scale
        if w / h > tw / th:
            crop = f"crop=ih*{tw}/{th}:ih:{fx}:0"
        else:
            crop = f"crop=iw:iw*{th}/{tw}:0:(ih-oh)/2"
        vf = f"{crop},scale={tw}:{th},setsar=1,format=yuv420p"
    dur = float(_probe(path).get("format", {}).get("duration", 0) or 0)
    tmp = str(Path(path).with_name(Path(path).stem + ".__fmt__.mp4"))
    cmd = [shutil.which("ffmpeg") or "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1",
           "-i", path, "-filter_complex" if kind == "vertical-blur" else "-vf", vf,
           "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "copy", "-movflags", "+faststart", tmp]
    label = {"vertical-crop": "vertical 9:16", "vertical-blur": "vertical 9:16 (blurred background)", "square": "square 1:1"}[kind]
    job.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert job.proc.stdout
    for line in job.proc.stdout:
        if line.startswith("out_time_us=") and dur > 0:
            try:
                frac = min(1.0, int(line.split("=")[1]) / 1e6 / dur)
            except ValueError:
                continue
            job._event("finish", "format", frac, f"Converting to {label}… {int(frac * 100)}%")
    job.proc.wait()
    err = job.proc.stderr.read() if job.proc.stderr else ""
    if job.proc.returncode != 0:
        Path(tmp).unlink(missing_ok=True)
        raise RuntimeError(f"format conversion failed: {err.strip()[-300:]}")
    os.replace(tmp, path)
    job._event("finish", "format", 1.0, f"Converted to {label}.")


def _mmss(t: float) -> str:
    t = int(round(t))
    return f"{t // 60}:{t % 60:02d}"


def _transcript_text(cache_file: Path) -> str | None:
    try:
        data = json.loads(cache_file.read_text())
    except (OSError, ValueError):
        return None
    return "\n".join(f"[{_mmss(t['start'])}] {t.get('text', '').strip()}" for t in data.get("transcript", [])) + "\n"


def _bundle_output(job: "Job", p: dict, result: dict) -> None:
    """Move the rendered video into its own folder with transcript, plan and notes."""
    video = Path(result["output_video"])
    folder = video.with_suffix("")
    if folder.exists() and not folder.is_dir():
        folder = video.with_name(video.stem + "_bundle")
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / video.name
    if dest.exists():
        dest = folder / f"{video.stem}_{time.strftime('%H%M%S')}{video.suffix}"
    shutil.move(str(video), str(dest))
    result["output_video"] = str(dest)
    result["output_folder"] = str(folder)
    files = [dest.name]

    plan = result.get("director_plan") or p.get("carry_plan")
    if plan and not result.get("director_plan"):
        result["director_plan"] = plan  # reviewed plan rendered from the GUI
    inputs = p.get("inputs") or [p["input"]]
    opts = p.get("options", {})
    (folder / "edit_plan.json").write_text(json.dumps({
        "inputs": inputs, "output": str(dest), "mode": "ai" if plan else "auto",
        "skill": plan and plan.get("skill"), "model": plan and plan.get("model"), "instructions": plan and plan.get("instructions"),
        "keep_segments": p.get("keep_segments") or result.get("keep_segments"),
        "director_plan": plan, "cost": job.cost, "stats": {k: result.get(k) for k in (
            "duration_original_sec", "duration_edited_sec", "fillers_removed", "restarts_removed", "silence_removed_sec")},
        "output_format": opts.get("output_format"), "created": time.strftime("%Y-%m-%d %H:%M:%S"),
    }, indent=2, ensure_ascii=False))
    files.append("edit_plan.json")

    lines = [f"# Edit notes — {dest.name}", "",
             f"- Created: {time.strftime('%Y-%m-%d %H:%M')}",
             f"- Source: " + ", ".join(Path(x).name for x in inputs),
             f"- Duration: {_mmss(result.get('duration_original_sec', 0))} → {_mmss(result.get('duration_edited_sec', 0))}",
             f"- Output format: {(opts.get('output_format') or {}).get('kind', 'source')}"
             + (f" ({result['output_width']}×{result['output_height']})" if result.get("output_width") else ""), ""]
    if plan:
        lines += [f"## AI editor — {plan.get('skill_name') or 'Clean-up'} · {plan.get('model')}", "",
                  plan.get("summary", ""), ""]
        if plan.get("instructions"):
            lines += ["**Instructions:** " + plan["instructions"], ""]
        lines += ["### Cuts", ""]
        for r in plan.get("removed", []):
            lines.append(f"- {_mmss(r['start'])}–{_mmss(r['end'])} — {r.get('reason', '')}  \n  _{r.get('text', '')}_")
        lines += ["", "### Kept", ""]
        for k in plan.get("keep", []):
            lines.append(f"- {_mmss(k['start'])}–{_mmss(k['end'])}" + (f" — {k['note']}" if k.get("note") else "") + f"  \n  _{k.get('text', '')}_")
        if job.cost:
            c = job.cost
            lines += ["", f"### Cost", "", f"{c.get('model')}: {c.get('input_tokens', 0):,} tokens in, {c.get('output_tokens', 0):,} out"
                      + (f" — ${c.get('cost_total', 0):.4f}" if c.get("cost_total") is not None else "")]
    else:
        lines += ["## Auto edit (rule-based)", "",
                  f"- Filler words removed: {result.get('fillers_removed', 0)}",
                  f"- Failed takes removed: {result.get('restarts_removed', 0)}",
                  f"- Silence removed: {result.get('silence_removed_sec', 0)} s"]
    (folder / "edit_notes.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    files.append("edit_notes.md")

    src_cache = _cache_path_for(p["input"])
    if src_cache.exists():
        txt = _transcript_text(src_cache)
        if txt:
            (folder / "transcript_original.txt").write_text(txt, encoding="utf-8")
            files.append("transcript_original.txt")
    ch = result.get("chapters_file")
    if ch and Path(ch).exists():
        shutil.move(ch, str(folder / Path(ch).name))
        result["chapters_file"] = str(folder / Path(ch).name)
        files.append(Path(ch).name)
    result["bundle_files"] = files


def _derive_output_cache(input_path: str, output_path: str, keep: list[dict], cfg: dict) -> bool:
    """Write an analysis cache for the rendered output by remapping the input's cached
    transcript/VAD onto the output timeline (kept ranges concatenated in order).
    Lets the result be re-edited by the AI without running Whisper again."""
    src = _cache_path_for(input_path)
    if not src.exists() or not keep or not Path(output_path).exists():
        return False
    try:
        cache = json.loads(src.read_text())
    except (OSError, ValueError):
        return False
    words_all = [w for seg in cache["transcript"] for w in (seg.get("words") or [])]
    new_words: list[dict] = []
    new_speech: list[dict] = []
    offset = 0.0
    for k in keep:
        ks, ke = float(k["start"]), float(k["end"])
        for w in words_all:
            mid = (w["start"] + w["end"]) / 2
            if ks <= mid <= ke:
                new_words.append({**w, "start": round(offset + max(0.0, w["start"] - ks), 3),
                                  "end": round(offset + min(ke - ks, w["end"] - ks), 3), "_piece": len(new_speech)})
        for sp in cache["speech_segments"]:
            a, b = max(ks, sp["start"]), min(ke, sp["end"])
            if b - a > 0.05:
                new_speech.append({"start": round(offset + a - ks, 3), "end": round(offset + b - ks, 3)})
        offset += ke - ks
    # Rebuild sentence-ish segments: split at piece boundaries or gaps > 1 s, cap ~25 words.
    segs: list[dict] = []
    cur: list[dict] = []
    for w in new_words:
        if cur and (w["_piece"] != cur[-1]["_piece"] or w["start"] - cur[-1]["end"] > 1.0 or len(cur) >= 25):
            segs.append(cur); cur = []
        cur.append(w)
    if cur:
        segs.append(cur)
    transcript = [{"start": ws[0]["start"], "end": ws[-1]["end"],
                   "text": " ".join(w["word"].strip() for w in ws),
                   "words": [{k: v for k, v in w.items() if k != "_piece"} for w in ws]} for ws in segs]
    out = Path(output_path)
    st = out.stat()
    data = {"key": {"input": str(out.resolve()), "size": st.st_size, "mtime": int(st.st_mtime),
                    "whisper_model": cfg["whisper"].get("model"), "language": cfg["whisper"].get("language", "auto")},
            "speech_segments": new_speech, "transcript": transcript,
            "detected_language": cache.get("detected_language"), "derived_from": input_path}
    dest = _cache_path_for(output_path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(data))
    return True


def _cache_path_for(input_path: str) -> Path:
    return CACHE_DIR / (hashlib.sha1(str(Path(input_path).resolve()).encode()).hexdigest() + ".json")


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

def win_to_wsl(p: str) -> str:
    """Convert ``C:\\Users\\x`` style paths to ``/mnt/c/Users/x``. Leaves others as-is."""
    p = p.strip().strip('"')
    m = re.match(r"^([A-Za-z]):[\\/](.*)$", p)
    if m:
        return f"/mnt/{m.group(1).lower()}/" + m.group(2).replace("\\", "/")
    return p


def wsl_to_win(p: str) -> str | None:
    m = re.match(r"^/mnt/([a-z])/(.*)$", p)
    if m:
        return f"{m.group(1).upper()}:\\" + m.group(2).replace("/", "\\")
    return None


def quick_roots() -> list[dict]:
    """Shortcut folders: Windows user folders under WSL, else the current user's folders."""
    roots = []
    subs = ("Downloads", "Videos", "Desktop", "Documents", "Movies")
    win_users = Path("/mnt/c/Users")
    if win_users.exists():  # WSL — offer the Windows profile folders
        for base in sorted(win_users.glob("*")):
            if base.name in {"Public", "Default", "Default User", "All Users"} or not base.is_dir():
                continue
            for sub in subs:
                d = base / sub
                if d.is_dir():
                    roots.append({"label": f"{sub} (Windows)", "path": str(d)})
    for sub in subs:
        d = Path.home() / sub
        if d.is_dir() and not any(r["path"] == str(d) for r in roots):
            roots.append({"label": sub, "path": str(d)})
    roots.append({"label": "Uploads (drag & drop)", "path": str(UPLOADS)})
    roots.append({"label": "Home", "path": str(Path.home())})
    return roots


# ---------------------------------------------------------------------------
# Job runner (one CLI subprocess at a time, FIFO queue)
# ---------------------------------------------------------------------------

class Job:
    def __init__(self, params: dict):
        self.id = uuid.uuid4().hex[:10]
        self.params = params
        self.status = "queued"  # queued | running | done | error | cancelled
        self.events: list[dict] = []
        self.log: list[str] = []
        self.result: dict | None = None
        self.error: str | None = None
        self.overall = 0.0
        self.created = time.time()
        self.started: float | None = None
        self.finished: float | None = None
        self.proc: subprocess.Popen | None = None
        self.config_file: Path | None = None
        self.cost: dict | None = None
        self.error_kind: str | None = None
        self.lock = threading.RLock()  # re-entrant: _event() is called from code that may hold it

    def _event(self, phase: str, step: str, progress: float, message: str) -> None:
        """Record a GUI-generated progress event (same shape as the CLI's)."""
        with self.lock:
            ev = {"phase": phase, "step": step, "progress": round(progress, 3), "message": message,
                  "t": round(time.time() - (self.started or time.time()), 1)}
            self.events.append(ev)
            self.overall = _phase_progress(phase, step, progress, self.overall)
            self.log.append(json.dumps(ev))

    def to_dict(self, since: int = 0) -> dict:
        with self.lock:
            return {
                "id": self.id,
                "status": self.status,
                "mode": self.params.get("mode", "process"),
                "input": self.params["input"],
                "inputs": self.params.get("inputs") or [self.params["input"]],
                "output": self.params["output"],
                "cost": self.cost,
                "error_kind": self.error_kind,
                "overall": round(self.overall, 1),
                "events": self.events[since:],
                "event_count": len(self.events),
                "log": self.log[-400:],
                "result": self.result,
                "error": self.error,
                "created": self.created,
                "started": self.started,
                "finished": self.finished,
                "elapsed": round((self.finished or time.time()) - (self.started or time.time()), 1)
                if self.started else 0,
            }


JOBS: dict[str, Job] = {}
QUEUE: list[Job] = []
QUEUE_CV = threading.Condition()


def _build_config(p: dict) -> dict:
    """Translate GUI options into a full pipeline config dict (merged over defaults)."""
    with open(REPO / "config.default.yml") as f:
        cfg = yaml.safe_load(f)
    o = p["options"]

    cfg["whisper"]["model"] = o.get("whisper_model", "small")
    cfg["whisper"]["language"] = o.get("language") or "auto"

    s = o.get("silence", {})
    for k in ("min_silence_ms", "padding_ms", "min_gap_sec", "padding_sec"):
        if k in s:
            cfg["silence"][k] = s[k]

    r = o.get("restarts", {})
    cfg["restarts"]["enabled"] = bool(r.get("enabled", True))
    if r.get("trigger_phrases"):
        cfg["restarts"]["trigger_phrases"] = r["trigger_phrases"]
    cfg["restarts"]["detect_repeated_starts"] = bool(r.get("detect_repeated_starts", True))
    if "max_burst_duration_sec" in r:
        cfg["restarts"]["max_burst_duration_sec"] = r["max_burst_duration_sec"]

    fl = o.get("fillers", {})
    cfg["fillers"]["enabled"] = bool(fl.get("enabled", True))
    if "min_filler_duration_sec" in fl:
        cfg["fillers"]["min_filler_duration_sec"] = fl["min_filler_duration_sec"]
    if fl.get("words_en") is not None:
        cfg["fillers"]["words"]["en"] = fl["words_en"]
    if fl.get("words_ru") is not None:
        cfg["fillers"]["words"]["ru"] = fl["words_ru"]
    if fl.get("words_hi") is not None:
        cfg["fillers"]["words"]["hi"] = fl["words_hi"]

    a = o.get("audio", {})
    cfg["audio"]["enabled"] = bool(a.get("enabled", False))
    for k in ("denoise", "denoise_level", "highpass_freq", "deess_freq", "deess_gain",
              "compressor_threshold", "compressor_ratio", "limiter_limit", "loudness_target"):
        if k in a:
            cfg["audio"][k] = a[k]

    cfg["video"]["lut_path"] = o.get("lut") or None

    h = o.get("hook", {})
    cfg["hook"]["enabled"] = bool(h.get("enabled", False))
    if "duration_sec" in h:
        cfg["hook"]["duration_sec"] = h["duration_sec"]
    if h.get("model"):
        cfg["hook"]["model"] = h["model"]

    c = o.get("chapters", {})
    cfg["chapters"]["enabled"] = bool(c.get("enabled", False))
    if c.get("model"):
        cfg["chapters"]["model"] = c["model"]

    d = o.get("director", {})
    cfg.setdefault("director", {})
    cfg["director"]["enabled"] = bool(d.get("enabled", False))
    cfg["director"]["provider"] = d.get("provider") or "anthropic"
    cfg["director"]["model"] = d.get("model") or DEFAULT_MODELS.get(cfg["director"]["provider"], "")
    cfg["director"]["mode"] = d.get("mode") or "ai"
    cfg["director"]["instructions"] = d.get("instructions") or ""
    cfg["director"]["skill"] = d.get("skill") or "clean"

    e = o.get("encoding", {})
    cfg["encoding"]["codec"] = e.get("codec", "libx264")
    if "quality" in e:
        cfg["encoding"]["quality"] = int(e["quality"])
    if e.get("audio_bitrate"):
        cfg["encoding"]["audio_bitrate"] = str(e["audio_bitrate"])
    return cfg


def _combined_path(inputs: list[str]) -> Path:
    key = "|".join(f"{Path(p).resolve()}:{Path(p).stat().st_size}:{int(Path(p).stat().st_mtime)}" for p in inputs)
    return CACHE_DIR / "combined" / (hashlib.sha1(key.encode()).hexdigest()[:16] + ".mp4")


def _probe(path: str) -> dict:
    out = subprocess.run([shutil.which("ffprobe") or "ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", path],
                         capture_output=True, text=True).stdout
    return json.loads(out or "{}")


def _combine_clips(job: "Job", inputs: list[str], dest: Path) -> None:
    """Concatenate clips into one file, normalised to the first clip's size/fps, 48 kHz stereo AAC."""
    infos = [_probe(p) for p in inputs]
    total = 0.0
    for p, info in zip(inputs, infos):
        streams = info.get("streams", [])
        if not any(st.get("codec_type") == "video" for st in streams):
            raise RuntimeError(f"{Path(p).name}: no video stream")
        if not any(st.get("codec_type") == "audio" for st in streams):
            raise RuntimeError(f"{Path(p).name}: no audio track — every clip needs audio to be combined")
        total += float(info.get("format", {}).get("duration", 0) or 0)
    v0 = next(st for st in infos[0]["streams"] if st["codec_type"] == "video")
    w, h = int(v0["width"]), int(v0["height"])
    num, den = (v0.get("avg_frame_rate") or "30/1").split("/")
    fps = round(int(num) / max(1, int(den)), 3) or 30

    n = len(inputs)
    cmd = [shutil.which("ffmpeg") or "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1"]
    for p in inputs:
        cmd += ["-i", p]
    parts = []
    for i in range(n):
        parts.append(f"[{i}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,"
                     f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps},format=yuv420p[v{i}]")
        parts.append(f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo[a{i}]")
    parts.append("".join(f"[v{i}][a{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=1[v][a]")
    cmd += ["-filter_complex", ";".join(parts), "-map", "[v]", "-map", "[a]",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart", str(dest)]
    dest.parent.mkdir(parents=True, exist_ok=True)
    job.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert job.proc.stdout
    for line in job.proc.stdout:
        if line.startswith("out_time_us=") and total > 0:
            try:
                frac = min(1.0, int(line.split("=")[1]) / 1e6 / total)
            except ValueError:
                continue
            job._event("combine", "concat", frac, f"Combining {n} clips… {int(frac * 100)}%")
    job.proc.wait()
    err = job.proc.stderr.read() if job.proc.stderr else ""
    if job.proc.returncode != 0:
        raise RuntimeError(f"ffmpeg concat failed: {err.strip()[-400:]}")


def _phase_progress(phase: str, step: str, progress: float, current: float) -> float:
    rng = STEP_RANGES.get((phase, step))
    if rng is None:
        return current  # "start" markers and unknown steps don't move the bar
    lo, hi = rng
    val = lo + (hi - lo) * max(0.0, min(1.0, progress))
    return max(current, val)  # never move backwards


def _run_job(job: Job) -> None:
    job.status = "running"
    job.started = time.time()
    p = job.params

    inputs = p.get("inputs") or [p["input"]]
    multi = len(inputs) > 1
    if multi:
        dest = _combined_path(inputs)
        if dest.exists():
            job._event("combine", "concat", 1.0, f"Using cached combination of {len(inputs)} clips.")
        else:
            job._event("combine", "concat", 0.0, f"Combining {len(inputs)} clips…")
            try:
                _combine_clips(job, inputs, dest)
            except Exception as exc:  # noqa: BLE001
                with job.lock:
                    if job.status != "cancelled":
                        job.status = "error"
                        job.error = str(exc)
                    job.finished = time.time()
                return
            job._event("combine", "concat", 1.0, "Clips combined.")
        p["input"] = str(dest)
        job.proc = None

    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    job.config_file = JOBS_DIR / f"{job.id}.yml"
    with open(job.config_file, "w") as f:
        yaml.safe_dump(_build_config(p), f, allow_unicode=True, sort_keys=False)

    cmd = [str(CLI), "process", p["input"], "-c", str(job.config_file), "-o", p["output"],
           "--analysis-cache", str(_cache_path_for(p["input"]))]
    o = p["options"]
    mode = p.get("mode", "process")  # process | analyze | plan | render
    director = o.get("director", {})
    if mode in ("analyze", "plan"):
        cmd.append("--plan-only")
    if mode == "plan" or (mode == "process" and director.get("enabled")):
        cmd += ["-i", director.get("instructions") or ""]
    if mode == "render":
        keep_file = JOBS_DIR / f"{job.id}.keep.json"
        keep_file.write_text(json.dumps(p.get("keep_segments") or []))
        cmd += ["--keep-json", str(keep_file)]
    if mode in ("analyze", "plan") or not o.get("hook", {}).get("enabled"):
        cmd.append("--no-hook")
    if mode in ("analyze", "plan") or not o.get("chapters", {}).get("enabled"):
        cmd.append("--no-chapters")

    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"

    with job.lock:
        job.log.append("$ " + " ".join(cmd))

    try:
        job.proc = subprocess.Popen(
            cmd, cwd=str(REPO), env=env, text=True, bufsize=1,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
    except Exception as exc:  # noqa: BLE001
        job.status = "error"
        job.error = f"Failed to start CLI: {exc}"
        job.finished = time.time()
        return

    stdout_chunks: list[str] = []
    whisper_model = _build_config(p)["whisper"]["model"]
    dl_stop = threading.Event()

    def watch_download():
        """Emit download/load progress while faster-whisper fetches the model."""
        seen_bytes = -1
        while not dl_stop.wait(1.0):
            st = whisper_status(whisper_model)
            if st["downloaded"]:
                job._event("analysis", "whisper", 0.19,
                           f"Whisper {whisper_model} model downloaded — loading into memory (can take a minute)…")
                return
            if st["bytes"] != seen_bytes:
                seen_bytes = st["bytes"]
                job._event("analysis", "whisper", 0.19 * st["pct"] / 100,
                           f"Downloading Whisper {whisper_model} model (first use): {st['pct']}% · "
                           f"{_fmt_mb(st['bytes'])} / {_fmt_mb(st['total'])}")

    def read_stdout():
        assert job.proc and job.proc.stdout
        for line in job.proc.stdout:
            stdout_chunks.append(line)

    t = threading.Thread(target=read_stdout, daemon=True)
    t.start()

    assert job.proc.stderr
    for line in job.proc.stderr:
        line = line.rstrip("\n")
        if not line:
            continue
        with job.lock:
            if line.startswith("{"):
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    job.log.append(line)
                    continue
                ev["t"] = round(time.time() - job.started, 1)
                if ev.get("step") == "whisper":
                    if ev.get("progress", 0) == 0.0 and not whisper_downloaded(whisper_model) and not dl_stop.is_set():
                        threading.Thread(target=watch_download, daemon=True).start()
                    elif ev.get("progress", 0) > 0:
                        dl_stop.set()
                job.events.append(ev)
                val = _phase_progress(ev.get("phase", ""), ev.get("step", ""), float(ev.get("progress", 0)),
                                      0.0 if multi else job.overall)
                # With a combine phase in front, the pipeline occupies 12–100 %.
                job.overall = max(job.overall, 12 + val * 0.88) if multi else val
            else:
                job.log.append(line)

    job.proc.wait()
    dl_stop.set()
    t.join(timeout=5)

    out = "".join(stdout_chunks).strip()
    result = None
    if out:
        # stdout may contain several JSON documents; take the last object.
        try:
            result = json.loads(out)
        except json.JSONDecodeError:
            idx = out.rfind("\n{")
            if idx != -1:
                try:
                    result = json.loads(out[idx + 1:])
                except json.JSONDecodeError:
                    result = None

    if job.status == "cancelled":
        return
    ok = job.proc.returncode == 0 and result and result.get("status") in ("complete", "plan")
    if ok and result.get("status") == "complete":
        # Post-processing runs outside the lock: it emits progress events and can take a while.
        opts = p.get("options", {})
        fmt = (opts.get("output_format") or {})
        try:
            if fmt.get("kind") and fmt["kind"] != "source":
                _convert_format(job, result["output_video"], fmt["kind"], fmt.get("focus", "center"))
        except Exception as exc:  # noqa: BLE001
            job.log.append(f"[gui] format conversion failed: {exc}")
            result["format_error"] = str(exc)
        try:
            result["output_width"], result["output_height"] = _video_dims(result["output_video"])
        except Exception:  # noqa: BLE001
            pass
        plan = result.get("director_plan")
        job.cost = cost_for(plan.get("provider", ""), plan["usage"]) if plan and plan.get("usage") else (
            {**p["carry_cost"], "carried": True} if p.get("carry_cost") else None)
        if opts.get("bundle", True):
            try:
                _bundle_output(job, p, result)
            except Exception as exc:  # noqa: BLE001
                job.log.append(f"[gui] bundle failed: {exc}")
        # Make the output re-editable without re-transcribing (not when a hook was
        # prepended — that shifts the timeline in a way we don't track).
        if not result.get("hook_segment"):
            keep = p.get("keep_segments") or result.get("keep_segments") or []
            try:
                result["continue_ready"] = _derive_output_cache(p["input"], result["output_video"], keep, _build_config(p))
                if result["continue_ready"] and result.get("output_folder"):
                    txt = _transcript_text(_cache_path_for(result["output_video"]))
                    if txt:
                        Path(result["output_folder"], "transcript.txt").write_text(txt, encoding="utf-8")
                        result.setdefault("bundle_files", []).insert(1, "transcript.txt")
            except Exception as exc:  # noqa: BLE001
                job.log.append(f"[gui] could not derive output cache: {exc}")
                result["continue_ready"] = False

    with job.lock:
        if job.status == "cancelled":
            return
        if ok:
            job.status = "done"
            job.result = result
            job.overall = 100.0
            plan = result.get("plan") or result.get("director_plan")
            if plan and plan.get("usage"):
                job.cost = cost_for(plan.get("provider", ""), plan["usage"])
            elif job.cost is None and p.get("carry_cost"):
                job.cost = {**p["carry_cost"], "carried": True}
            chapters_file = result.get("chapters_file")
            if chapters_file and Path(chapters_file).exists():
                try:
                    job.result["chapters_text"] = Path(chapters_file).read_text()
                except OSError:
                    pass
        else:
            job.status = "error"
            if result and result.get("error"):
                job.error = result["error"].get("message") or str(result["error"])
            else:
                job.error = f"CLI exited with code {job.proc.returncode}"
            m = re.search(r"\[(quota|rate_limit|auth|model|refusal)\]", job.error or "")
            job.error_kind = m.group(1) if m else None
            job.result = result
    job.finished = time.time()


def _worker() -> None:
    while True:
        with QUEUE_CV:
            while not QUEUE:
                QUEUE_CV.wait()
            job = QUEUE.pop(0)
        if job.status == "cancelled":
            continue
        try:
            _run_job(job)
        except Exception as exc:  # noqa: BLE001
            job.status = "error"
            job.error = f"GUI runner error: {exc}"
            job.finished = time.time()


threading.Thread(target=_worker, daemon=True).start()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

async def index(request: Request):
    return HTMLResponse((GUI_DIR / "index.html").read_text())


async def api_bootstrap(request: Request):
    with open(REPO / "config.default.yml") as f:
        defaults = yaml.safe_load(f)
    # Defaults tuned for this machine: no Apple hardware encoder, lighter Whisper.
    defaults["encoding"]["codec"] = "libx264"
    defaults["whisper"]["model"] = "small"
    defaults["hook"]["enabled"] = False
    defaults["chapters"]["enabled"] = False

    luts = sorted(str(p) for p in LUTS_DIR.glob("*.cube")) if LUTS_DIR.exists() else []
    keys = _keys_present()
    return JSONResponse({
        "defaults": defaults,
        "luts": luts,
        "models": WHISPER_MODELS,
        "roots": quick_roots(),
        "api_key_present": keys["openrouter"],
        "keys": keys,
        "default_models": DEFAULT_MODELS,
        "repo": str(REPO),
        "ffmpeg": shutil.which("ffmpeg") is not None,
    })


async def api_save_key(request: Request):
    body = await request.json()
    provider = body.get("provider", "openrouter")
    env_name = KEY_ENV.get(provider)
    if not env_name:
        return JSONResponse({"error": "unknown provider"}, status_code=400)
    key = (body.get("api_key") or "").strip()
    lines = []
    if ENV_FILE.exists():
        lines = [l for l in ENV_FILE.read_text().splitlines() if not l.startswith(env_name + "=")]
    if key:
        lines.append(f"{env_name}={key}")
    ENV_FILE.write_text("\n".join(lines) + ("\n" if lines else ""))
    if key:
        os.environ[env_name] = key
    else:
        os.environ.pop(env_name, None)
    keys = _keys_present()
    return JSONResponse({"ok": True, "keys": keys, "api_key_present": keys["openrouter"]})


async def api_skills(request: Request):
    import sys
    if str(REPO) not in sys.path:
        sys.path.insert(0, str(REPO))
    from src.skills import load_skills
    return JSONResponse({"skills": [{k: v for k, v in sk.items() if k != "body"} | {"body": sk["body"]} for sk in load_skills()],
                         "dir": str(REPO / "skills")})


async def api_whisper_models(request: Request):
    return JSONResponse({"models": [whisper_status(m) for m in WHISPER_MODELS], "cache_dir": str(HF_CACHE)})


async def api_whisper_download(request: Request):
    model = request.query_params.get("model", "")
    if model not in WHISPER_MODELS:
        return JSONResponse({"error": "unknown model"}, status_code=400)
    if not whisper_downloaded(model):
        start_whisper_download(model)
    return JSONResponse(whisper_status(model))


async def api_whisper_status(request: Request):
    model = request.query_params.get("model", "")
    if model not in WHISPER_MODELS:
        return JSONResponse({"error": "unknown model"}, status_code=400)
    return JSONResponse(whisper_status(model))


async def api_models(request: Request):
    provider = request.query_params.get("provider", "anthropic")
    force = request.query_params.get("refresh") == "1"
    if provider not in KEY_ENV:
        return JSONResponse({"error": "unknown provider"}, status_code=400)
    if provider not in ("openrouter", "nvidia") and not os.environ.get(KEY_ENV[provider]):
        return JSONResponse({"error": f"No {provider} API key set", "models": []}, status_code=200)
    try:
        return JSONResponse({"models": list_models(provider, force)})
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": str(exc)[:300], "models": []}, status_code=200)


async def api_browse(request: Request):
    raw = request.query_params.get("path") or str(UPLOADS)
    path = Path(win_to_wsl(raw))
    if path.is_file():
        path = path.parent
    if not path.is_dir():
        return JSONResponse({"error": f"Not a directory: {path}"}, status_code=400)
    dirs, files = [], []
    try:
        for entry in sorted(path.iterdir(), key=lambda e: e.name.lower()):
            name = entry.name
            if name.startswith(".") or name.startswith("NTUSER") or name.startswith("ntuser"):
                continue
            try:
                if entry.is_dir():
                    dirs.append({"name": name, "path": str(entry)})
                elif entry.suffix.lower() in VIDEO_EXTS:
                    st = entry.stat()
                    files.append({
                        "name": name, "path": str(entry),
                        "size_mb": round(st.st_size / 1048576, 1), "mtime": st.st_mtime,
                    })
            except OSError:
                continue
    except PermissionError:
        return JSONResponse({"error": f"Permission denied: {path}"}, status_code=403)
    files.sort(key=lambda f: -f["mtime"])
    return JSONResponse({
        "path": str(path),
        "win_path": wsl_to_win(str(path)),
        "parent": str(path.parent) if path.parent != path else None,
        "dirs": dirs, "files": files,
    })


async def api_info(request: Request):
    path = win_to_wsl(request.query_params.get("path", ""))
    if not Path(path).is_file():
        return JSONResponse({"error": "File not found"}, status_code=404)
    proc = subprocess.run([str(CLI), "info", path], cwd=str(REPO), capture_output=True, text=True)
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return JSONResponse({"error": proc.stderr.strip() or "ffprobe failed"}, status_code=500)
    data["win_path"] = wsl_to_win(path)
    return JSONResponse(data)


async def api_upload(request: Request):
    name = Path(request.query_params.get("name", "upload.mp4")).name
    if Path(name).suffix.lower() not in VIDEO_EXTS:
        return JSONResponse({"error": "Not a supported video type"}, status_code=400)
    UPLOADS.mkdir(parents=True, exist_ok=True)
    dest = UPLOADS / name
    stem, suffix, n = dest.stem, dest.suffix, 1
    while dest.exists():
        dest = UPLOADS / f"{stem}_{n}{suffix}"
        n += 1
    with open(dest, "wb") as f:
        async for chunk in request.stream():
            f.write(chunk)
    return JSONResponse({"path": str(dest), "name": dest.name})


async def api_media(request: Request):
    path = win_to_wsl(request.query_params.get("path", ""))
    if not Path(path).is_file():
        return PlainTextResponse("not found", status_code=404)
    return FileResponse(path)


async def api_jobs_create(request: Request):
    body = await request.json()
    inputs = [win_to_wsl(x) for x in (body.get("inputs") or [body.get("input", "")]) if x]
    if not inputs:
        return JSONResponse({"error": "No input video"}, status_code=400)
    for x in inputs:
        if not Path(x).is_file():
            return JSONResponse({"error": f"Input not found: {x}"}, status_code=400)
    first = inputs[0]
    pipeline_input = str(_combined_path(inputs)) if len(inputs) > 1 else first
    out = body.get("output") or ""
    suffix = "_combined_edited.mp4" if len(inputs) > 1 else "_edited.mp4"
    out = win_to_wsl(out) if out else str(Path(first).with_name(Path(first).stem + suffix))
    if any(Path(out).resolve() == Path(x).resolve() for x in inputs):
        return JSONResponse({"error": "Output path must differ from the inputs"}, status_code=400)
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    options = body.get("options") or {}
    mode = body.get("mode", "process")
    keep_segments = None
    if mode == "render":
        if not Path(pipeline_input).is_file():
            return JSONResponse({"error": "Combined clip not found — ask for a plan first."}, status_code=400)
        try:
            keep_segments = _finalize_keep(pipeline_input, options, body.get("selected_ranges") or [])
        except Exception as exc:  # noqa: BLE001
            return JSONResponse({"error": f"Could not finalize plan: {exc}"}, status_code=400)
        if not keep_segments:
            return JSONResponse({"error": "Nothing selected to keep."}, status_code=400)
    job = Job({"input": first, "inputs": inputs, "output": out, "options": options, "mode": mode,
               "keep_segments": keep_segments, "carry_cost": body.get("carry_cost"), "carry_plan": body.get("carry_plan")})
    JOBS[job.id] = job
    with QUEUE_CV:
        QUEUE.append(job)
        QUEUE_CV.notify()
    return JSONResponse(job.to_dict())


def _finalize_keep(inp: str, options: dict, selected: list[dict]) -> list[dict]:
    """Turn the user's reviewed AI ranges into final keep segments.

    Re-runs the rule-based edit decisions from the cached analysis and clips the
    selected ranges to them (refine mode), exactly as the director step would.
    """
    import sys
    if str(REPO) not in sys.path:
        sys.path.insert(0, str(REPO))
    from src.steps.edit_decisions import run as edit_decisions
    from src.steps.ai_director import _all_words, _sanitise, base_segments, finalize
    from src.utils.ffmpeg import probe_duration

    cache_file = _cache_path_for(inp)
    if not cache_file.exists():
        raise RuntimeError("analysis cache missing — run Analyze or Ask AI first")
    cache = json.loads(cache_file.read_text())
    cfg = _build_config({"options": options})
    total = float(probe_duration(Path(inp)))
    ctx = {"transcript": cache["transcript"], "speech_segments": cache["speech_segments"], "total_duration": total}
    ctx.update(edit_decisions(ctx, cfg))
    mode = cfg["director"].get("mode", "ai")
    pad = float(cfg["director"].get("boundary_padding_sec", 0.15))
    return finalize(_sanitise(selected, total), base_segments(ctx, cfg, mode), _all_words(ctx["transcript"]), mode, pad, total)


async def api_jobs_list(request: Request):
    jobs = sorted(JOBS.values(), key=lambda j: -j.created)
    totals = {"input_tokens": 0, "output_tokens": 0, "cost_total": 0.0, "calls": 0}
    for j in jobs:
        c = j.cost
        if c and not c.get("carried"):
            totals["calls"] += 1
            totals["input_tokens"] += c.get("input_tokens", 0)
            totals["output_tokens"] += c.get("output_tokens", 0)
            totals["cost_total"] += c.get("cost_total", 0.0) or 0.0
    totals["cost_total"] = round(totals["cost_total"], 4)
    return JSONResponse({"jobs": [{k: v for k, v in j.to_dict().items() if k not in ("events", "log")} for j in jobs],
                         "totals": totals})


async def api_job_get(request: Request):
    job = JOBS.get(request.path_params["id"])
    if not job:
        return JSONResponse({"error": "no such job"}, status_code=404)
    since = int(request.query_params.get("since", "0"))
    return JSONResponse(job.to_dict(since))


async def api_job_cancel(request: Request):
    job = JOBS.get(request.path_params["id"])
    if not job:
        return JSONResponse({"error": "no such job"}, status_code=404)
    with job.lock:
        job.status = "cancelled"
        job.finished = time.time()
    if job.proc and job.proc.poll() is None:
        job.proc.terminate()
    with QUEUE_CV:
        if job in QUEUE:
            QUEUE.remove(job)
    return JSONResponse({"ok": True})


async def api_job_config(request: Request):
    job = JOBS.get(request.path_params["id"])
    if not job or not job.config_file or not job.config_file.exists():
        return PlainTextResponse("", status_code=404)
    return PlainTextResponse(job.config_file.read_text())


routes = [
    Route("/", index),
    Route("/api/bootstrap", api_bootstrap),
    Route("/api/key", api_save_key, methods=["POST"]),
    Route("/api/models", api_models),
    Route("/api/skills", api_skills),
    Route("/api/whisper/models", api_whisper_models),
    Route("/api/whisper/download", api_whisper_download, methods=["POST"]),
    Route("/api/whisper/status", api_whisper_status),
    Route("/api/browse", api_browse),
    Route("/api/info", api_info),
    Route("/api/upload", api_upload, methods=["PUT"]),
    Route("/api/media", api_media),
    Route("/api/jobs", api_jobs_create, methods=["POST"]),
    Route("/api/jobs", api_jobs_list),
    Route("/api/jobs/{id}", api_job_get),
    Route("/api/jobs/{id}/cancel", api_job_cancel, methods=["POST"]),
    Route("/api/jobs/{id}/config", api_job_config),
]

app = Starlette(routes=routes)


def main() -> None:
    import uvicorn

    port = int(os.environ.get("AVE_GUI_PORT", "8765"))
    url = f"http://localhost:{port}"
    print(f"AI Video Editor GUI → {url}", flush=True)
    if "--no-browser" not in sys.argv:
        _open_browser(url)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


def _open_browser(url: str) -> None:
    """Open the default browser: Windows (native or from WSL), macOS, or Linux desktop."""
    if os.name == "nt":
        try:
            os.startfile(url)  # type: ignore[attr-defined]
            return
        except OSError:
            pass
    is_wsl = "microsoft" in Path("/proc/version").read_text().lower() if Path("/proc/version").exists() else False
    cmds = []
    if is_wsl:
        cmds += [["powershell.exe", "-NoProfile", "-Command", f"Start-Process '{url}'"], ["explorer.exe", url]]
    cmds += [["open", url], ["xdg-open", url]]
    for cmd in cmds:
        if shutil.which(cmd[0]):
            try:
                subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return
            except OSError:
                continue


if __name__ == "__main__":
    main()
