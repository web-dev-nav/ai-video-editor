// Multi-track timeline: ruler + Video (kept pieces / cut markers), Voiceover cues, Music.
import { byId, esc, mmss, clamp, baseName } from "./ui.js";
import { PROJECT, SEL, on, emit, select, srcToOut, outDuration, hasCuts, markDirty, outToSrc, round3, segments, segAtSrc } from "./state.js";
import { disp } from "./translit.js";
import { reorderClip, addClip, removeClip } from "./browser.js";

const CLIP_COLORS = ["#2f3d5c", "#3b3358", "#2f4a4a", "#4a3a2f", "#3a4a2f", "#4a2f3f"];
function clipSpans() {   // [{i, name, path, s, e}] in SOURCE time (the combined timeline)
  let off = 0; return (PROJECT.source.clips || []).map((c, i) => { const s = off; off += c.duration_sec || 0; return { i, name: c.name, path: c.path, s, e: off }; });
}

let pxPerSec = 12;
const MIN_PX = 1, MAX_PX = 400;
const scroll = () => byId("tl-scroll"), inner = () => byId("tl-inner");
let lastOut = 0;

function totalSec() { return Math.max(1, outDuration() || PROJECT.source.duration_sec || 60); }
function width() { return Math.max(scroll().clientWidth, Math.ceil(totalSec() * pxPerSec) + 40); }
const x = (t) => t * pxPerSec;

export function render() {
  const P = PROJECT, W = width();
  inner().style.width = W + "px";
  renderRuler(W);
  // ── video track
  const tv = byId("tl-video"); tv.innerHTML = "";
  if (!P.source.inputs.length) tv.innerHTML = ``;
  else if (!hasCuts()) {
    // One block per clip, in sequence order; drag to reorder.
    const spans = clipSpans().length ? clipSpans() : [{ i: 0, name: baseName(P.source.inputs[0]), path: P.source.inputs[0], s: 0, e: totalSec() }];
    spans.forEach((c) => {
      const b = document.createElement("div"); b.className = "blk clip"; b.style.left = x(c.s) + "px"; b.style.width = Math.max(2, x(c.e) - x(c.s) - 2) + "px";
      b.style.background = CLIP_COLORS[c.i % CLIP_COLORS.length];
      b.innerHTML = `${c.i + 1}. ${esc(c.name)}<small>${mmss(c.e - c.s)}${spans.length === 1 ? ` · ${P.mode === "ai" ? "Ask AI for a plan" : "Analyze"} to see cuts` : ""}</small><button class="x" title="Remove this clip from the timeline">✕</button>`;
      b.title = spans.length > 1 ? `${c.name} · drag to reorder · ✕ to remove` : `${c.name} · ✕ to remove`;
      b.ondblclick = () => emit("seek", c.s);
      if (spans.length > 1) makeClipDraggable(b, c, spans);
      wireClipRemove(b, c);
      tv.appendChild(b);
    });
  } else {
    if ((P.source.clips || []).length > 1) {   // which clip each part of the edit came from
      const lane = document.createElement("div"); lane.className = "clip-lane";
      clipSpans().forEach((c) => { const a = srcToOut(c.s), b = srcToOut(c.e); if (b - a < 0.01) return; const s = document.createElement("span"); s.style.left = x(a) + "px"; s.style.width = Math.max(1, x(b) - x(a) - 1) + "px"; s.style.background = CLIP_COLORS[c.i % CLIP_COLORS.length]; s.textContent = `${c.i + 1}. ${c.name}`; s.title = c.name; lane.appendChild(s); });
      tv.appendChild(lane); tv.classList.add("with-lane");
    } else tv.classList.remove("with-lane");
    const pieces = P.pieces.length ? P.pieces : P.keep_segments.map((k, i) => ({ id: "s" + i, kind: "kept", start: k.start, end: k.end, enabled: true, text: "" }));
    // Kept blocks tile the finalized keep segments exactly, so the boundary padding the
    // server adds around each range shows up as part of its block instead of as a gap.
    const segs = segments(), bySeg = segs.map(() => []);
    for (const p of pieces.filter((p) => p.enabled)) {
      const i = segAtSrc((p.start + p.end) / 2);
      if (i >= 0) bySeg[i].push(p);
    }
    segs.forEach((m, i) => {
      const segStart = m.off, segEnd = m.off + (m.e - m.s);
      const ps = bySeg[i].sort((a, b) => a.start - b.start);
      if (!ps.length) { tv.appendChild(keptBlock({ id: "s" + i, kind: "kept", start: m.s, end: m.e, text: "" }, segStart, segEnd)); return; }
      ps.forEach((p, j) => {
        const a = j === 0 ? segStart : srcToOut(p.start);
        const b = j === ps.length - 1 ? segEnd : srcToOut(ps[j + 1].start);
        tv.appendChild(keptBlock(p, a, b));
      });
    });
    for (const p of pieces.filter((p) => !p.enabled)) {
      const a = srcToOut(p.start);
      const el = document.createElement("div"); el.className = "cutmark" + (SEL.kind === "piece" && SEL.id === p.id ? " selected" : "");
      el.style.left = x(a) + "px"; el.title = `Cut: ${mmss(p.start)}–${mmss(p.end)} · ${p.reason || ""} · ${disp(p.text || "").slice(0, 80)}`;
      el.onclick = (e) => { e.stopPropagation(); select("piece", p.id); };
      tv.appendChild(el);
    }
  }
  // ── voiceover track
  const tvo = byId("tl-vo"); tvo.innerHTML = "";
  const cues = P.voiceover.enabled ? P.voiceover.cues.slice().sort((a, b) => a.start - b.start) : [];
  if (!cues.length) tvo.innerHTML = P.voiceover.cues.length && !P.voiceover.enabled ? `<span class="empty">voiceover off</span>` : ``;
  cues.forEach((c, i) => {
    const dur = c.duration_sec ? c.duration_sec / (c.tempo || 1) : Math.max(1, (c.text || "").length / 12);
    const next = cues[i + 1];
    const slot = c.end != null && c.end > c.start ? c.end - c.start : next ? next.start - c.start : null;
    const overrun = slot != null && dur > slot + 0.05 && (P.voiceover.fit !== "tempo" || dur / slot > (P.voiceover.max_tempo || 1.3));
    const el = document.createElement("div");
    el.className = `blk cue ${c.status || "pending"}${overrun ? " overrun" : ""}${SEL.kind === "cue" && SEL.id === c.id ? " selected" : ""}`;
    el.style.left = x(c.start) + "px"; el.style.width = Math.max(6, x(dur)) + "px";
    el.title = `${mmss(c.start)} · ${c.status || "not generated"}${overrun ? " · longer than its slot" : ""}\n${disp(c.text)}`;
    el.innerHTML = `${esc(disp(c.text))}<small>${mmss(c.start)}${c.duration_sec ? ` · ${c.duration_sec.toFixed(1)}s` : " · not generated"}</small>`;
    el.onclick = (e) => { e.stopPropagation(); select("cue", c.id); };
    el.ondblclick = () => emit("seek", c.start);
    makeDraggable(el, c);
    tvo.appendChild(el);
  });
  // ── music track
  const tm = byId("tl-music"); tm.innerHTML = "";
  const m = P.music;
  if (m.path) {
    const total = totalSec();
    const len = m.loop ? total : Math.max(0.5, Math.min(total, (m.duration_sec || total) - (m.start_offset_sec || 0)));
    const el = document.createElement("div"); el.className = `blk music${m.enabled ? "" : " off"}${SEL.kind === "music" ? " selected" : ""}`;
    el.style.left = "0px"; el.style.width = x(len) + "px";
    el.innerHTML = `♫ ${esc(baseName(m.path))} <small>${m.gain_db} dB${m.loop ? " · loop" : ""}${m.duck ? " · ducked" : ""}${m.enabled ? "" : " · OFF"}</small>`;
    el.onclick = (e) => { e.stopPropagation(); select("music", "music"); };
    tm.appendChild(el);
  } else tm.innerHTML = ``;
  setPlayhead(lastOut);
}

// One kept/restored block spanning [a, b] on the EDITED timeline.
function keptBlock(p, a, b) {
  const el = document.createElement("div");
  el.className = `blk ${p.kind === "kept" ? "kept" : "restored"}${SEL.kind === "piece" && SEL.id === p.id ? " selected" : ""}`;
  el.style.left = x(a) + "px"; el.style.width = Math.max(2, x(b) - x(a)) + "px";
  el.title = `${mmss(p.start)}–${mmss(p.end)} (source) · ${disp(p.text) || ""}`;
  el.innerHTML = `${esc(disp(p.text) || (p.kind === "kept" ? "kept" : "restored"))}<small>${mmss(a)} · ${(b - a).toFixed(1)}s</small>`;
  el.onclick = (e) => { e.stopPropagation(); select("piece", p.id); };
  el.ondblclick = () => emit("seek", a);
  return el;
}

// ✕ on a clip block — takes the clip out of the sequence without going back to 📁 Media.
function wireClipRemove(el, clip) {
  const btn = el.querySelector(".x");
  if (!btn || !clip.path) { if (btn) btn.remove(); return; }
  btn.addEventListener("pointerdown", (e) => e.stopPropagation());   // don't start a reorder drag
  btn.onclick = (e) => {
    e.stopPropagation();
    if (PROJECT.transcript && !confirm(`Remove "${clip.name}" from the timeline? The transcript for this source is discarded.`)) return;
    removeClip(clip.path);
  };
}

function renderRuler(W) {
  const r = byId("tl-ruler"); r.innerHTML = "";
  const total = W / pxPerSec;
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  let major = steps.find((s) => s * pxPerSec >= 70) || 600;
  const minor = major / (major >= 60 ? 4 : major >= 10 ? 5 : 2);
  const frag = document.createDocumentFragment();
  for (let t = 0; t <= total; t = round3(t + minor)) {
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    const d = document.createElement("div"); d.className = "tick" + (isMajor ? "" : " minor"); d.style.left = x(t) + "px";
    if (isMajor) d.textContent = mmss(t);
    frag.appendChild(d);
  }
  r.appendChild(frag);
}

export function setPlayhead(out) {
  lastOut = out;
  const ph = byId("tl-playhead"); ph.style.transform = `translateX(${x(out)}px)`;
  // keep the playhead visible while playing
  const s = scroll(), px = x(out) - s.scrollLeft;
  if (px > s.clientWidth - 30) s.scrollLeft = x(out) - s.clientWidth * 0.2;
  else if (px < 0) s.scrollLeft = Math.max(0, x(out) - 30);
}

function makeClipDraggable(el, clip, spans) {
  let startX = 0, moved = false, ghost = null;
  el.addEventListener("pointerdown", (e) => { if (e.button !== 0) return; startX = e.clientX; moved = false; el.setPointerCapture(e.pointerId); });
  el.addEventListener("pointermove", (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    const dx = e.clientX - startX;
    if (!moved && Math.abs(dx) > 4) { moved = true; el.classList.add("dragging"); }
    if (!moved) return;
    el.style.transform = `translateX(${dx}px)`;
    // highlight the slot the clip would land in
    const centre = clip.s + (clip.e - clip.s) / 2 + dx / pxPerSec;
    const to = targetIndex(centre, spans, clip.i);
    ghost = ghost || Object.assign(document.createElement("div"), { className: "drop-slot" });
    const slotT = to <= clip.i ? spans[to].s : spans[to].e;
    ghost.style.left = x(slotT) + "px"; if (!ghost.parentNode) el.parentNode.appendChild(ghost);
  });
  el.addEventListener("pointerup", (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    el.releasePointerCapture(e.pointerId); el.classList.remove("dragging"); el.style.transform = "";
    if (ghost) { ghost.remove(); ghost = null; }
    if (!moved) return;
    const centre = clip.s + (clip.e - clip.s) / 2 + (e.clientX - startX) / pxPerSec;
    reorderClip(clip.i, targetIndex(centre, spans, clip.i));
  });
}
// Index a clip should move to so that its centre lands at source time `t`.
function targetIndex(t, spans, from) {
  let to = spans.length - 1;
  for (const s of spans) { if (s.i === from) continue; if (t < (s.s + s.e) / 2) { to = s.i; break; } }
  if (t >= (spans[spans.length - 1].s + spans[spans.length - 1].e) / 2) to = spans.length - 1;
  return to > from ? to : to;
}

function makeDraggable(el, cue) {
  let startX = 0, startT = 0, moved = false;
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    startX = e.clientX; startT = cue.start; moved = false; el.setPointerCapture(e.pointerId);
  });
  el.addEventListener("pointermove", (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    const dt = (e.clientX - startX) / pxPerSec;
    if (Math.abs(e.clientX - startX) > 3) moved = true;
    if (!moved) return;
    const nt = clamp(Math.round((startT + dt) * 20) / 20, 0, totalSec());
    if (nt !== cue.start) { cue.start = nt; el.style.left = x(nt) + "px"; el.querySelector("small").textContent = mmss(nt) + (cue.duration_sec ? ` · ${cue.duration_sec.toFixed(1)}s` : ""); }
  });
  el.addEventListener("pointerup", (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    el.releasePointerCapture(e.pointerId);
    if (moved) { cue.src = round3(outToSrc(cue.start)); if (cue.end != null && cue.end <= cue.start) cue.end = null; markDirty("cue-move"); emit("cues"); select("cue", cue.id); }
  });
}

function zoom(factor, anchorX) {
  const s = scroll();
  const ax = anchorX == null ? s.clientWidth / 2 : anchorX;
  const tAtAnchor = (s.scrollLeft + ax) / pxPerSec;
  pxPerSec = clamp(pxPerSec * factor, MIN_PX, MAX_PX);
  render();
  s.scrollLeft = Math.max(0, tAtAnchor * pxPerSec - ax);
}
export function fit() { pxPerSec = clamp((scroll().clientWidth - 40) / totalSec(), MIN_PX, MAX_PX); render(); scroll().scrollLeft = 0; }

export function initTimeline() {
  const s = scroll();
  byId("tl-zoom-in").onclick = () => zoom(1.5);
  byId("tl-zoom-out").onclick = () => zoom(1 / 1.5);
  byId("tl-fit").onclick = fit;
  s.addEventListener("wheel", (e) => {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoom(e.deltaY < 0 ? 1.25 : 0.8, e.clientX - s.getBoundingClientRect().left); }
    else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { s.scrollLeft += e.deltaY; e.preventDefault(); }
  }, { passive: false });
  // scrub on the ruler (click + drag)
  const ruler = byId("tl-ruler");
  let scrubbing = false;
  const scrubTo = (e) => { const t = clamp((e.clientX - inner().getBoundingClientRect().left) / pxPerSec, 0, totalSec()); emit("seek", t); };
  ruler.addEventListener("pointerdown", (e) => { scrubbing = true; ruler.setPointerCapture(e.pointerId); scrubTo(e); });
  ruler.addEventListener("pointermove", (e) => { if (scrubbing) scrubTo(e); });
  ruler.addEventListener("pointerup", (e) => { scrubbing = false; ruler.releasePointerCapture(e.pointerId); });
  // click on empty track space = deselect + seek
  for (const id of ["tl-video", "tl-vo", "tl-music"]) byId(id).addEventListener("click", (e) => { if (e.target.id === id) { select(null, null); scrubTo(e); } });
  // drop a file from the Files list onto the video track to add it to the sequence
  const tv = byId("tl-video");
  tv.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/ave-path")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; tv.classList.add("drop-over"); } });
  tv.addEventListener("dragleave", () => tv.classList.remove("drop-over"));
  tv.addEventListener("drop", (e) => { tv.classList.remove("drop-over"); const p = e.dataTransfer.getData("text/ave-path"); if (p) { e.preventDefault(); addClip(p); } });
  on("time", setPlayhead);
  on("pieces", render); on("cues", render); on("music", render); on("selection", render); on("tags", render); on("roman", render); on("clips", render);
  on("source", () => { fit(); });
  on("project", () => { fit(); });
  window.addEventListener("resize", () => render());
  fit();
}
