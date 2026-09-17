// Single project state + a tiny event bus + the source↔edited time map.
import { uid, debounce } from "./ui.js";

export let BOOT = null;          // /api/bootstrap payload
export let DEFAULTS = null;      // config.default.yml as sent by the server
export function setBoot(b) { BOOT = b; DEFAULTS = b.defaults; }

export let PROJECT = null;
export const SEL = { kind: null, id: null };   // {kind: piece|cue|music, id}

const listeners = {};
export function on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); }
export function emit(ev, data) { for (const fn of listeners[ev] || []) { try { fn(data); } catch (e) { console.error(ev, e); } } }

export function newProject(name = "") {
  const d = DEFAULTS || {};
  const vo = d.voiceover || {}, mu = d.music || {}, mx = d.mix || {};
  const tts = (BOOT && BOOT.tts) || {};
  const engines = tts.engines || {};
  const engine = engines.openai && engines.openai.available ? "openai" : engines.edge && engines.edge.available ? "edge" : engines.kokoro && engines.kokoro.available ? "kokoro" : "edge";
  PROJECT = {
    version: 1, id: "p_" + uid("").slice(0, 8), name, created: null, updated: null,
    source: { inputs: [], pipeline_input: null, duration_sec: 0, width: 0, height: 0, derived_from: null },
    mode: "ai",                          // the AI editor is the only editing mode
    keys: { src: null, plan: null, render: null },   // fingerprints of the last run of each stage (see autorun.js)
    options: null,                       // filled by settings.collectOptions()
    output: "",
    skill_briefs: {},                    // skill id → edited brief, overriding skills/<id>.md for this project
    plan: null, plan_cost: null,         // director plan + the cost of the call that produced it
    transcript: null,                    // [{start,end,text}] in SOURCE time
    pieces: [],                          // [{id, kind: kept|removed, start, end, text, note, reason, enabled}] (source time)
    keep_segments: [],                   // finalized, source time, playback order
    keep_exact: false,                   // true when keep_segments came from the Auto rules (render exactly)
    voiceover: { enabled: false, engine, model: vo.model || "gpt-4o-mini-tts", voice: (tts.default_voice || {})[engine] || vo.voice || "", speed: 1.0,
                 instructions: vo.instructions || tts.default_instructions || "", mix_mode: "narrate", fit: "tempo", max_tempo: 1.3,
                 gain_db: 0, duck_original_db: -12, cues: [] },
    music: { enabled: false, path: "", gain_db: mu.gain_db ?? -18, fade_in_sec: mu.fade_in_sec ?? 2, fade_out_sec: mu.fade_out_sec ?? 3,
             start_offset_sec: 0, loop: true, duck: true, duck_db: -12, duration_sec: 0 },
    mix: { original_gain_db: 0, loudnorm: false, loudness_target: -14 },
    renders: [], cost: null,
  };
  SEL.kind = null; SEL.id = null;
  rebuildTimeMap();
  emit("project");
  return PROJECT;
}

export function loadProject(p) {
  PROJECT = p;
  PROJECT.pieces = PROJECT.pieces || [];
  PROJECT.keep_segments = PROJECT.keep_segments || [];
  PROJECT.voiceover = PROJECT.voiceover || newProject().voiceover;
  PROJECT.voiceover.cues = PROJECT.voiceover.cues || [];
  if (PROJECT.voiceover.enabled == null) PROJECT.voiceover.enabled = PROJECT.voiceover.cues.length > 0;   // projects saved before the switch existed
  PROJECT.music = PROJECT.music || {};
  PROJECT.mix = PROJECT.mix || { original_gain_db: 0, loudnorm: false, loudness_target: -14 };
  PROJECT.renders = PROJECT.renders || [];
  PROJECT.skill_briefs = PROJECT.skill_briefs || {};
  PROJECT.keys = PROJECT.keys || { src: null, plan: null, render: null };
  PROJECT.mode = "ai";                 // projects saved in the old Auto mode open as AI
  SEL.kind = null; SEL.id = null;
  rebuildTimeMap();
  emit("project");
  return PROJECT;
}

// ─────────────── dirty tracking / autosave ───────────────
let dirty = false, saver = null;
export function isDirty() { return dirty; }
export function setSaver(fn) { saver = debounce(fn, 900); }
export function markDirty(what) {
  dirty = true;
  emit("dirty", what);
  if (saver) saver();
}
export function markClean() { dirty = false; emit("dirty", null); }

// ─────────────── time map: source time ↔ edited (output) time ───────────────
// keep_segments (source time, playback order) → prefix sums. With no segments the map is the identity.
let MAP = [];   // [{s, e, off}]
export function rebuildTimeMap() {
  const segs = (PROJECT && PROJECT.keep_segments) || [];
  let off = 0; MAP = [];
  for (const k of segs) { const s = +k.start, e = +k.end; if (e > s) { MAP.push({ s, e, off }); off += e - s; } }
  emit("timemap");
}
export const hasCuts = () => MAP.length > 0;
export function outDuration() { return MAP.length ? MAP[MAP.length - 1].off + (MAP[MAP.length - 1].e - MAP[MAP.length - 1].s) : (PROJECT && PROJECT.source.duration_sec) || 0; }
export function srcToOut(t) {
  if (!MAP.length) return t;
  for (const m of MAP) { if (t >= m.s && t <= m.e) return m.off + (t - m.s); }
  // inside a cut: snap to the next kept piece (in playback order after the nearest earlier one)
  let best = null;
  for (const m of MAP) { if (m.s > t && (best === null || m.s < best.s)) best = m; }
  if (best) return best.off;
  return outDuration();
}
export function outToSrc(t) {
  if (!MAP.length) return t;
  for (const m of MAP) { if (t >= m.off && t <= m.off + (m.e - m.s)) return m.s + (t - m.off); }
  const last = MAP[MAP.length - 1];
  return t < 0 ? MAP[0].s : last.e;
}
// Which kept segment (index in MAP) contains source time t, or -1.
export function segAtSrc(t) { for (let i = 0; i < MAP.length; i++) if (t >= MAP[i].s && t <= MAP[i].e) return i; return -1; }
export function segments() { return MAP; }

export function setKeepSegments(segs, exact = false) {
  PROJECT.keep_segments = segs || [];
  PROJECT.keep_exact = !!exact;
  rebuildTimeMap();
  // Re-anchor cues to the content they were written for.
  for (const c of PROJECT.voiceover.cues) {
    if (c.src != null) {
      const ns = srcToOut(c.src);
      if (Math.abs(ns - c.start) > 0.001) { c.start = round3(ns); if (c.end != null && c.src_end != null) c.end = round3(srcToOut(c.src_end)); }
    }
  }
  emit("pieces"); emit("cues");
}
export const round3 = (x) => Math.round(x * 1000) / 1000;

// ─────────────── selection ───────────────
export function select(kind, id) { SEL.kind = kind; SEL.id = id; emit("selection"); }
export function selectedPiece() { return SEL.kind === "piece" ? PROJECT.pieces.find((p) => p.id === SEL.id) : null; }
export function selectedCue() { return SEL.kind === "cue" ? PROJECT.voiceover.cues.find((c) => c.id === SEL.id) : null; }

// ─────────────── pieces ───────────────
// Ordered ranges for the render: enabled pieces, in plan order (reordered plans keep the AI's order).
export function selectedRanges() {
  const P = PROJECT, on = P.pieces.filter((p) => p.enabled);
  if (!P.plan || !P.plan.reordered) return on.slice().sort((a, b) => a.start - b.start).map((p) => ({ start: p.start, end: p.end }));
  const kept = on.filter((p) => p.kind === "kept"), restored = on.filter((p) => p.kind !== "kept").sort((a, b) => a.start - b.start);
  const ranges = kept.slice();
  for (const rp of restored) { let idx = -1; ranges.forEach((k, i) => { if (k.start < rp.start) idx = i; }); ranges.splice(idx + 1, 0, rp); }
  return ranges.map((p) => ({ start: p.start, end: p.end }));
}
export function piecesFromPlan(plan) {
  const out = [];
  (plan.keep || []).forEach((p, i) => out.push({ id: `k${i}`, kind: "kept", start: +p.start, end: +p.end, text: p.text || "", note: p.note || "", enabled: true }));
  (plan.removed || []).forEach((p, i) => out.push({ id: `r${i}`, kind: "removed", start: +p.start, end: +p.end, text: p.text || "", reason: p.reason || "", enabled: false }));
  return out;
}
// Auto mode: kept = the rule-based segments; gaps between them become removable "silence/filler" pieces.
export function piecesFromKeep(keep, total, transcript) {
  const out = [];
  const textIn = (a, b) => (transcript || []).filter((t) => t.end > a && t.start < b).map((t) => t.text).join(" ").slice(0, 300);
  let cursor = 0, n = 0;
  const segs = keep.slice().sort((a, b) => a.start - b.start);
  for (const k of segs) {
    if (k.start - cursor > 0.15) out.push({ id: `r${n++}`, kind: "removed", start: round3(cursor), end: round3(k.start), text: textIn(cursor, k.start), reason: "auto: silence / filler / restart", enabled: false });
    out.push({ id: `k${out.length}`, kind: "kept", start: +k.start, end: +k.end, text: textIn(k.start, k.end), note: "", enabled: true });
    cursor = k.end;
  }
  if (total - cursor > 0.15) out.push({ id: `r${n++}`, kind: "removed", start: round3(cursor), end: round3(total), text: textIn(cursor, total), reason: "auto: trailing silence", enabled: false });
  return out;
}
