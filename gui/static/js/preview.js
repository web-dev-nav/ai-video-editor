// Preview player: plays the source while skipping cut ranges (or the rendered output),
// drives the timeline playhead, and roughly previews voiceover cues + music.
import * as api from "./api.js";
import { byId, mmss, mmssd, esc } from "./ui.js";
import { PROJECT, on, emit, srcToOut, outToSrc, segAtSrc, segments, hasCuts, outDuration } from "./state.js";
import { disp } from "./translit.js";

const video = () => byId("preview");
let mode = "source";       // source | output
let outputPath = null;
let curSeg = -1;
let raf = null;
let cueAudio = new Map();  // cue.id -> Audio
let musicEl = null;
let lastOut = 0;
// Multi-clip sequence played from the separate files (until a job has combined them):
let seq = null;          // [{path, s, e}] in source time, or null when playing a single file
let seqIdx = 0;          // which clip is loaded
let pendingLocal = null; // seek to apply once the newly loaded clip has metadata

export function currentOut() { return lastOut; }

// ─────────────── preview zoom & pan ───────────────
// Magnifies the frame itself (CSS transform) so a detail can be inspected; the
// rendered file is untouched. Pan offsets are screen pixels from the centre.
const ZMIN = 1, ZMAX = 8;
let zoom = 1, panX = 0, panY = 0;
const stage = () => byId("stage");

function clampPan() {
  const v = video(), w = v.offsetWidth || 0, h = v.offsetHeight || 0;
  const mx = (w * (zoom - 1)) / 2, my = (h * (zoom - 1)) / 2;
  panX = Math.max(-mx, Math.min(mx, panX));
  panY = Math.max(-my, Math.min(my, panY));
}
function applyZoom() {
  const v = video();
  clampPan();
  v.style.transform = zoom === 1 ? "" : `scale(${zoom}) translate(${panX / zoom}px, ${panY / zoom}px)`;
  v.classList.toggle("zoomed", zoom > 1);
  byId("btn-zoom-reset").textContent = `${Math.round(zoom * 100)}%`;
  byId("btn-zoom-out").disabled = zoom <= ZMIN + 1e-6;
  byId("btn-zoom-in").disabled = zoom >= ZMAX - 1e-6;
}
// Zoom to `z`, keeping the content under (cx, cy) — viewport coords — in place.
export function setZoom(z, cx, cy) {
  const v = video(), z1 = zoom;
  const z2 = Math.max(ZMIN, Math.min(ZMAX, z));
  if (Math.abs(z2 - z1) < 1e-6) return;
  if (cx != null) {
    const r = v.getBoundingClientRect();
    const dx = cx - (r.left + r.width / 2), dy = cy - (r.top + r.height / 2);
    panX = dx - (z2 / z1) * (dx - panX);
    panY = dy - (z2 / z1) * (dy - panY);
  }
  zoom = z2;
  if (zoom === 1) { panX = 0; panY = 0; }
  applyZoom();
}
export function resetZoom() { zoom = 1; panX = 0; panY = 0; applyZoom(); }

function buildSeq() {
  const P = PROJECT;
  if (mode === "output" || P.source.pipeline_input || (P.source.clips || []).length < 2) { seq = null; return; }
  let off = 0; seq = P.source.clips.map((c) => { const s = off; off += c.duration_sec || 0; return { path: c.path, s, e: off }; });
}
const clipAt = (t) => { let i = seq.findIndex((c) => t < c.e); return i < 0 ? seq.length - 1 : i; };
// Load clip `i` and seek to `local` seconds inside it.
function loadClip(i, local, play) {
  const v = video(); seqIdx = i;
  const want = api.media(seq[i].path);
  if (v.getAttribute("src") !== want) { pendingLocal = { t: local, play }; v.src = want; v.load(); }
  else { v.currentTime = local; if (play) v.play(); }
}
export function isPlaying() { const v = video(); return v && !v.paused && !v.ended; }

export function setSource(path) {
  const v = video();
  byId("stage-empty").hidden = !!path;
  v.hidden = !path;
  resetZoom();
  buildSeq();
  if (!path) { v.removeAttribute("src"); return; }
  const want = api.media(seq ? seq[0].path : path);
  if (v.getAttribute("src") !== want) { v.src = want; v.load(); }
  curSeg = -1; lastOut = 0;
  emit("time", 0);
}
export function setOutput(path) {
  outputPath = path;
  const b = byId("preview-src").querySelector('[data-src="output"]');
  b.hidden = !path;
}
export function setMode(m) {
  mode = m;
  byId("preview-src").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.src === m));
  stopExtras();
  if (m === "output" && outputPath) { setSource(outputPath); byId("preview-note").textContent = ""; }
  else { setSource(PROJECT.source.pipeline_input || PROJECT.source.inputs[0] || null); updateNote(); }
}
function updateNote() {
  const n = byId("preview-note");
  if (mode === "output") return;
  if (!PROJECT.source.inputs.length) { n.textContent = ""; return; }
  n.textContent = "";
}

// Seek to an EDITED-timeline time.
export function seekOut(t) {
  const v = video(); if (!v.src) return;
  const src = Math.max(0, mode === "output" ? t : outToSrc(t));
  if (seq) { const i = clipAt(src); loadClip(i, src - seq[i].s, !v.paused); }
  else v.currentTime = src;
  curSeg = mode === "output" ? -1 : segAtSrc(src);
  tick(true);
}
export function seekSrc(t) { const v = video(); if (!v.src) return; t = Math.max(0, t); if (seq) { const i = clipAt(t); loadClip(i, t - seq[i].s, !v.paused); } else v.currentTime = t; curSeg = segAtSrc(t); tick(true); }
// Source time of the current playback position (clip offset added when playing separate files).
const srcNow = () => { const v = video(); return seq ? seq[seqIdx].s + v.currentTime : v.currentTime; };
// Move playback to source time `t` (may switch clip).
function jumpSrc(t, play = true) { const v = video(); if (seq) { const i = clipAt(t); loadClip(i, t - seq[i].s, play); } else v.currentTime = t; }
export function togglePlay() { const v = video(); if (!v.src) return; if (v.paused) v.play(); else v.pause(); }

// Called every animation frame while playing (and on seeks): enforce cuts, publish time.
function tick(force = false) {
  const v = video(); if (!v || !v.src) return;
  let t = srcNow();
  // separate clips: roll over to the next file at the end of this one
  if (seq && !v.paused && v.duration && v.currentTime >= v.duration - 0.05 && seqIdx + 1 < seq.length) { loadClip(seqIdx + 1, 0, true); t = seq[seqIdx].s; }
  if (mode === "source" && hasCuts()) {
    const segs = segments();
    if (curSeg < 0 || t < segs[curSeg].s - 0.01 || t > segs[curSeg].e + 0.01) {
      const i = segAtSrc(t);
      if (i >= 0) curSeg = i;
      else {
        // in a cut: continue with the piece after the one we were playing (playback order), else the next by time
        let next = curSeg >= 0 && curSeg + 1 < segs.length ? curSeg + 1 : -1;
        if (next < 0) { let best = -1; segs.forEach((s, j) => { if (s.s > t && (best < 0 || s.s < segs[best].s)) best = j; }); next = best; }
        if (next >= 0) { curSeg = next; jumpSrc(segs[next].s, !v.paused); t = segs[next].s; }
        else { v.pause(); jumpSrc(segs[segs.length - 1].e, false); t = segs[segs.length - 1].e; curSeg = segs.length - 1; }
      }
    } else if (t >= segs[curSeg].e - 0.02 && !v.paused) {
      if (curSeg + 1 < segs.length) { curSeg++; jumpSrc(segs[curSeg].s, true); t = segs[curSeg].s; }
      else { v.pause(); }
    }
  }
  const out = mode === "output" ? t : srcToOut(t);
  if (force || Math.abs(out - lastOut) > 0.02) { lastOut = out; emit("time", out); }
  byId("time-out").textContent = mmssd(out);
  if (mode === "source" && !v.paused) playExtras(out);
  if (!v.paused && !v.ended) raf = requestAnimationFrame(() => tick());
}

// ─────────────── approximate voiceover + music preview ───────────────
function extrasOn() { return byId("preview-mix").checked && mode === "source"; }
function playExtras(out) {
  if (!extrasOn()) return;
  for (const c of PROJECT.voiceover.enabled ? PROJECT.voiceover.cues : []) {
    if (!c.audio || c.status === "stale") continue;
    let a = cueAudio.get(c.id);
    if (!a) { a = new Audio(api.media(c.audio)); a.preload = "auto"; cueAudio.set(c.id, a); }
    const dur = (c.duration_sec || 1) / (c.tempo || 1);
    const within = out >= c.start && out < c.start + dur;
    if (within && a.paused && !a._done) {
      a.currentTime = Math.max(0, (out - c.start) * (c.tempo || 1));
      a.playbackRate = c.tempo || 1;
      a.volume = Math.min(1, Math.pow(10, (PROJECT.voiceover.gain_db || 0) / 20));
      a.play().catch(() => {}); a._done = true;
    } else if (!within && !a.paused) { a.pause(); a._done = false; }
    else if (!within) a._done = false;
  }
  const m = PROJECT.music;
  if (m.enabled && m.path) {
    if (!musicEl || musicEl._path !== m.path) { if (musicEl) musicEl.pause(); musicEl = new Audio(api.media(m.path)); musicEl._path = m.path; musicEl.loop = !!m.loop; }
    musicEl.volume = Math.min(1, Math.pow(10, (m.gain_db || 0) / 20));
    if (musicEl.paused) { const off = (m.start_offset_sec || 0) + out; musicEl.currentTime = musicEl.duration ? (m.loop ? off % musicEl.duration : Math.min(off, musicEl.duration)) : off; musicEl.play().catch(() => {}); }
  } else if (musicEl && !musicEl.paused) musicEl.pause();
}
function stopExtras() {
  for (const a of cueAudio.values()) { a.pause(); a._done = false; }
  if (musicEl) musicEl.pause();
}
export function resetCueAudio(id) { const a = cueAudio.get(id); if (a) { a.pause(); cueAudio.delete(id); } }

// ─────────────── wiring ───────────────
export function initPreview() {
  const v = video();
  v.addEventListener("play", () => { byId("btn-play").textContent = "⏸"; cancelAnimationFrame(raf); tick(true); });
  v.addEventListener("pause", () => { byId("btn-play").textContent = "▶"; cancelAnimationFrame(raf); stopExtras(); tick(true); });
  v.addEventListener("seeking", () => { stopExtras(); curSeg = mode === "output" ? -1 : segAtSrc(srcNow()); });
  v.addEventListener("seeked", () => tick(true));
  v.addEventListener("loadedmetadata", () => {
    if (pendingLocal) { const p = pendingLocal; pendingLocal = null; v.currentTime = p.t; if (p.play) v.play().catch(() => {}); }
    updateTotal(); tick(true);
  });
  v.addEventListener("ended", () => { if (seq && seqIdx + 1 < seq.length) { loadClip(seqIdx + 1, 0, true); return; } byId("btn-play").textContent = "▶"; stopExtras(); });
  // click toggles play — unless the click was really a pan drag
  let dragged = false, panFrom = null;
  v.addEventListener("click", () => { if (!dragged) togglePlay(); dragged = false; });
  v.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragged = false;
    if (zoom <= 1) return;
    panFrom = { x: e.clientX, y: e.clientY, px: panX, py: panY };
    v.setPointerCapture(e.pointerId);
  });
  v.addEventListener("pointermove", (e) => {
    if (!panFrom) return;
    const dx = e.clientX - panFrom.x, dy = e.clientY - panFrom.y;
    if (!dragged && Math.abs(dx) + Math.abs(dy) > 4) dragged = true;
    if (!dragged) return;
    panX = panFrom.px + dx; panY = panFrom.py + dy; applyZoom();
  });
  v.addEventListener("pointerup", (e) => { if (panFrom) { v.releasePointerCapture(e.pointerId); panFrom = null; } });
  stage().addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey) || !v.src) return;
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY);
  }, { passive: false });
  byId("btn-zoom-in").onclick = () => setZoom(zoom * 1.5);
  byId("btn-zoom-out").onclick = () => setZoom(zoom / 1.5);
  byId("btn-zoom-reset").onclick = resetZoom;
  window.addEventListener("resize", applyZoom);
  applyZoom();
  byId("btn-play").onclick = togglePlay;
  byId("btn-stop").onclick = () => { seekOut(0); };
  byId("preview-src").querySelectorAll("button").forEach((b) => (b.onclick = () => setMode(b.dataset.src)));
  byId("preview-mix").addEventListener("change", () => { if (!byId("preview-mix").checked) stopExtras(); });
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select") || e.target.isContentEditable) return;
    if (e.code === "Space") { e.preventDefault(); togglePlay(); }
    if (e.code === "ArrowLeft") { e.preventDefault(); seekOut(Math.max(0, lastOut - (e.shiftKey ? 5 : 1))); }
    if (e.code === "ArrowRight") { e.preventDefault(); seekOut(lastOut + (e.shiftKey ? 5 : 1)); }
    if (e.code === "Home") { e.preventDefault(); seekOut(0); }
    if (e.key === "+" || e.key === "=") { e.preventDefault(); setZoom(zoom * 1.5); }
    if (e.key === "-" || e.key === "_") { e.preventDefault(); setZoom(zoom / 1.5); }
    if (e.key === "0") { e.preventDefault(); resetZoom(); }
  });
  on("source", () => { if (mode === "output") setMode("source"); else setSource(PROJECT.source.pipeline_input || PROJECT.source.inputs[0] || null); setOutput(null); updateNote(); updateTotal(); });
  on("project", () => { setOutput(null); setMode("source"); updateTotal(); });
  on("pieces", () => { curSeg = segAtSrc(srcNow()); updateNote(); updateTotal(); tick(true); });
  on("clips", () => { const was = seq; buildSeq(); if (!!was !== !!seq || (seq && was && seq.map((c) => c.path).join() !== was.map((c) => c.path).join())) { seqIdx = 0; setSource(PROJECT.source.pipeline_input || PROJECT.source.inputs[0] || null); } updateTotal(); });
  on("cues", () => { for (const a of cueAudio.values()) a.pause(); cueAudio.clear(); });
  on("seek", (t) => seekOut(t));
  on("render-done", (r) => { setOutput(r.output_video); setMode("output"); });
}
function updateTotal() {
  const v = video();
  const total = mode === "output" ? (v.duration || 0) : (hasCuts() ? outDuration() : (PROJECT.source.duration_sec || v.duration || 0));
  byId("time-total").textContent = mmss(total);
}

// ─────────────── transcript strip ───────────────
export function renderTranscript() {
  const box = byId("transcript"), tr = PROJECT.transcript;
  if (!tr || !tr.length) { box.innerHTML = `<span class="empty">Transcript</span>`; return; }
  box.innerHTML = tr.map((t, i) => `<span class="seg${hasCuts() && segAtSrc((t.start + t.end) / 2) < 0 ? " cut" : ""}" data-i="${i}" title="${mmss(t.start)}">${esc(disp(t.text))}</span> `).join("");
  box.querySelectorAll(".seg").forEach((el) => (el.onclick = () => { const t = tr[+el.dataset.i]; seekSrc(t.start); }));
}
export function highlightTranscript(out) {
  const tr = PROJECT.transcript; if (!tr || !tr.length) return;
  const src = outToSrc(out);
  const els = byId("transcript").querySelectorAll(".seg");
  let cur = -1; tr.forEach((t, i) => { if (src >= t.start && src <= t.end + 0.3) cur = i; });
  els.forEach((el, i) => el.classList.toggle("now", i === cur));
  if (cur >= 0 && isPlaying()) { const el = els[cur]; const box = byId("transcript"); if (el.offsetTop < box.scrollTop || el.offsetTop > box.scrollTop + box.clientHeight - 20) box.scrollTop = el.offsetTop - 20; }
}
