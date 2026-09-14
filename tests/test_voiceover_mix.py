"""Unit tests for the voiceover / mixer helpers (no ffmpeg or network needed)."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

from src.config import load_config
from src.steps.mix_audio import atempo_chain, build_filter_complex, build_mix_command, duck_ratio
from src.steps.voiceover import fit_cue, load_cues, slot_for
from src.utils import tts
from src.utils.llm import DEFAULT_MODELS, resolve_llm

REPO = Path(__file__).resolve().parent.parent


# ---------------------------------------------------------------------------
# cue fitting
# ---------------------------------------------------------------------------

def test_fit_cue_fits_without_change():
    assert fit_cue(3.0, 4.0) == (1.0, 3.0, False)
    assert fit_cue(3.0, None) == (1.0, 3.0, False)


def test_fit_cue_speeds_up_within_limit():
    tempo, fitted, overrun = fit_cue(5.2, 4.6, "tempo", 1.3)
    assert tempo == pytest.approx(1.13, abs=0.01)
    assert fitted == pytest.approx(4.6, abs=0.05)
    assert overrun is False


def test_fit_cue_caps_at_max_tempo_and_reports_overrun():
    tempo, fitted, overrun = fit_cue(8.0, 4.0, "tempo", 1.3)
    assert tempo == 1.3 and overrun is True and fitted == pytest.approx(8 / 1.3)


def test_fit_cue_overrun_mode_never_speeds_up():
    assert fit_cue(8.0, 4.0, "overrun", 1.3) == (1.0, 8.0, True)


def test_slot_for_prefers_explicit_end_then_next_cue():
    assert slot_for({"start": 2.0, "end": 6.0}, {"start": 5.0}) == 4.0
    assert slot_for({"start": 2.0}, {"start": 5.0}) == 3.0
    assert slot_for({"start": 2.0}, None) is None


def test_load_cues_drops_empty_and_sorts(tmp_path):
    f = tmp_path / "cues.json"
    f.write_text(json.dumps([{"start": 5, "text": "b"}, {"start": 1, "text": "a"}, {"start": 2, "text": "  "}]))
    cues = load_cues({"cues_file": str(f)})
    assert [c["text"] for c in cues] == ["a", "b"]
    assert load_cues({"cues": [{"start": 0, "text": "inline"}], "cues_file": str(f)})[0]["text"] == "inline"


# ---------------------------------------------------------------------------
# ffmpeg filter graph
# ---------------------------------------------------------------------------

def test_atempo_chain():
    assert atempo_chain(1.3) == "atempo=1.3"
    assert atempo_chain(3.0) == "atempo=2,atempo=1.5"
    assert atempo_chain(0.25) == "atempo=0.5,atempo=0.5"


def test_duck_ratio_bounds():
    assert 1.5 <= duck_ratio(-1) <= duck_ratio(-12) <= duck_ratio(-60) <= 20


CLIP = {"start": 4.2, "path": "/x/c1.mp3", "tempo": 1.0, "fitted_sec": 5.1, "duration_sec": 5.1}


def test_filter_vo_only_narrate():
    fc = build_filter_complex(30.0, [CLIP], {"mix_mode": "narrate", "duck_original_db": -12}, {}, {}, 0.0, None)
    assert "adelay=4200:all=1" in fc
    assert "sidechaincompress" in fc          # original ducks under the VO
    assert "[m0]" not in fc and "afade" not in fc
    assert fc.endswith("amix=inputs=2:duration=first:normalize=0,alimiter=limit=-1dB:level=false[mix]")


def test_filter_vo_replace_mutes_original_under_cue():
    fc = build_filter_complex(30.0, [CLIP], {"mix_mode": "replace"}, {}, {}, 0.0, None)
    assert "volume=0:enable='between(t,4.200,9.300)'" in fc
    assert "sidechaincompress" not in fc


def test_filter_music_only_with_offset_and_fades():
    music = {"enabled": True, "path": "/x/m.mp3", "gain_db": -18, "fade_in_sec": 2, "fade_out_sec": 3, "start_offset_sec": 10, "loop": True, "duck": True, "duck_db": -12}
    fc = build_filter_complex(30.0, [], {}, music, {}, 0.0, 1)
    assert "atrim=start=10.000:end=40.000" in fc
    assert fc.count("afade=") == 2 and "afade=t=out:st=27.000:d=3" in fc
    assert "[m0][orig_k]sidechaincompress" in fc     # ducked by the original speech
    assert "amix=inputs=2:duration=first" in fc


def test_filter_all_three_with_hook_offset_and_tempo():
    music = {"enabled": True, "path": "/x/m.mp3", "gain_db": -18, "loop": False, "duck": True, "duck_db": -12}
    clip = {**CLIP, "tempo": 1.2}
    fc = build_filter_complex(30.0, [clip], {"mix_mode": "narrate", "duck_original_db": -12}, music, {"loudnorm": True, "loudness_target": -14}, 7.5, 2)
    assert "adelay=11700:all=1" in fc            # 4.2 s + 7.5 s hook offset
    assert "atempo=1.2" in fc
    assert "[orig_k][vo_k2]amix=inputs=2" in fc  # music key = speech + VO
    assert "amix=inputs=3:duration=first:normalize=0,loudnorm=I=-14" in fc


def test_build_mix_command_inputs_and_loop():
    music = {"enabled": True, "path": "/x/m.mp3", "loop": True}
    cmd = build_mix_command("/x/v.mp4", 30.0, [CLIP], {}, music, {}, "/x/out.mp4")
    assert cmd[cmd.index("-i") + 1] == "/x/v.mp4"
    assert "-stream_loop" in cmd and cmd[cmd.index("-stream_loop") + 2:cmd.index("-stream_loop") + 4] == ["-i", "/x/m.mp3"]
    assert "-shortest" not in cmd and cmd[-1] == "/x/out.mp4" and "copy" in cmd


# ---------------------------------------------------------------------------
# TTS helpers
# ---------------------------------------------------------------------------

def test_cache_key_stable_and_sensitive():
    a = {"engine": "edge", "voice": "en-US-AriaNeural", "text": "Hello", "speed": 1.0}
    assert tts.cache_key(a) == tts.cache_key({**a, "instructions": "ignored for edge"})
    assert tts.cache_key(a) != tts.cache_key({**a, "text": "Hello!"})
    assert tts.cache_key(a) != tts.cache_key({**a, "speed": 1.1})
    o = {"engine": "openai", "model": "gpt-4o-mini-tts", "voice": "nova", "text": "Hello"}
    assert tts.cache_key(o) != tts.cache_key({**o, "instructions": "whisper it"})
    assert tts.cache_key({**o, "model": "tts-1"}) == tts.cache_key({**o, "model": "tts-1", "instructions": "x"})  # tts-1 ignores instructions


def test_chunk_text_splits_on_sentences():
    text = "One sentence here. " * 300
    chunks = tts._chunk_text(text, 1000)
    assert all(len(c) <= 1000 for c in chunks) and all(c.endswith(".") for c in chunks)
    assert " ".join(chunks).split() == text.split()
    assert tts._chunk_text("short", 100) == ["short"]


def test_estimate_cost():
    assert tts.estimate_cost_usd("edge", None, 10_000) == 0
    assert tts.estimate_cost_usd("openai", "gpt-4o-mini-tts", 1000) == pytest.approx(0.015)
    assert tts.estimate_cost_usd("openai", "tts-1-hd", 1000) == pytest.approx(0.030)


# ---------------------------------------------------------------------------
# LLM resolution + config
# ---------------------------------------------------------------------------

def test_resolve_llm_falls_back_to_director():
    assert resolve_llm({"provider": None, "model": None}, {"provider": "openai", "model": "gpt-5"}) == ("openai", "gpt-5")
    assert resolve_llm({"provider": "anthropic"}, {"provider": "openai", "model": "gpt-5"}) == ("anthropic", DEFAULT_MODELS["anthropic"])
    assert resolve_llm({"provider": "openai", "model": "gpt-4.1"}, {}) == ("openai", "gpt-4.1")
    assert resolve_llm(None, None) == ("anthropic", DEFAULT_MODELS["anthropic"])


def test_config_defaults_have_new_sections():
    cfg = load_config()
    assert cfg["voiceover"]["enabled"] is False and cfg["voiceover"]["engine"] in tts.ENGINES
    assert cfg["music"]["enabled"] is False and cfg["mix"]["original_gain_db"] == 0
    assert cfg["hook"]["provider"] is None and cfg["chapters"]["model"] is None


def test_config_rejects_bad_voiceover(tmp_path):
    f = tmp_path / "c.yml"
    f.write_text("voiceover:\n  enabled: true\n  engine: bogus\n")
    with pytest.raises(ValueError, match="voiceover.engine"):
        load_config(f)
    f.write_text("music:\n  enabled: true\n  path: /nope/none.mp3\n")
    with pytest.raises(ValueError, match="music.path"):
        load_config(f)


# ---------------------------------------------------------------------------
# GUI server helpers (imported by path so the module's globals stay intact)
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def gui():
    spec = importlib.util.spec_from_file_location("gui_server", REPO / "gui" / "server.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_remap_transcript_is_contiguous(gui):
    cache = {"transcript": [{"start": 0, "end": 4, "text": "a b c d", "words": [{"word": w, "start": i, "end": i + 0.9} for i, w in enumerate("a b c d".split())]},
                            {"start": 10, "end": 12, "text": "e f", "words": [{"word": "e", "start": 10, "end": 10.9}, {"word": "f", "start": 11, "end": 11.9}]}],
             "speech_segments": [{"start": 0, "end": 4}, {"start": 10, "end": 12}]}
    transcript, speech = gui._remap_transcript(cache, [{"start": 0, "end": 2}, {"start": 10, "end": 12}])
    words = [w for t in transcript for w in t["words"]]
    assert [w["word"] for w in words] == ["a", "b", "e", "f"]
    assert words[2]["start"] == pytest.approx(2.0) and words[2]["src"] == 10   # e starts right after the first piece
    assert speech == [{"start": 0.0, "end": 2.0}, {"start": 2.0, "end": 4.0}]


def test_build_config_maps_new_sections(gui):
    cfg = gui._build_config({"mode": "render", "options": {
        "voiceover": {"engine": "edge", "voice": "en-US-GuyNeural", "mix_mode": "replace", "cues": [{"start": 1, "text": "hi"}, {"start": 2, "text": "  "}]},
        "music": {"enabled": True, "path": "C:\\Music\\a.mp3", "gain_db": -10},
        "mix": {"original_gain_db": -3, "loudnorm": True},
        "hook": {"enabled": True, "provider": "openai", "model": ""}, "chapters": {"enabled": False}}})
    assert cfg["voiceover"]["enabled"] is True and cfg["voiceover"]["cues"] == [{"start": 1, "text": "hi"}]
    assert cfg["voiceover"]["mix_mode"] == "replace" and cfg["voiceover"]["cache_dir"].endswith("tts")
    assert cfg["music"]["path"] == "/mnt/c/Music/a.mp3" and cfg["music"]["gain_db"] == -10
    assert cfg["mix"]["original_gain_db"] == -3 and cfg["mix"]["loudnorm"] is True
    assert cfg["hook"]["provider"] == "openai" and cfg["hook"]["model"] is None
    # the GUI's voiceover switch wins over the presence of cues
    off = gui._build_config({"mode": "render", "options": {"voiceover": {"enabled": False, "cues": [{"start": 1, "text": "hi"}]}}})
    assert off["voiceover"]["enabled"] is False
    # analyze jobs never call the director; plan jobs do
    assert gui._build_config({"mode": "analyze", "options": {"director": {"enabled": True}}})["director"]["enabled"] is False
    assert gui._build_config({"mode": "plan", "options": {"director": {"enabled": True}}})["director"]["enabled"] is True


def test_fold_extra_costs_does_not_recount_carried_plan(gui):
    carried = {"provider": "anthropic", "model": "claude-sonnet-5", "input_tokens": 2000, "output_tokens": 1000, "cost_total": 0.02, "carried": True}
    result = {"extra_usage": [{"step": "hook", "provider": "anthropic", "model": "claude-sonnet-5", "input_tokens": 100, "output_tokens": 20}],
              "voiceover": {"chars": 500, "cost_usd": 0.0075}}
    cost = gui._fold_extra_costs(carried, result)
    assert cost["input_tokens"] == 100 and cost["plan_cost"] is carried
    assert [i["step"] for i in cost["items"]] == ["hook", "voiceover"]
    assert cost["cost_total"] == pytest.approx(0.0075 + cost["items"][0]["cost_total"])
    assert gui._fold_extra_costs(None, {"extra_usage": []}) is None


# ---------------------------------------------------------------------------
# Devanagari → Roman display
# ---------------------------------------------------------------------------

def test_translit_common_words():
    from src.utils.translit import has_devanagari, to_roman
    cases = {"कैसा है": "kaisa hai", "करता": "karta", "मतलब": "matlab", "नमस्ते": "namaste", "में": "mein", "हैं": "hain",
             "समझ": "samajh", "अगर": "agar", "अच्छा": "achha", "ज़रूर": "zarur", "क्या हाल है": "kya haal hai",
             "Hello दोस्तों, welcome": "Hello doston, welcome"}
    for src, want in cases.items():
        assert to_roman(src) == want, (src, to_roman(src), want)
    assert to_roman("plain english") == "plain english"
    assert has_devanagari("abc") is False and has_devanagari("abc है") is True
