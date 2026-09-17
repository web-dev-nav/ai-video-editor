// Auto-reprocessing: keeps the timeline in step with the settings.
//
// Every stage of the pipeline is fingerprinted from the inputs that actually affect it.
// When a fingerprint stops matching the one the last run was made with, that stage is
// stale and is re-run. Nothing here looks at *why* something changed — only at whether
// the fingerprint moved — which is what keeps the rules honest and loop-free.
//
//   source   inputs, whisper model, language        → mirrors _cache_key() in
//                                                     src/pipeline.py, so the server
//                                                     re-transcribes exactly when this
//                                                     key moves and reuses its cache
//                                                     otherwise
//   plan     source + provider/model/style/brief/
//            instructions/silence                   → one `plan` job covers both stages:
//                                                     it transcribes only on a cache miss
//   render   plan + manual cuts + voiceover + music
//            + mix + output format                  → NOT auto-run: the preview already
//                                                     plays all of this live, and
//                                                     re-encoding on every slider nudge
//                                                     would make the app unusable
//
// PROJECT.pieces is deliberately absent from planKey: hand-toggling a cut must never
// trigger a re-plan, which would throw the manual edit away.
import { BOOT, PROJECT, on, emit } from "./state.js";
import { byId, showAlert, PROVIDER_NAMES } from "./ui.js";

const DEBOUNCE_MS = 1500;
const stable = (o) => JSON.stringify(o);

// ─────────────── fingerprints (no DOM — unit-testable) ───────────────
export function srcKey(P = PROJECT) {
  const o = P.options || {};
  return stable({ inputs: P.source.inputs || [], model: o.whisper_model || null, lang: o.language || null });
}
export function planKey(P = PROJECT) {
  const o = P.options || {}, d = o.director || {};
  return stable({
    src: srcKey(P), provider: d.provider || null, model: d.model || null, mode: d.mode || null,
    skill: d.skill || null, brief: d.skill_brief || "", instructions: d.instructions || "",
    silence: o.silence || null,
  });
}
export function renderKey(P = PROJECT) {
  const o = P.options || {}, v = P.voiceover || {}, m = P.music || {};
  return stable({
    plan: planKey(P),
    keep: P.keep_segments || [],
    vo: v.enabled ? { mix: v.mix_mode, fit: v.fit, gain: v.gain_db, duck: v.duck_original_db,
                      cues: (v.cues || []).map((c) => [c.start, c.end, c.audio || "", c.text]) } : null,
    music: m.enabled && m.path ? [m.path, m.gain_db, m.fade_in_sec, m.fade_out_sec, m.start_offset_sec, m.loop, m.duck, m.duck_db] : null,
    mix: P.mix || null, format: o.output_format || null, enc: o.encoding || null,
    lut: o.lut || null, audio: o.audio || null, hook: o.hook || null, chapters: o.chapters || null,
  });
}

// A project saved before fingerprints existed has none. If it already carries an edit,
// treat that edit as current instead of spending money re-planning it the moment it opens.
export function adoptExistingAsRan(P = PROJECT) {
  if (!P || (P.keys && P.keys.plan)) return false;
  if (!(P.pieces || []).length && !(P.keep_segments || []).length) return false;
  P.keys = snapshot(P);
  if (!(P.renders || []).length) P.keys.render = null;
  return true;
}

export const planStale = (P = PROJECT) => !!(P && P.source.inputs.length && P.keys && P.keys.plan !== planKey(P));
export const renderStale = (P = PROJECT) => !!(P && P.keys && P.keys.render && P.keys.render !== renderKey(P));

// Fingerprints as they stand right now. Jobs snapshot this when they are submitted.
export function snapshot(P = PROJECT) { return { src: srcKey(P), plan: planKey(P), render: renderKey(P) }; }

// Record that a stage ran. `keys` must be the snapshot taken when the job was SUBMITTED,
// not the current one: if the settings changed while the job was running, the result is
// already out of date and the next assess() has to see that.
export function markRan(stage, keys = null, P = PROJECT) {
  if (!P.keys) P.keys = { src: null, plan: null, render: null };
  const k = keys || snapshot(P);
  if (stage === "plan") { P.keys.src = k.src; P.keys.plan = k.plan; }
  if (stage === "render") P.keys.render = k.render;
}

// ─────────────── the loop ───────────────
export const isOn = () => localStorage.getItem("ave.autorun") !== "off";
let timer = null, warnedNoKey = false;
// Set while a job this module started is in flight, so a newer change may cancel it but
// a Render the user asked for is never interrupted.
let autoJob = null;
export const setAutoJob = (id) => { autoJob = id; };
export const isAutoJob = (id) => autoJob != null && autoJob === id;

// deps are injected by initAutoRun to avoid a cycle with jobs.js
let deps = null;

function canRun() {
  const P = PROJECT;
  if (!isOn() || !P || !P.source.inputs.length) return false;
  const prov = ((P.options || {}).director || {}).provider;
  if (!BOOT.keys || !BOOT.keys[prov]) {
    if (!warnedNoKey) {
      warnedNoKey = true;
      showAlert("auth", `<b>No ${PROVIDER_NAMES[prov] || prov} API key set.</b> Add one via the key pill in the top bar — the editor updates itself once a key is there.`);
    }
    return false;
  }
  warnedNoKey = false;
  return true;
}

export function assess() {
  paintStatus();
  if (!planStale() || !canRun()) return;
  clearTimeout(timer);
  timer = setTimeout(run, DEBOUNCE_MS);
}

async function run() {
  if (!planStale() || !canRun()) { paintStatus(); return; }
  // A newer change supersedes an auto-plan that is still running; a job the user started
  // is never interrupted — we wait for it and try again rather than dropping the update.
  if (deps.busy()) {
    if (!isAutoJob(deps.currentJobId())) { clearTimeout(timer); timer = setTimeout(run, DEBOUNCE_MS); return; }
    try { await deps.cancel(deps.currentJobId()); } catch { /* already finished */ }
  }
  deps.submit("plan", { auto: true });
}

// ─────────────── status pill ───────────────
export function paintStatus() {
  const el = byId("run-state"); if (!el) return;
  const P = PROJECT;
  if (!P || !P.source.inputs.length) { el.textContent = ""; el.className = "pill"; return; }
  if (deps && deps.busy()) { el.textContent = "updating…"; el.className = "pill busy"; return; }
  if (planStale()) { el.textContent = isOn() ? "updating…" : "cuts out of date"; el.className = "pill warn"; return; }
  if (!P.keys.plan) { el.textContent = "not analyzed yet"; el.className = "pill"; return; }
  el.textContent = renderStale() ? "edit changed since the render" : "up to date";
  el.className = renderStale() ? "pill warn" : "pill ok";
}

export function initAutoRun(d) {
  deps = d;
  const btn = byId("btn-autorun");
  const paintBtn = () => {
    btn.classList.toggle("on", isOn());
    btn.textContent = isOn() ? "⟳ Auto" : "⏸ Auto";
    btn.title = isOn()
      ? "Changes re-run the AI editor automatically. Click to pause."
      : "Automatic updates are paused — use ↻ Re-plan in the Cuts panel. Click to resume.";
  };
  btn.onclick = () => { localStorage.setItem("ave.autorun", isOn() ? "off" : "on"); paintBtn(); assess(); };
  paintBtn();

  on("dirty", assess);          // widest hook: every settings/chip/media change lands here
  on("clips", assess);
  on("source", assess);
  on("project", () => { clearTimeout(timer); warnedNoKey = false; paintStatus(); });
  on("job", assess);            // a job settling may leave an update still owed
  paintStatus();
}
