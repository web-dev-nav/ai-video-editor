// Projects: autosave, open/new/import, "keep editing this result".
import * as api from "./api.js";
import { byId, esc, fmtSec, baseName, flash, showAlert } from "./ui.js";
import { PROJECT, on, emit, newProject, loadProject, markClean, isDirty, setSaver, setKeepSegments, markDirty } from "./state.js";
import { applyProjectToForms, syncFromForms, loadPresetIntoForms, loadAllModelPickers } from "./settings.js";
import { loadClipsFromProject, clearClips, renderClips } from "./browser.js";
import { refreshStale } from "./voiceover.js";

let saving = false;
function setSaveState(text, cls = "") { const el = byId("save-state"); el.textContent = text; el.className = cls; }

export async function save(force = false) {
  const P = PROJECT;
  if (!P || saving) return;
  if (!P.source.inputs.length && !force) { markClean(); setSaveState(""); return; }   // nothing worth keeping yet
  syncFromForms();
  P.name = byId("proj-name").value.trim() || P.name || baseName(P.source.inputs[0] || "").replace(/\.[^.]+$/, "") || "Untitled";
  saving = true; setSaveState("Saving…");
  try {
    const r = await api.projectPut(P);
    P.updated = r.updated; P.created = P.created || r.created;
    localStorage.setItem("ave.project", P.id);
    markClean(); setSaveState(`Saved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
  } catch (e) {
    if (e.status === 409 && confirm("This project was changed elsewhere (another tab?). Overwrite with this version?")) { P.force = true; saving = false; return save(true); }
    setSaveState("Save failed: " + e.message, "dirty");
  } finally { saving = false; delete PROJECT.force; }
}

export async function open(id) {
  let p;
  try { p = await api.projectGet(id); } catch (e) { showAlert("other", `<b>Could not open the project:</b> ${esc(e.message)}`); return false; }
  loadProject(p);
  byId("proj-name").value = p.name || "";
  await loadClipsFromProject(p.source.inputs);
  applyProjectToForms();
  refreshStale();
  setKeepSegments(p.keep_segments || [], !!p.keep_exact);
  loadAllModelPickers();
  localStorage.setItem("ave.project", p.id);
  markClean(); setSaveState(p.updated ? `Saved ${p.updated.slice(11, 16)}` : "");
  const missing = (p.source.inputs || []).filter((x, i) => !(PROJECT.source.inputs || []).includes(x));
  if (missing.length) showAlert("other", `<b>Some source files were not found:</b> ${missing.map(esc).join(", ")}. Re-add them under 📁 Media.`);
  emit("project-opened");
  return true;
}

export function startNew(fromRender = null) {
  clearClips(true);
  newProject("");
  byId("proj-name").value = "";
  loadPresetIntoForms();
  applyProjectToForms();
  loadAllModelPickers();
  setSaveState("");
  localStorage.removeItem("ave.project");
  renderClips(true);
  if (fromRender) {
    const { r, job } = fromRender;
    PROJECT.source.derived_from = { project_id: job.project_id, job_id: job.id, output_video: r.output_video };
    PROJECT.mode = "ai";
    loadClipsFromProject([r.output_video]).then(() => {
      applyProjectToForms();
      PROJECT.name = baseName(r.output_video).replace(/\.[^.]+$/, "") + " (continued)"; byId("proj-name").value = PROJECT.name;
      byId("director.instructions").value = ""; syncFromForms(); markDirty("continue");
      byId("result").innerHTML = `<div class="banner info">Now editing <b>${esc(baseName(r.output_video))}</b> as a new project. Its transcript is already known, so <b>Ask AI for a plan</b> takes seconds. Describe what else to cut in the ✂️ Edit tab.</div>`;
    });
  }
}

async function showOpenDialog() {
  const box = byId("open-list"); box.innerHTML = `<div class="hint">Loading…</div>`;
  byId("open-dialog").showModal();
  let list = [];
  try { list = (await api.projects()).projects; } catch (e) { box.innerHTML = `<div class="hint err">${esc(e.message)}</div>`; return; }
  if (!list.length) { box.innerHTML = `<div class="hint">No saved projects yet. Projects save automatically once a video is added.</div>`; return; }
  box.innerHTML = "";
  for (const p of list) {
    const el = document.createElement("div"); el.className = "proj-item";
    el.innerHTML = `<div class="grow"><div class="name">${esc(p.name)}${p.id === (PROJECT && PROJECT.id) ? " <span class='pill ok'>open</span>" : ""}</div>
      <div class="meta">${esc(p.input_name)}${p.clips > 1 ? ` +${p.clips - 1}` : ""} · ${p.duration_sec ? fmtSec(p.duration_sec) : ""} · ${p.mode || ""}${p.cues ? ` · ${p.cues} VO cues` : ""}${p.music ? " · music" : ""}${p.renders ? ` · ${p.renders} render${p.renders > 1 ? "s" : ""}` : ""}${p.missing_inputs.length ? ` · <span style="color:var(--warn)">source missing</span>` : ""}</div>
      <div class="meta">updated ${esc(p.updated || "")}</div></div><button class="small danger" title="Delete project">✕</button>`;
    el.onclick = async (e) => { if (e.target.tagName === "BUTTON") return; byId("open-dialog").close(); if (isDirty()) await save(); await open(p.id); };
    el.querySelector("button").onclick = async (e) => { e.stopPropagation(); if (!confirm(`Delete project "${p.name}"? (Rendered videos are not deleted.)`)) return; await api.projectDelete(p.id); if (PROJECT && PROJECT.id === p.id) startNew(); showOpenDialog(); };
    box.appendChild(el);
  }
}

export function initProjects() {
  setSaver(() => save());
  on("dirty", (what) => { if (what) setSaveState("● unsaved", "dirty"); });
  byId("proj-name").addEventListener("change", () => { PROJECT.name = byId("proj-name").value.trim(); markDirty("name"); });
  byId("btn-save").onclick = async () => { await save(true); flash(byId("btn-save"), "Saved ✓"); };
  byId("btn-new").onclick = async () => { if (isDirty()) await save(); startNew(); };
  byId("btn-open").onclick = showOpenDialog;
  byId("open-close").onclick = () => byId("open-dialog").close();
  byId("open-import").onclick = async () => {
    const path = byId("open-path").value.trim(); if (!path) return;
    try { const r = await api.projectImport(path); byId("open-dialog").close(); await open(r.project.id); }
    catch (e) { showAlert("other", `<b>Import failed:</b> ${esc(e.message)}`); }
  };
  on("continue-from", (payload) => { save().then(() => startNew(payload)); });
  window.addEventListener("beforeunload", (e) => { if (isDirty()) { save(); } });
}

// Boot: reopen the last project, or start fresh.
export async function bootProject() {
  const last = localStorage.getItem("ave.project");
  if (last && (await open(last))) return;
  startNew();
}
