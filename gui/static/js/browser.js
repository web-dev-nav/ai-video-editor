// File browsers (video + music), the clip sequence, uploads.
import * as api from "./api.js";
import { byId, esc, fmtSec, fitHTML, baseName, toWin } from "./ui.js";
import { BOOT, PROJECT, markDirty, emit } from "./state.js";
import { updateFormatHint } from "./settings.js";

export let clips = [];          // [{path, info}]
let cwd = null, mcwd = null;

// ─────────────── video browser ───────────────
export async function browse(path) {
  let data;
  try { data = await api.browse(path, "video"); } catch (e) { byId("list").innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  cwd = data;
  byId("crumb").textContent = data.win_path || data.path;
  byId("btn-up").disabled = !data.parent;
  const list = byId("list"); list.innerHTML = "";
  for (const d of data.dirs) { const el = document.createElement("div"); el.className = "item"; el.innerHTML = `<span>📁</span><span class="name">${esc(d.name)}</span>`; el.onclick = () => browse(d.path); list.appendChild(el); }
  for (const f of data.files) {
    const inseq = clips.some((c) => c.path === f.path);
    const el = document.createElement("div"); el.className = "item" + (inseq ? " inseq" : "");
    el.innerHTML = `<span>🎞️</span><span class="name" title="${esc(f.name)}">${esc(f.name)}</span><span class="meta">${f.size_mb} MB</span><button class="add" title="${inseq ? "Remove from sequence" : "Add to sequence"}">${inseq ? "✓" : "+"}</button>`;
    el.onclick = () => (inseq ? removeClip(f.path) : addClip(f.path)); list.appendChild(el);
    el.draggable = true; el.title = "Click to add · or drag onto the timeline";
    el.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/ave-path", f.path); e.dataTransfer.effectAllowed = "copy"; });
  }
  if (!data.dirs.length && !data.files.length) list.innerHTML = `<div class="empty">No videos or folders here.</div>`;
  localStorage.setItem("ave.cwd", data.path);
}

export async function addClip(path, quiet = false) {
  if (clips.some((c) => c.path === path || c.path === path.replace(/\\/g, "/"))) return null;
  let info;
  try { info = await api.info(path); } catch (e) { if (!quiet) alert("Could not read that file: " + e.message); return null; }
  if (clips.some((c) => c.path === info.file)) return null;
  clips.push({ path: info.file, info });
  if (!quiet) { renderClips(); if (cwd) browse(cwd.path); }
  return clips[clips.length - 1];
}
export function removeClip(path) { clips = clips.filter((c) => c.path !== path); renderClips(); if (cwd) browse(cwd.path); }
export function clearClips(silent = false) { clips = []; if (!silent) { renderClips(); if (cwd) browse(cwd.path); } }
function moveClip(i, d) { const j = i + d; if (j < 0 || j >= clips.length) return; [clips[i], clips[j]] = [clips[j], clips[i]]; renderClips(); }
// Move clip `from` so that it ends up at index `to` (timeline drag).
export function reorderClip(from, to) {
  if (from === to || from < 0 || from >= clips.length) return;
  if (PROJECT.keep_segments.length && !confirm("Reordering clips discards the current cuts (the video is analyzed again). Continue?")) { renderClips(); return; }
  const [c] = clips.splice(from, 1); clips.splice(Math.max(0, Math.min(clips.length, to)), 0, c);
  renderClips();
}

export function showInfo(c) {
  const info = c.info;
  byId("info").innerHTML = [
    ["File", esc(info.win_path || info.file)], ["Duration", fmtSec(info.duration_sec)], ["Size", `${info.size_mb} MB`],
    ["Video", info.video ? `${info.video.codec} · ${info.video.width}×${info.video.height} · ${info.video.fps} fps` : "—"],
    ["Audio", info.audio ? `${info.audio.codec} · ${info.audio.sample_rate} Hz · ${info.audio.channels} ch` : "— (no audio track!)"],
  ].map(([k, v]) => `<div>${k}</div><div>${v}</div>`).join("");
}

// Pushes the clip list into PROJECT.source and notifies everyone.
export function renderClips(silent = false) {
  const box = byId("clips");
  byId("clips-actions").hidden = !clips.length;
  const total = clips.reduce((a, c) => a + (c.info.duration_sec || 0), 0);
  byId("clips-tag").textContent = clips.length ? `${clips.length} clip${clips.length > 1 ? "s" : ""} · ${fmtSec(total)}` : "none";
  byId("clips-hint").textContent = clips.length > 1 ? "joined in this order" : "";
  box.innerHTML = clips.length ? "" : `<div class="hint">Pick a video below.</div>`;
  clips.forEach((c, i) => {
    const el = document.createElement("div"); el.className = "clip";
    el.innerHTML = `<span class="n">${i + 1}</span><span class="name" title="${esc(c.info.win_path || c.path)}">${esc(baseName(c.path))}</span><span class="meta">${fmtSec(c.info.duration_sec)}</span>
      <button title="Move up" ${i === 0 ? "disabled" : ""}>↑</button><button title="Move down" ${i === clips.length - 1 ? "disabled" : ""}>↓</button><button title="Remove" class="danger">✕</button>`;
    el.querySelector(".name").onclick = () => showInfo(c);
    const [up, down, rm] = el.querySelectorAll("button");
    up.onclick = () => moveClip(i, -1); down.onclick = () => moveClip(i, 1); rm.onclick = () => removeClip(c.path);
    box.appendChild(el);
  });
  const f = clips[0] && clips[0].info;
  if (f) {
    showInfo(clips[0]);
    byId("fit-source").innerHTML = fitHTML(total, f.video && f.video.width, f.video && f.video.height, clips.length > 1 ? "Combined source" : "Source");
  } else { byId("info").innerHTML = ""; byId("fit-source").innerHTML = ""; }

  const P = PROJECT, prev = (P.source.inputs || []).join("|"), now = clips.map((c) => c.path).join("|");
  P.source.inputs = clips.map((c) => c.path);
  P.source.clips = clips.map((c) => ({ path: c.path, name: baseName(c.path), duration_sec: c.info.duration_sec || 0 }));
  P.source.duration_sec = total; P.source.width = f && f.video ? f.video.width : 0; P.source.height = f && f.video ? f.video.height : 0;
  if (prev !== now) {
    // Different source: cuts, transcript and plan no longer apply.
    if (prev) { P.pieces = []; P.keep_segments = []; P.plan = null; P.transcript = null; P.voiceover.cues = []; }
    if (f) {
      const base = (f.win_path || f.file).replace(/\.[^.]+$/, "");
      byId("output").value = base + (clips.length > 1 ? "_combined_edited.mp4" : "_edited.mp4"); P.output = byId("output").value;
      if (!P.name) { P.name = baseName(f.file).replace(/\.[^.]+$/, ""); byId("proj-name").value = P.name; }
    }
    updateFormatHint(P.source);
    if (!silent) markDirty("clips");
    emit("source");
  }
  emit("clips");
}

async function upload(file) {
  const st = byId("upload-status"); st.textContent = `Uploading ${file.name} (${(file.size / 1048576).toFixed(1)} MB)…`;
  try {
    const r = await api.upload(file, "video");
    st.textContent = `Uploaded → uploads/${r.name}`;
    await browse(BOOT.roots.find((x) => x.label.startsWith("Uploads")).path);
    addClip(r.path);
  } catch (e) { st.textContent = "Upload failed: " + e.message; }
}

// ─────────────── music browser ───────────────
export async function browseMusic(path) {
  let data;
  try { data = await api.browse(path, "audio"); } catch (e) { byId("music-list").innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  mcwd = data;
  byId("music-crumb").textContent = data.win_path || data.path;
  byId("btn-music-up").disabled = !data.parent;
  const list = byId("music-list"); list.innerHTML = "";
  for (const d of data.dirs) { const el = document.createElement("div"); el.className = "item"; el.innerHTML = `<span>📁</span><span class="name">${esc(d.name)}</span>`; el.onclick = () => browseMusic(d.path); list.appendChild(el); }
  for (const f of data.files) {
    const sel = PROJECT.music.path === f.path;
    const el = document.createElement("div"); el.className = "item" + (sel ? " inseq" : "");
    el.innerHTML = `<span>🎵</span><span class="name" title="${esc(f.name)}">${esc(f.name)}</span><span class="meta">${f.size_mb} MB</span>`;
    el.onclick = () => pickMusic(f.path); list.appendChild(el);
  }
  if (!data.dirs.length && !data.files.length) list.innerHTML = `<div class="empty">No audio files or folders here.</div>`;
  localStorage.setItem("ave.mcwd", data.path);
}
export async function pickMusic(path) {
  PROJECT.music.path = path; PROJECT.music.enabled = true;
  byId("music.path").value = toWin(path) || path; byId("music.enabled").checked = true;
  const a = byId("music-audio"); a.src = api.media(path);
  a.onloadedmetadata = () => { PROJECT.music.duration_sec = a.duration; byId("music-info").textContent = `${baseName(path)} · ${fmtSec(a.duration)}`; emit("music"); };
  markDirty("music"); emit("music");
  if (mcwd) browseMusic(mcwd.path);
}
async function uploadMusic(file) {
  const st = byId("music-upload-status"); st.textContent = `Uploading ${file.name}…`;
  try { const r = await api.upload(file, "audio"); st.textContent = `Uploaded → uploads/music/${r.name}`; await browseMusic(r.path.replace(/\/[^/]+$/, "")); pickMusic(r.path); }
  catch (e) { st.textContent = "Upload failed: " + e.message; }
}

// ─────────────── wiring ───────────────
export function initBrowser() {
  const roots = byId("roots"), mroots = byId("music-roots");
  for (const r of BOOT.roots) {
    const b = document.createElement("button"); b.textContent = r.label; b.onclick = () => browse(r.path); roots.appendChild(b);
    const m = document.createElement("button"); m.textContent = r.label.replace("Uploads (drag & drop)", "Uploads"); m.onclick = () => browseMusic(r.path); mroots.appendChild(m);
  }
  const mu = document.createElement("button"); mu.textContent = "Music uploads"; mu.onclick = () => browseMusic(BOOT.repo + "/uploads/music"); mroots.prepend(mu);
  byId("btn-up").onclick = () => cwd && cwd.parent && browse(cwd.parent);
  byId("btn-music-up").onclick = () => mcwd && mcwd.parent && browseMusic(mcwd.parent);
  byId("btn-add-all").onclick = async () => { if (!cwd) return; for (const f of cwd.files.slice().sort((a, b) => a.name.localeCompare(b.name))) if (!clips.some((c) => c.path === f.path)) await addClip(f.path, true); renderClips(); browse(cwd.path); };
  byId("path-input").addEventListener("change", () => { const v = byId("path-input").value.trim(); if (v) { addClip(v); byId("path-input").value = ""; } });
  byId("btn-clear-clips").onclick = () => clearClips();
  byId("music.path").addEventListener("change", () => { const v = byId("music.path").value.trim(); if (v) pickMusic(v); });
  for (const [dropId, inputId, fn] of [["drop", "file-input", upload], ["music-drop", "music-file-input", uploadMusic]]) {
    const drop = byId(dropId);
    ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) fn(f); });
    byId(inputId).addEventListener("change", (e) => { const f = e.target.files[0]; if (f) fn(f); });
  }
  byId("btn-music-play").onclick = () => { const a = byId("music-audio"); if (!a.src) return; if (a.paused) { a.currentTime = PROJECT.music.start_offset_sec || 0; a.volume = Math.min(1, Math.pow(10, (PROJECT.music.gain_db || 0) / 20)); a.play(); byId("btn-music-play").textContent = "⏸ Stop"; } else { a.pause(); byId("btn-music-play").textContent = "▶ Preview music"; } };
  browse(localStorage.getItem("ave.cwd") || (BOOT.roots[0] && BOOT.roots[0].path));
  browseMusic(localStorage.getItem("ave.mcwd") || (BOOT.roots.find((r) => /Music|Downloads/.test(r.label)) || BOOT.roots[0] || {}).path || BOOT.repo);
}

// Restore clips from a project (fetches info for each input).
export async function loadClipsFromProject(inputs) {
  clips = [];
  for (const p of inputs || []) await addClip(p, true);
  renderClips(true);
  if (cwd) browse(cwd.path);
  const m = PROJECT.music;
  if (m && m.path) { byId("music.path").value = toWin(m.path) || m.path; const a = byId("music-audio"); a.src = api.media(m.path); a.onloadedmetadata = () => { m.duration_sec = a.duration; byId("music-info").textContent = `${baseName(m.path)} · ${fmtSec(a.duration)}`; emit("music"); }; }
  else { byId("music-audio").removeAttribute("src"); byId("music-info").textContent = ""; }
  return clips;
}
