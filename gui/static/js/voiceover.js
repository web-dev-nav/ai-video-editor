// Voiceover tab: cue list, AI script suggestions, TTS generation, cost estimate.
import * as api from "./api.js";
import { byId, esc, mmss, uid, usd, showAlert, ALERT_TEXT, PROVIDER_NAMES } from "./ui.js";
import { BOOT, PROJECT, SEL, on, emit, select, markDirty, outToSrc, round3, outDuration } from "./state.js";
import { voiceName } from "./settings.js";
import { currentOut, resetCueAudio } from "./preview.js";
import { collectOptions } from "./settings.js";
import { disp } from "./translit.js";
import { isOn as autoRunOn } from "./autorun.js";

// Everything that changes the audio of a cue → its hash key on the server. We only compare locally.
function specOf(c) {
  const v = PROJECT.voiceover;
  const engine = v.engine, model = engine === "openai" ? (v.model || "gpt-4o-mini-tts") : null;
  return { engine, model, voice: c.voice || v.voice, text: (c.text || "").trim(), speed: c.speed || v.speed || 1,
           instructions: engine === "openai" && (model || "").startsWith("gpt-4o") ? (c.instructions || v.instructions || "") : "" };
}
const specKey = (c) => JSON.stringify(specOf(c));
export function touchCue(c) { if (c.audio && c.spec_key && c.spec_key !== specKey(c)) c.status = "stale"; else if (c.audio && c.spec_key === specKey(c)) c.status = "ready"; }
export function refreshStale() { for (const c of PROJECT.voiceover.cues) touchCue(c); }

export function cueSlot(c) {
  const cues = PROJECT.voiceover.cues.slice().sort((a, b) => a.start - b.start);
  const i = cues.findIndex((x) => x.id === c.id), next = cues[i + 1];
  if (c.end != null && c.end > c.start) return c.end - c.start;
  if (next) return next.start - c.start;
  return null;
}
export function cueFitInfo(c) {
  const slot = cueSlot(c), v = PROJECT.voiceover;
  const est = c.duration_sec || Math.max(1, (c.text || "").trim().length / 12);
  let s = `${c.duration_sec ? `<b>${c.duration_sec.toFixed(1)} s</b> clip` : `≈ <b>${est.toFixed(1)} s</b> (estimate)`}`;
  if (slot == null) return s + " · no slot limit (last cue / no end)";
  s += ` in a <b>${slot.toFixed(1)} s</b> slot`;
  if (est <= slot + 0.05) return s + " · fits ✓";
  const need = est / slot;
  if (v.fit === "tempo" && need <= (v.max_tempo || 1.3)) return s + ` · sped up ×${need.toFixed(2)} to fit`;
  if (v.fit === "tempo") return s + ` · <span style="color:var(--warn)">×${(v.max_tempo || 1.3).toFixed(2)} max — still overruns by ${(est / (v.max_tempo || 1.3) - slot).toFixed(1)} s</span>`;
  return s + ` · <span style="color:var(--warn)">overruns by ${(est - slot).toFixed(1)} s</span>`;
}

// ─────────────── cue list ───────────────
export function renderCues() {
  const box = byId("cues"), cues = PROJECT.voiceover.cues.slice().sort((a, b) => a.start - b.start);
  if (!cues.length) { box.innerHTML = `<div class="hint">No cues yet.</div>`; updateEstimate(); return; }
  box.innerHTML = cues.map((c) => `<div class="cue${SEL.kind === "cue" && SEL.id === c.id ? " selected" : ""}" data-id="${c.id}">
      <div class="head"><span class="t">${mmss(c.start)}</span>${c.voice ? `<span>${esc(voiceName(c.voice))}</span>` : ""}<span class="st ${c.status || "pending"}">${{ ready: "✓ ready", stale: "changed", pending: "not generated", error: "failed" }[c.status || "pending"]}</span></div>
      <div class="txt">${esc(disp(c.text))}</div>${c.original && c.original !== c.text ? `<div class="orig">was: ${esc(disp(c.original))}</div>` : ""}
      <div class="ops"><button class="small" data-op="gen">🔊 ${c.status === "ready" ? "Regenerate" : "Generate"}</button><button class="small" data-op="play" ${c.audio && c.status !== "stale" ? "" : "disabled"}>▶</button><button class="small" data-op="seek">⏵</button><button class="small danger" data-op="del">✕</button></div>
    </div>`).join("");
  box.querySelectorAll(".cue").forEach((el) => {
    const id = el.dataset.id;
    el.onclick = (e) => { if (e.target.tagName === "BUTTON") return; select("cue", id); };
    el.querySelector('[data-op="gen"]').onclick = () => generateCue(id);
    el.querySelector('[data-op="play"]').onclick = () => { const c = cueById(id); const a = byId("cue-audio"); a.src = api.media(c.audio); a.playbackRate = c.tempo || 1; a.play(); };
    el.querySelector('[data-op="seek"]').onclick = () => emit("seek", cueById(id).start);
    el.querySelector('[data-op="del"]').onclick = () => deleteCue(id);
  });
  updateEstimate();
}
const cueById = (id) => PROJECT.voiceover.cues.find((c) => c.id === id);

async function updateEstimate() {
  const v = PROJECT.voiceover, cues = v.cues.filter((c) => c.status !== "ready");
  const chars = cues.reduce((a, c) => a + (c.text || "").trim().length, 0);
  const el = byId("vo-estimate");
  if (!v.cues.length) { el.textContent = ""; return; }
  if (v.engine !== "openai") { el.textContent = `${v.cues.length} cue${v.cues.length > 1 ? "s" : ""} · free (${v.engine})`; return; }
  const price = (v.model === "tts-1-hd" ? 0.03 : 0.015) * chars / 1000;
  el.textContent = `${cues.length} to generate · ${chars.toLocaleString()} chars ≈ ${usd(price)} (${v.model})`;
}

export function addCue(text, start, extra = {}) {
  const c = { id: uid("c"), start: round3(start), end: null, src: round3(outToSrc(start)), text: (text || "").trim(), voice: null, speed: null, instructions: null,
              audio: null, duration_sec: null, hash: null, status: "pending", ...extra };
  PROJECT.voiceover.cues.push(c);
  markDirty("cue-add"); emit("cues"); select("cue", c.id);
  return c;
}
export function deleteCue(id) {
  PROJECT.voiceover.cues = PROJECT.voiceover.cues.filter((c) => c.id !== id);
  resetCueAudio(id);
  if (SEL.kind === "cue" && SEL.id === id) select(null, null);
  markDirty("cue-del"); emit("cues");
}

export async function generateCue(id, quiet = false) {
  const c = cueById(id); if (!c || !(c.text || "").trim()) return false;
  const spec = specOf(c);
  const st = ((BOOT.tts || {}).engines || {})[spec.engine];
  if (st && !st.available && spec.engine === "openai") { showAlert("auth", `<b>OpenAI voices need an OpenAI API key.</b> Add one under API keys, or pick Edge (free) / Kokoro.`); return false; }
  c.status = "generating"; if (!quiet) emit("cues");
  try {
    const r = await api.ttsGenerate(spec);
    if (r.error) { c.status = "error"; c.error = r.error; if (!quiet && ALERT_TEXT[r.kind]) showAlert(r.kind, ALERT_TEXT[r.kind](spec.engine === "openai" ? "OpenAI" : spec.engine)); else if (!quiet) showAlert("other", `<b>Voice generation failed:</b> ${esc(r.error)}`); emit("cues"); return false; }
    Object.assign(c, { audio: r.path, duration_sec: r.duration_sec, hash: r.hash, status: "ready", error: null, spec_key: specKey(c), engine: spec.engine, cost_usd: r.cost_usd || 0 });
    resetCueAudio(id);
    if (r.cost_usd) { PROJECT.cost = PROJECT.cost || {}; PROJECT.cost.tts_usd = round3((PROJECT.cost.tts_usd || 0) + r.cost_usd); }
  } catch (e) { c.status = "error"; c.error = e.message; }
  markDirty("cue-gen"); emit("cues");
  return c.status === "ready";
}
export async function generateAll(onlyStale = true) {
  const list = PROJECT.voiceover.cues.filter((c) => !onlyStale || c.status !== "ready");
  const btn = byId("btn-gen-all"); const t = btn.textContent; btn.disabled = true;
  let ok = 0;
  for (let i = 0; i < list.length; i++) { btn.textContent = `Generating ${i + 1}/${list.length}…`; if (await generateCue(list[i].id, true)) ok++; }
  btn.textContent = t; btn.disabled = false;
  emit("cues");
  return ok === list.length;
}

// ─────────────── AI script suggestion ───────────────
async function suggest() {
  const P = PROJECT, btn = byId("btn-suggest"), note = byId("vo-suggest-note");
  if (!P.source.inputs.length) { note.textContent = "Add a video first."; return; }
  const o = collectOptions();
  const prov = o.director.provider;
  if (!BOOT.keys[prov]) { showAlert("auth", `<b>No ${PROVIDER_NAMES[prov]} key.</b> The script writer uses the AI editor's provider — add a key under API keys.`); return; }
  const mode = byId("vo-suggest-mode").value;
  btn.disabled = true; btn.textContent = "Thinking…"; note.textContent = "";
  try {
    const r = await api.scriptSuggest({ inputs: P.source.inputs, keep_segments: P.keep_segments, director: { provider: prov, model: o.director.model }, style: byId("vo-style").value.trim(), mode });
    if (r.error) { note.textContent = r.error; note.className = "hint err"; if (ALERT_TEXT[r.kind]) showAlert(r.kind, ALERT_TEXT[r.kind](PROVIDER_NAMES[prov])); return; }
    note.className = "hint ok";
    if (r.mode === "free") { byId("vo-script").value = r.script; note.textContent = `${r.summary || "Script ready."} Edit it below, then add it as cues.`; }
    else {
      if (P.voiceover.cues.length && !confirm(`Replace the ${P.voiceover.cues.length} existing cue(s) with ${r.cues.length} suggested ones?`)) return;
      for (const c of P.voiceover.cues) resetCueAudio(c.id);
      P.voiceover.cues = r.cues.map((c) => ({ id: uid("c"), start: round3(c.start), end: round3(c.end), src: round3(c.src), src_end: round3(outToSrc(c.end)), text: c.text, original: c.original,
        voice: null, speed: null, instructions: null, audio: null, duration_sec: null, hash: null, status: "pending" }));
      note.textContent = `${r.summary || ""} ${r.cues.length} cues, aligned to the video.`;
      if (P.voiceover.mix_mode !== "replace" && confirm("These cues re-voice the whole talk. Switch the mix to 'Replace my voice' (original muted under cues)?")) { P.voiceover.mix_mode = "replace"; byId("vo.mix_mode").value = "replace"; }
      markDirty("suggest"); emit("cues");
    }
    if (r.cost) { P.cost = P.cost || {}; P.cost.llm_usd = round3((P.cost.llm_usd || 0) + (r.cost.cost_total || 0)); note.textContent += ` (${usd(r.cost.cost_total)})`; }
  } catch (e) { note.textContent = e.message; note.className = "hint err"; }
  finally { btn.disabled = false; btn.textContent = "✨ Write from transcript"; }
}

async function loadVoicesIfNeeded() { const s = await import("./settings.js"); if (byId("vo.voice").options.length <= 1) s.loadVoices(); }
function splitSentences(text) { return text.replace(/\s+/g, " ").trim().split(/(?<=[.!?…।])\s+/).map((s) => s.trim()).filter(Boolean); }

// Changing the voice, engine, speed or a cue's text makes its audio stale (touchCue).
// Regenerate it without being asked — unchanged cues hit the server-side TTS cache in
// uploads/.cache/tts/, so this only costs anything when the audio really did change.
let autoGenTimer = null;
function autoGenerateStale() {
  if (!autoRunOn() || !PROJECT.voiceover.enabled) return;
  refreshStale();
  if (!PROJECT.voiceover.cues.some((c) => (c.text || "").trim() && c.status !== "ready" && c.status !== "generating")) return;
  clearTimeout(autoGenTimer);
  autoGenTimer = setTimeout(() => generateAll(true), 1200);
}

export function initVoiceover() {
  byId("btn-suggest").onclick = suggest;
  on("dirty", (what) => { if (what !== "cue-gen") autoGenerateStale(); });
  // the tab's switch is the only way in: everything else stays hidden until it is on
  on("settings-change", (id) => { if (id === "vo.enabled") { if (byId("vo.enabled").checked) loadVoicesIfNeeded(); emit("cues"); } });
  byId("btn-add-cue").onclick = () => addCue("", currentOut());
  byId("btn-script-add").onclick = () => { const t = byId("vo-script").value.trim(); if (!t) return; addCue(t, currentOut()); byId("vo-script").value = ""; };
  byId("btn-script-split").onclick = () => {
    const t = byId("vo-script").value.trim(); if (!t) return;
    const parts = splitSentences(t); let at = currentOut(); const total = outDuration() || 1e9;
    for (const s of parts) { const est = Math.max(1.5, s.length / 12); addCue(s, Math.min(at, total)); at += est + 0.4; }
    byId("vo-script").value = "";
  };
  byId("btn-gen-all").onclick = () => generateAll(true);
  byId("btn-clear-cues").onclick = () => { if (!PROJECT.voiceover.cues.length || confirm("Remove all cues?")) { for (const c of PROJECT.voiceover.cues) resetCueAudio(c.id); PROJECT.voiceover.cues = []; select(null, null); markDirty("cues-clear"); emit("cues"); } };
  byId("btn-vo-test").onclick = async () => {
    const v = PROJECT.voiceover, note = byId("vo-test-note"), btn = byId("btn-vo-test");
    btn.disabled = true; note.textContent = "Generating…";
    try {
      const r = await api.ttsGenerate({ engine: v.engine, model: v.model, voice: v.voice, speed: v.speed, instructions: v.instructions, text: "Hi there! This is how your voiceover will sound. Natural, clear, and easy to listen to." });
      if (r.error) { note.textContent = r.error; note.className = "hint err"; }
      else { const a = byId("vo-test-audio"); a.src = api.media(r.path); a.play(); note.textContent = `${r.duration_sec.toFixed(1)} s${r.cost_usd ? ` · ${usd(r.cost_usd)}` : " · free"}`; note.className = "hint ok"; }
    } catch (e) { note.textContent = e.message; note.className = "hint err"; }
    finally { btn.disabled = false; }
  };
  on("cues", () => { refreshStale(); renderCues(); });
  on("cues-quiet", () => { updateEstimate(); });
  on("selection", renderCues);
  on("project", renderCues);
  on("voices", renderCues); on("roman", renderCues);
  on("settings-change", (id) => { if (id && (id.startsWith("vo.") || id === "engine")) { refreshStale(); emit("cues"); } });
}
