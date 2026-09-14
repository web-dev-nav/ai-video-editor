// Settings forms ↔ PROJECT.options / voiceover / music / mix; model pickers; whisper; skills; presets.
import * as api from "./api.js";
import { $$, byId, esc, num, csv, flash, fmtMB, PROVIDER_NAMES } from "./ui.js";
import { BOOT, DEFAULTS, PROJECT, markDirty, emit, on } from "./state.js";

const MODEL_NOTES = {
  tiny: "~32× realtime · basic accuracy", base: "~16× realtime · decent", small: "~6× realtime · good — recommended starting point",
  medium: "~2× realtime · great", large: "~1× realtime · excellent", "large-v2": "~1× realtime · improved large", "large-v3": "~1× realtime · best accuracy (slowest on CPU)",
};

// ─────────────── form → options ───────────────
export function collectOptions() {
  return {
    whisper_model: byId("whisper_model").value, language: byId("language").value,
    silence: { min_silence_ms: num("silence.min_silence_ms"), padding_ms: num("silence.padding_ms"), min_gap_sec: num("silence.min_gap_sec"), padding_sec: num("silence.padding_sec") },
    restarts: { enabled: byId("restarts.enabled").checked, trigger_phrases: csv(byId("restarts.trigger_phrases").value), detect_repeated_starts: byId("restarts.detect_repeated_starts").checked, max_burst_duration_sec: num("restarts.max_burst_duration_sec") },
    fillers: { enabled: byId("fillers.enabled").checked, words_en: csv(byId("fillers.words_en").value), words_hi: csv(byId("fillers.words_hi").value), words_ru: csv(byId("fillers.words_ru").value), min_filler_duration_sec: num("fillers.min_filler_duration_sec") },
    audio: { enabled: byId("audio.enabled").checked, denoise: byId("audio.denoise").checked, denoise_level: num("audio.denoise_level"), highpass_freq: num("audio.highpass_freq"), deess_freq: num("audio.deess_freq"), deess_gain: num("audio.deess_gain"), compressor_threshold: num("audio.compressor_threshold"), compressor_ratio: num("audio.compressor_ratio"), limiter_limit: num("audio.limiter_limit"), loudness_target: num("audio.loudness_target") },
    lut: byId("lut").value.trim() || byId("lut-select").value || null,
    hook: { enabled: byId("hook.enabled").checked, duration_sec: num("hook.duration_sec"), provider: byId("hook.provider").value, model: byId("hook.model").value.trim() },
    chapters: { enabled: byId("chapters.enabled").checked, provider: byId("chapters.provider").value, model: byId("chapters.model").value.trim() },
    director: { enabled: PROJECT.mode === "ai", provider: byId("director.provider").value, model: byId("director.model").value.trim(), mode: byId("director.mode").value, skill: byId("director.skill").value, instructions: byId("director.instructions").value.trim() },
    encoding: { codec: byId("encoding.codec").value, quality: num("encoding.quality"), audio_bitrate: byId("encoding.audio_bitrate").value.trim() },
    bundle: byId("bundle").checked,
    output_format: { kind: byId("output_format").value, focus: byId("output_focus").value },
  };
}
function collectVoiceover() {
  const v = PROJECT.voiceover;
  Object.assign(v, { enabled: byId("vo.enabled").checked, model: byId("vo.model").value || v.model, voice: byId("vo.voice").value || v.voice, speed: num("vo.speed") || 1,
    instructions: byId("vo.instructions").value, mix_mode: byId("vo.mix_mode").value, fit: byId("vo.fit").value, max_tempo: num("vo.max_tempo") || 1.3,
    gain_db: num("vo.gain_db"), duck_original_db: num("vo.duck_original_db") });
}
function collectMusic() {
  Object.assign(PROJECT.music, { enabled: byId("music.enabled").checked, path: byId("music.path").value.trim(), gain_db: num("music.gain_db"),
    fade_in_sec: num("music.fade_in_sec"), fade_out_sec: num("music.fade_out_sec"), start_offset_sec: num("music.start_offset_sec"),
    loop: byId("music.loop").checked, duck: byId("music.duck").checked, duck_db: num("music.duck_db") });
  Object.assign(PROJECT.mix, { original_gain_db: num("mix.original_gain_db"), loudnorm: byId("mix.loudnorm").checked, loudness_target: num("mix.loudness_target") });
}
// Pull everything from the forms into PROJECT (called on any input change).
export function syncFromForms() {
  if (!PROJECT) return;
  PROJECT.options = collectOptions();
  PROJECT.output = byId("output").value.trim();
  collectVoiceover(); collectMusic();
  updateTags();
}

// ─────────────── options → form ───────────────
export function applyDefaults(d) {
  byId("whisper_model").value = d.whisper.model; byId("language").value = d.whisper.language || "auto";
  for (const k of ["min_silence_ms", "padding_ms", "min_gap_sec", "padding_sec"]) byId(`silence.${k}`).value = d.silence[k];
  byId("restarts.enabled").checked = d.restarts.enabled; byId("restarts.trigger_phrases").value = (d.restarts.trigger_phrases || []).join(", ");
  byId("restarts.detect_repeated_starts").checked = d.restarts.detect_repeated_starts; byId("restarts.max_burst_duration_sec").value = d.restarts.max_burst_duration_sec;
  byId("fillers.enabled").checked = d.fillers.enabled; byId("fillers.words_en").value = (d.fillers.words.en || []).join(", ");
  byId("fillers.words_hi").value = (d.fillers.words.hi || []).join(", "); byId("fillers.words_ru").value = (d.fillers.words.ru || []).join(", ");
  byId("fillers.min_filler_duration_sec").value = d.fillers.min_filler_duration_sec;
  byId("audio.enabled").checked = d.audio.enabled; byId("audio.denoise").checked = d.audio.denoise;
  for (const k of ["denoise_level", "highpass_freq", "deess_freq", "deess_gain", "compressor_threshold", "compressor_ratio", "limiter_limit", "loudness_target"]) byId(`audio.${k}`).value = d.audio[k];
  byId("lut").value = d.video.lut_path || ""; byId("lut-select").value = "";
  byId("hook.enabled").checked = !!d.hook.enabled; byId("hook.duration_sec").value = d.hook.duration_sec;
  byId("hook.provider").value = d.hook.provider || ""; byId("hook.model").value = d.hook.model || "";
  byId("chapters.enabled").checked = !!d.chapters.enabled; byId("chapters.provider").value = d.chapters.provider || ""; byId("chapters.model").value = d.chapters.model || "";
  const dd = d.director || {};
  byId("director.provider").value = dd.provider || "anthropic";
  byId("director.model").value = dd.model || BOOT.default_models[dd.provider || "anthropic"];
  byId("director.mode").value = dd.mode || "ai";
  if (dd.skill && byId("director.skill").querySelector(`option[value="${dd.skill}"]`)) byId("director.skill").value = dd.skill;
  byId("director.instructions").value = dd.instructions || "";
  byId("encoding.codec").value = d.encoding.codec; byId("encoding.quality").value = d.encoding.quality; byId("encoding.audio_bitrate").value = d.encoding.audio_bitrate;
  if (typeof d.bundle === "boolean") byId("bundle").checked = d.bundle;
  if (d.output_format) { byId("output_format").value = d.output_format.kind || "source"; byId("output_focus").value = d.output_format.focus || "center"; }
  updateFormatHint(); updateTags();
}
// options (the flat GUI shape) → defaults-shaped → form
export function applyOptions(o) {
  const d = JSON.parse(JSON.stringify(DEFAULTS));
  d.whisper.model = o.whisper_model || d.whisper.model; d.whisper.language = o.language || "auto";
  Object.assign(d.silence, o.silence || {}); Object.assign(d.restarts, o.restarts || {});
  if (o.fillers) { d.fillers.enabled = o.fillers.enabled; d.fillers.min_filler_duration_sec = o.fillers.min_filler_duration_sec; d.fillers.words = { en: o.fillers.words_en || [], ru: o.fillers.words_ru || [], hi: o.fillers.words_hi || [] }; }
  Object.assign(d.audio, o.audio || {}); d.video.lut_path = o.lut || null;
  Object.assign(d.hook, o.hook || {}); Object.assign(d.chapters, o.chapters || {}); Object.assign(d.encoding, o.encoding || {});
  d.director = Object.assign(d.director || {}, o.director || {});
  d.bundle = o.bundle; d.output_format = o.output_format;
  applyDefaults(d);
}
export function applyProjectToForms() {
  const P = PROJECT;
  if (P.options) applyOptions(P.options); else applyDefaults(DEFAULTS);
  byId("output").value = P.output || "";
  const v = P.voiceover;
  byId("vo.enabled").checked = !!v.enabled; byId("vo-body").hidden = !v.enabled;
  setEngine(v.engine, false);
  byId("vo.model").value = v.model || "gpt-4o-mini-tts"; byId("vo.speed").value = v.speed ?? 1; byId("vo.instructions").value = v.instructions || "";
  byId("vo.mix_mode").value = v.mix_mode || "narrate"; byId("vo.fit").value = v.fit || "tempo"; byId("vo.max_tempo").value = v.max_tempo ?? 1.3;
  byId("vo.gain_db").value = v.gain_db ?? 0; byId("vo.gain_db-range").value = v.gain_db ?? 0; byId("vo.duck_original_db").value = v.duck_original_db ?? -12;
  const m = P.music;
  byId("music.enabled").checked = !!m.enabled; byId("music.path").value = m.path || "";
  byId("music.gain_db").value = m.gain_db ?? -18; byId("music.gain_db-range").value = m.gain_db ?? -18;
  byId("music.fade_in_sec").value = m.fade_in_sec ?? 2; byId("music.fade_out_sec").value = m.fade_out_sec ?? 3; byId("music.start_offset_sec").value = m.start_offset_sec ?? 0;
  byId("music.loop").checked = m.loop !== false; byId("music.duck").checked = m.duck !== false; byId("music.duck_db").value = m.duck_db ?? -12;
  byId("mix.original_gain_db").value = P.mix.original_gain_db ?? 0; byId("mix.original_gain_db-range").value = P.mix.original_gain_db ?? 0;
  byId("mix.loudnorm").checked = !!P.mix.loudnorm; byId("mix.loudness_target").value = P.mix.loudness_target ?? -14;
  setMode(P.mode || "auto", false);
  loadVoices();
  updateTags();
}

// ─────────────── mode chooser ───────────────
export function setMode(m, dirty = true) {
  PROJECT.mode = m; localStorage.setItem("ave.mode", m);
  $$(".mode").forEach((el) => el.classList.toggle("active", el.dataset.mode === m));
  byId("panel-auto").hidden = m !== "auto"; byId("panel-ai").hidden = m !== "ai";
  if (dirty) { syncFromForms(); markDirty("mode"); }
  emit("mode");
}

// ─────────────── tags / hints ───────────────
export function updateTags() {
  const o = collectOptions();
  byId("tag-silence").textContent = `${o.silence.min_silence_ms} ms · gap ${o.silence.min_gap_sec}s`;
  byId("tag-restarts").textContent = o.restarts.enabled ? "on" : "off";
  byId("tag-fillers").textContent = o.fillers.enabled ? `on · ${o.fillers.words_en.length + o.fillers.words_hi.length + o.fillers.words_ru.length} words` : "off";
  byId("tag-audio").textContent = o.audio.enabled ? "on" : "off";
  byId("tag-lut").textContent = o.lut ? o.lut.split(/[\\/]/).pop() : "none";
  byId("tag-extras").textContent = [o.hook.enabled && "hook", o.chapters.enabled && "chapters"].filter(Boolean).join(" + ") || "off";
  byId("tag-enc").textContent = `${o.encoding.codec} · q${o.encoding.quality}`;
  byId("tag-whisper").textContent = `${o.whisper_model} · ${o.language}`;
  byId("tag-ai-adv").textContent = { ai: "AI judges words", refine: "on top of Auto", full: "exact ranges" }[o.director.mode];
  byId("model-hint").textContent = MODEL_NOTES[o.whisper_model] || ""; byId("model-hint").hidden = !byId("model-hint").textContent;
  const prov = o.director.provider, hasKey = BOOT.keys[prov];
  byId("director-key-hint").textContent = `No ${PROVIDER_NAMES[prov]} key — add one under Keys.`;
  byId("director-key-hint").hidden = !!hasKey;
  const hp = o.hook.provider || prov, cp = o.chapters.provider || prov;
  const missing = [(o.hook.enabled && !BOOT.keys[hp]) && `hook → ${PROVIDER_NAMES[hp]}`, (o.chapters.enabled && !BOOT.keys[cp]) && `chapters → ${PROVIDER_NAMES[cp]}`].filter(Boolean);
  byId("extras-hint").textContent = missing.length ? `No key for ${missing.join(", ")} — will be skipped.` : "";
  byId("extras-hint").hidden = !missing.length;
  byId("vo-hook-note").hidden = !o.hook.enabled;
  const m = PROJECT.music;
  byId("music-tag").textContent = m && m.enabled && m.path ? `${m.path.split(/[\\/]/).pop()} · ${m.gain_db} dB` : "off";
  const cues = PROJECT.voiceover.cues.length;
  byId("cues-tag").textContent = cues ? `${cues}` : "";
  byId("vo-body").hidden = !PROJECT.voiceover.enabled;
  document.querySelector('.tabs button[data-tab="voice"]').textContent = PROJECT.voiceover.enabled ? "🎙 Voice ●" : "🎙 Voice";
  emit("tags");
}
export function updateFormatHint(src) {
  const k = byId("output_format").value;
  byId("focus-field").hidden = k !== "vertical-crop";
  let t = "";
  if (k === "vertical-crop") t = src && src.width > src.height ? `Landscape ${src.width}×${src.height} → sides cropped, full height kept. Set Crop focus to where you sit in frame.` : "Source is already vertical/square — scaled to 1080×1920.";
  else if (k === "vertical-blur") t = "Whole frame kept, letterboxed over a blurred copy — nothing cut off, speaker appears smaller.";
  else if (k === "square") t = "Centre crop to 1080×1080.";
  byId("format-hint").textContent = t;
}

// ─────────────── model pickers (director / hook / chapters) ───────────────
const MODEL_LISTS = {};   // provider -> {models, error}
async function fetchModels(provider, force) {
  if (!force && MODEL_LISTS[provider]) return MODEL_LISTS[provider];
  let data;
  try { data = await api.models(provider, force); } catch (e) { data = { error: e.message, models: [] }; }
  MODEL_LISTS[provider] = data; return data;
}
export async function loadModelPicker(prefix, force = false) {
  const provSel = byId(`${prefix}.provider`), sel = byId(`${prefix}.model-select`), txt = byId(`${prefix}.model`);
  const inherit = prefix !== "director" && !provSel.value;
  const prov = provSel.value || byId("director.provider").value;
  const current = txt.value.trim() || (inherit ? "" : BOOT.default_models[prov]);
  sel.innerHTML = `<option value="">Loading…</option>`; sel.disabled = true;
  const data = await fetchModels(prov, force);
  sel.disabled = false;
  const opts = data.models.map((m) => `<option value="${esc(m.id)}">${m.recommended ? "★ " : ""}${esc(m.name !== m.id ? `${m.name} — ${m.id}` : m.id)}${m.recommended ? ` (${esc(m.recommended)})` : ""}</option>`);
  if (inherit) opts.unshift(`<option value="">Same as AI editor (${esc(byId("director.model").value || BOOT.default_models[prov])})</option>`);
  if (current && !data.models.some((m) => m.id === current)) opts.unshift(`<option value="${esc(current)}">${esc(current)}</option>`);
  sel.innerHTML = opts.join("") + `<option value="__custom__">Other (type an id)…</option>`;
  if (prefix === "director" && !data.models.length && data.error) byId("director-key-hint").textContent = `Model list unavailable: ${data.error}`;
  sel.value = current; if (sel.value !== current) sel.value = inherit ? "" : current;
  txt.value = current; txt.hidden = true;
}
function bindModelPicker(prefix) {
  const provSel = byId(`${prefix}.provider`), sel = byId(`${prefix}.model-select`), txt = byId(`${prefix}.model`);
  sel.addEventListener("change", () => {
    if (sel.value === "__custom__") { txt.hidden = false; txt.value = ""; txt.focus(); } else { txt.hidden = true; txt.value = sel.value; }
    syncFromForms(); markDirty("model");
  });
  provSel.addEventListener("change", () => {
    txt.value = prefix === "director" ? BOOT.default_models[provSel.value] : "";
    loadModelPicker(prefix); syncFromForms(); markDirty("provider");
    if (prefix === "director") { loadModelPicker("hook"); loadModelPicker("chapters"); }
  });
  $$(`[data-refresh="${prefix}"]`).forEach((b) => (b.onclick = (e) => { e.preventDefault(); loadModelPicker(prefix, true); }));
}
export function loadAllModelPickers(force = false) { return Promise.all(["director", "hook", "chapters"].map((p) => loadModelPicker(p, force))); }

// ─────────────── skills ───────────────
let SKILLS = [], SKILLS_DIR = "";
export async function loadSkills() {
  try { const d = await api.skills(); SKILLS = d.skills; SKILLS_DIR = d.dir; } catch { SKILLS = []; }
  const sel = byId("director.skill"), cur = sel.value || (DEFAULTS.director && DEFAULTS.director.skill) || "clean";
  sel.innerHTML = SKILLS.map((sk) => `<option value="${esc(sk.id)}">${sk.emoji ? sk.emoji + " " : ""}${esc(sk.name)}</option>`).join("");
  sel.value = SKILLS.some((sk) => sk.id === cur) ? cur : (SKILLS[0] ? SKILLS[0].id : "");
  updateSkillDesc();
}
function updateSkillDesc() { const sk = SKILLS.find((x) => x.id === byId("director.skill").value); byId("director.skill").title = sk ? sk.description : ""; byId("skill-desc").textContent = ""; }

// ─────────────── whisper download box ───────────────
let WHISPER = {}, whisperPoll = null;
export async function refreshWhisper() {
  try { const d = await api.whisperModels(); for (const m of d.models) WHISPER[m.model] = m; } catch {}
  const sel = byId("whisper_model"), cur = sel.value;
  sel.innerHTML = BOOT.models.map((m) => { const w = WHISPER[m]; const tag = !w ? "" : w.downloaded ? ` — ${fmtMB(w.total)} ✓` : w.state === "downloading" ? ` — downloading ${w.pct}%` : ` — ${fmtMB(w.total)} download`; return `<option value="${m}">${m}${tag}</option>`; }).join("");
  sel.value = cur || sel.value; updateWhisperBox();
}
function updateWhisperBox() {
  const m = byId("whisper_model").value, w = WHISPER[m], box = byId("whisper-dl"), txt = byId("whisper-dl-text"), bar = byId("whisper-dl-bar"), btn = byId("btn-whisper-dl");
  if (!w) { box.hidden = true; return; }
  box.hidden = false; bar.hidden = true; btn.hidden = false;
  if (w.downloaded) { box.hidden = true; return; }
  else if (w.state === "downloading") { txt.innerHTML = `⬇ Downloading <b>${m}</b>: ${w.pct}% · ${fmtMB(w.bytes)} / ${fmtMB(w.total)}`; bar.hidden = false; bar.querySelector("div").style.width = w.pct + "%"; btn.hidden = true; }
  else if (w.state === "error") { txt.innerHTML = `Download failed: ${esc(w.error || "")}`; }
  else { txt.innerHTML = `<b>${m}</b> · ${fmtMB(w.total)} download on first use`; }
  if (w.state === "downloading" && !whisperPoll) whisperPoll = setInterval(async () => { const st = await api.whisperStatus(m); WHISPER[m] = st; updateWhisperBox(); if (st.state !== "downloading") { clearInterval(whisperPoll); whisperPoll = null; refreshWhisper(); } }, 1000);
}

// ─────────────── TTS engine / voices ───────────────
let VOICES = {};   // engine -> [{id,name,...}]
export function setEngine(engine, dirty = true) {
  PROJECT.voiceover.engine = engine;
  const st = ((BOOT.tts || {}).engines || {})[engine] || {};
  $$("#engine-pills button").forEach((b) => b.classList.toggle("active", b.dataset.engine === engine));
  byId("vo-model-field").hidden = engine !== "openai";
  byId("vo-instr-field").hidden = !(engine === "openai" && (byId("vo.model").value || "gpt-4o-mini-tts").startsWith("gpt-4o"));
  byId("vo-engine-note").textContent = st.note || "";
  byId("vo-engine-note").style.color = st.available ? "" : "var(--warn)";
  if (dirty) { markDirty("engine"); }
}
export async function loadVoices(force = false) {
  const engine = PROJECT.voiceover.engine, sel = byId("vo.voice");
  if (!VOICES[engine] || force) {
    sel.innerHTML = `<option>Loading voices…</option>`;
    try { const d = await api.ttsVoices(engine); VOICES[engine] = d.voices || []; if (d.engines) BOOT.tts.engines = d.engines; } catch { VOICES[engine] = []; }
  }
  const list = VOICES[engine];
  const want = PROJECT.voiceover.voice || (BOOT.tts.default_voice || {})[engine] || (list[0] && list[0].id) || "";
  sel.innerHTML = list.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join("") || `<option value="${esc(want)}">${esc(want)}</option>`;
  if (want && !list.some((v) => v.id === want)) sel.insertAdjacentHTML("afterbegin", `<option value="${esc(want)}">${esc(want)}</option>`);
  sel.value = want; PROJECT.voiceover.voice = sel.value;
  // cue inspector voice list mirrors this
  const cs = byId("cue.voice"); const cur = cs.value;
  cs.innerHTML = `<option value="">Project voice (${esc(sel.value)})</option>` + list.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join("");
  cs.value = cur;
  setEngine(engine, false);
  emit("voices");
}
export function voiceName(id) { const e = PROJECT.voiceover.engine; const v = (VOICES[e] || []).find((x) => x.id === id); return v ? v.name.split(" — ")[0] : id; }

// ─────────────── presets ───────────────
function presetHint() { const el = byId("preset-hint"); el.textContent = localStorage.getItem("ave.preset") ? "Saved settings apply to new projects." : ""; el.hidden = !el.textContent; }
export function loadPresetIntoForms() {
  const preset = localStorage.getItem("ave.preset");
  if (preset) { try { const o = JSON.parse(preset); applyOptions(o); if (typeof o.review === "boolean") byId("bundle").checked = !!o.bundle; return true; } catch {} }
  applyDefaults(DEFAULTS); return false;
}

// ─────────────── wiring ───────────────
export function initSettings() {
  byId("whisper_model").innerHTML = BOOT.models.map((m) => `<option value="${m}">${m}</option>`).join("");
  byId("lut-select").innerHTML = `<option value="">None</option>` + BOOT.luts.map((l) => `<option value="${esc(l)}">${esc(l.split("/").pop())}</option>`).join("");
  byId("vo.model").innerHTML = ((BOOT.tts || {}).openai_models || ["gpt-4o-mini-tts"]).map((m) => `<option value="${m}">${m}${m === "gpt-4o-mini-tts" ? " (natural, steerable)" : m === "tts-1-hd" ? " (hi-fi)" : ""}</option>`).join("");
  const pills = byId("engine-pills");
  const names = { openai: "OpenAI", edge: "Edge (free)", kokoro: "Kokoro (offline, free)" };
  pills.innerHTML = Object.entries((BOOT.tts || {}).engines || {}).map(([k, st]) => `<button data-engine="${k}" title="${esc(st.note || "")}">${names[k] || k}${st.available ? "" : " ⚠"}</button>`).join("");
  $$("#engine-pills button").forEach((b) => (b.onclick = () => { setEngine(b.dataset.engine); PROJECT.voiceover.voice = ""; loadVoices(); markDirty("engine"); }));
  byId("btn-voices").onclick = (e) => { e.preventDefault(); loadVoices(true); };
  byId("vo.model").addEventListener("change", () => setEngine(PROJECT.voiceover.engine, false));
  byId("vo.enabled").addEventListener("change", () => { emit("cues"); });

  // every form input → PROJECT + tags
  for (const id of ["left", "right"]) {
    byId(id).addEventListener("input", (e) => { if (e.target.closest("#plan-box, #cues, #insp-cue, #insp-piece, .list")) return; mirrorSlider(e.target); syncFromForms(); markDirty("settings"); });
    byId(id).addEventListener("change", (e) => { if (e.target.closest("#plan-box, #cues, #insp-cue, #insp-piece, .list")) return; mirrorSlider(e.target); syncFromForms(); markDirty("settings"); emit("settings-change", e.target.id); });
  }
  byId("output_format").addEventListener("change", () => updateFormatHint(PROJECT.source));
  byId("lut-select").addEventListener("change", () => { if (byId("lut-select").value) byId("lut").value = ""; });
  byId("whisper_model").addEventListener("change", () => { updateWhisperBox(); byId("whisper-change-note").hidden = !PROJECT.transcript; });
  byId("language").addEventListener("change", () => { byId("whisper-change-note").hidden = !PROJECT.transcript; });
  byId("btn-whisper-dl").onclick = async () => { const m = byId("whisper_model").value; WHISPER[m] = await api.whisperDownload(m); updateWhisperBox(); };
  $$(".mode").forEach((el) => (el.onclick = () => setMode(el.dataset.mode)));
  ["director", "hook", "chapters"].forEach(bindModelPicker);
  byId("btn-skills").onclick = (e) => { e.preventDefault(); loadSkills(); flash(byId("btn-skills"), "✓"); };
  byId("director.skill").addEventListener("change", updateSkillDesc);
  byId("btn-skill-view").onclick = (e) => { e.preventDefault(); const sk = SKILLS.find((x) => x.id === byId("director.skill").value); if (!sk) return; byId("skill-title").textContent = `${sk.emoji || ""} ${sk.name}`; byId("skill-path").textContent = `${SKILLS_DIR}/${sk.id}.md — edit the file or add your own, then press ↻`; byId("skill-text").textContent = sk.body; byId("skill-dialog").showModal(); };
  byId("skill-close").onclick = () => byId("skill-dialog").close();
  byId("btn-reset").onclick = () => { applyDefaults(DEFAULTS); localStorage.removeItem("ave.preset"); presetHint(); syncFromForms(); markDirty("reset"); };
  byId("btn-save-preset").onclick = () => { localStorage.setItem("ave.preset", JSON.stringify({ ...collectOptions() })); flash(byId("btn-save-preset"), "Saved ✓"); presetHint(); };
  presetHint();
  buildChips();
  on("tags", () => {});
}
function mirrorSlider(el) {
  if (!el || !el.id) return;
  if (el.id.endsWith("-range")) { const t = byId(el.id.replace(/-range$/, "")); if (t) t.value = el.value; }
  else { const r = byId(el.id + "-range"); if (r) r.value = el.value; }
}
function buildChips() {
  const box = byId("target-chips");
  const targets = [["YouTube Shorts ≤ 3:00", "Keep the final video under 3 minutes (YouTube Shorts).", true], ["Instagram Reel ≤ 3:00", "Keep the final video under 3 minutes (Instagram Reel).", true], ["Facebook Reel ≤ 1:30", "Keep the final video under 90 seconds (Facebook Reel).", true], ["≤ 60 s", "Keep the final video under 60 seconds.", true], ["Long-form, just clean up", "Keep the full length; only clean up fillers, stumbles and repeats.", false]];
  for (const [label, text, vertical] of targets) {
    const b = document.createElement("button"); b.textContent = label;
    b.onclick = (e) => {
      e.preventDefault();
      const ta = byId("director.instructions"); ta.value = (ta.value.replace(/Keep the (final video|full length)[^\n]*\n?/g, "").trim() + "\n" + text).trim();
      if (vertical) { if (byId("output_format").value === "source") byId("output_format").value = "vertical-crop"; if (byId("director.skill").querySelector('option[value="shorts"]')) byId("director.skill").value = "shorts"; }
      else byId("output_format").value = "source";
      updateFormatHint(PROJECT.source); updateSkillDesc(); syncFromForms(); markDirty("chip");
      if (vertical && PROJECT.source.width > PROJECT.source.height) flash(b, "✓ vertical output set");
    };
    box.appendChild(b);
  }
}
