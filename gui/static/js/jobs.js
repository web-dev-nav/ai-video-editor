// Job submission, progress polling, plan review, results, history — and the Render button.
import * as api from "./api.js";
import { $, $$, byId, esc, fmtSec, mmss, usd, toWin, baseName, costLine, fitHTML, showAlert, ALERT_TEXT, PROVIDER_NAMES, showTab } from "./ui.js";
import { BOOT, PROJECT, SEL, on, emit, select, markDirty, setKeepSegments, selectedRanges, piecesFromPlan, piecesFromKeep, hasCuts, outDuration } from "./state.js";
import { syncFromForms, collectOptions } from "./settings.js";
import { renderTranscript } from "./preview.js";
import { disp } from "./translit.js";
import { markRan, renderStale, paintStatus, setAutoJob, isOn, snapshot } from "./autorun.js";

let currentJob = null, currentJobStatus = null, pollTimer = null, seenEvents = 0;
// Fingerprints as they were when each job was submitted (see autorun.markRan).
const jobKeys = new Map();
export const busy = () => currentJob && ["running", "queued"].includes(currentJobStatus);

// ─────────────── the Render button ───────────────
export function updateRunButton() {
  const b = byId("btn-run"), P = PROJECT;
  paintStatus();
  if (!P || !P.source.inputs.length) { b.disabled = true; b.textContent = "Add a video to start"; b.title = ""; return; }
  const multi = P.source.inputs.length > 1 ? ` (${P.source.inputs.length} clips)` : "";
  b.disabled = !!busy();
  if (busy()) { b.textContent = "Working…"; return; }
  if (hasCuts()) {
    const again = renderStale();
    b.textContent = `🎬 ${again ? "Re-render · changed" : "Render"}${multi}`;
    b.title = again ? "The edit changed since the last render — render it again"
                    : "Render the timeline as it is now (cuts, voiceover, music)";
    return;
  }
  b.textContent = `✨ Ask AI for a plan${multi}`; b.title = "The AI proposes cuts; review them, then Render";
}

export async function submit(mode, extra = {}) {
  const P = PROJECT;
  if (!P.source.inputs.length) return;
  const auto = !!extra.auto; delete extra.auto;      // client-side flag, never sent to the server
  syncFromForms();
  const snap = snapshot();
  const options = { ...P.options, voiceover: P.voiceover, music: P.music, mix: P.mix };
  const body = { mode, inputs: P.source.inputs, input: P.source.inputs[0], output: P.output, options, project_id: P.id, ...extra };
  const usesAI = mode === "plan" || (mode === "process" && options.director.enabled);
  if (usesAI && !BOOT.keys[options.director.provider]) { showAlert("auth", `<b>No ${PROVIDER_NAMES[options.director.provider]} API key set.</b> Add one via "API keys" in the top bar.`); return; }
  if (mode === "render" || mode === "process") {
    const stale = P.voiceover.enabled ? P.voiceover.cues.filter((c) => (c.text || "").trim() && c.status !== "ready") : [];
    if (stale.length && P.voiceover.engine === "openai" && !confirm(`${stale.length} voiceover cue(s) will be generated with OpenAI during the render (≈ ${usd(stale.reduce((a, c) => a + c.text.length, 0) / 1000 * 0.015)}). Continue?`)) return;
    if (P.music.enabled && !P.music.path) { showAlert("other", "<b>Background music is on but no file is chosen.</b> Pick one under 🎵 Audio or switch it off."); return; }
  }
  try {
    const job = await api.jobCreate(body);
    jobKeys.set(job.id, snap);
    setAutoJob(auto ? job.id : null);
    watchJob(job.id); refreshJobs(); if (!auto) openJobs(true);
  } catch (e) { showAlert("other", `<b>Could not start:</b> ${esc(e.message)}`); }
}
function runClick() {
  const P = PROJECT;
  if (hasCuts()) submit("render", { keep_segments: P.keep_segments, carry_cost: P.plan_cost, carry_plan: reviewedPlan() });
  else submit("plan");
}
export const currentJobId = () => currentJob;
export const cancelJob = (id) => api.jobCancel(id);
function reviewedPlan() {
  const P = PROJECT; if (!P.plan) return null;
  const on = P.pieces.filter((p) => p.enabled), off = P.pieces.filter((p) => !p.enabled);
  return { ...P.plan, keep: on.filter((p) => p.kind === "kept").map((p) => ({ start: p.start, end: p.end, text: p.text, note: p.note })),
           removed: off.map((p) => ({ start: p.start, end: p.end, text: p.text, reason: p.reason || "removed by you" })),
           restored: on.filter((p) => p.kind !== "kept").map((p) => ({ start: p.start, end: p.end, text: p.text })) };
}

// ─────────────── pieces → finalized keep segments ───────────────
let finalizeTimer = null;
export async function refinalize() {
  const P = PROJECT;
  const ranges = selectedRanges();
  if (!ranges.length) { setKeepSegments([], P.keep_exact); return; }
  try {
    const r = await api.finalize({ inputs: P.source.inputs, options: collectOptions(), selected_ranges: ranges, exact: P.keep_exact });
    setKeepSegments(r.keep_segments, P.keep_exact);
  } catch (e) { showAlert("other", `<b>Could not update the cut:</b> ${esc(e.message)}`); }
  renderPlanBox(); renderTranscript(); updateRunButton();
}
export function togglePiece(id) {
  const p = PROJECT.pieces.find((x) => x.id === id); if (!p) return;
  p.enabled = !p.enabled;
  markDirty("piece");
  clearTimeout(finalizeTimer); finalizeTimer = setTimeout(refinalize, 150);
  renderPlanBox();
}

// ─────────────── starting the edit over (keeping the transcript) ───────────────
// Clears the cuts, the plan and the selection but never PROJECT.transcript, so going
// back to a blank slate does not throw away the transcription.
export function resetCuts() {
  const P = PROJECT;
  P.pieces = []; P.plan = null; P.plan_cost = null; P.keep_exact = false;
  select(null, null);
  setKeepSegments([], false);
  markDirty("reset-cuts");
  renderPlanBox(); renderTranscript(); updateRunButton();
}
function resetCutsClick() {
  if (!PROJECT.pieces.length && !hasCuts()) return;
  if (!confirm("Clear every cut and start the edit over?\n\nThe transcript is kept, so re-analyzing will not transcribe again.")) return;
  resetCuts();
  byId("result").innerHTML = `<div class="banner info">Cuts cleared — the transcript is still here. ${isOn() ? "A fresh plan is on its way." : "Press <b>Ask AI for a plan</b> to start over."}</div>`;
}
function replanClick() {
  if (PROJECT.pieces.length && !confirm("Discard these cuts and ask the AI for a fresh plan?\n\nThe transcript is reused, so you only pay for the AI call.")) return;
  resetCuts();
  submit("plan");
}
function updatePlanActions() {
  const has = !!(PROJECT.pieces.length || hasCuts());
  byId("btn-reset-cuts").disabled = !has;
}

// ─────────────── plan review box (Edit tab) ───────────────
export function renderPlanBox() {
  const P = PROJECT, card = byId("plan-card"), box = byId("plan-box");
  updatePlanActions();
  if (!P.pieces.length) { card.hidden = true; return; }
  card.hidden = false;
  const plan = P.plan, cost = P.plan_cost;
  const on = P.pieces.filter((p) => p.enabled).length, off = P.pieces.length - on;
  byId("plan-tag").textContent = `${on} kept · ${off} cut · ${mmss(outDuration())}`;
  let html = "";
  if (plan) {
    const cats = {};
    for (const p of plan.removed || []) { const c = (p.reason || "other").split(/[:\s—-]/)[0].toLowerCase(); cats[c] = (cats[c] || 0) + 1; }
    html += `<div class="plan-summary"><b>${esc(plan.model || plan.provider || "AI")}${plan.skill_name ? ` · ${esc(plan.skill_name)}` : ""} says:</b> ${esc(plan.summary || "")}<div class="cats">${Object.entries(cats).map(([c, n]) => `<span>${n} × ${esc(c)}</span>`).join("")}</div></div>`;
    html += `<div class="stats"><div class="stat"><b>${fmtSec(plan.duration_before_sec)} → ${fmtSec(outDuration())}</b><span>speech → edit</span></div><div class="stat"><b>${on}</b><span>pieces kept${plan.reordered ? " (reordered)" : ""}</span></div><div class="stat"><b>${off}</b><span>cuts</span></div></div>`;
    html += costLine(cost);
  } else {
    html += `<div class="hint">Tick a cut to put it back.</div>`;
  }
  const piece = (p) => `<label class="plan-piece ${p.kind === "kept" ? "kept" : "removed"}${p.enabled ? " on" : ""}${SEL.kind === "piece" && SEL.id === p.id ? " selected" : ""}" data-id="${p.id}"><input type="checkbox" ${p.enabled ? "checked" : ""}>
      <div><span class="t">${mmss(p.start)} → ${mmss(p.end)} (${(p.end - p.start).toFixed(1)}s)</span>${p.note ? `<div class="why ok">${esc(p.note)}</div>` : ""}${p.reason ? `<div class="why">${esc(p.reason)}</div>` : ""}<div class="txt">${esc(disp(p.text) || "(no speech)")}</div></div></label>`;
  const removed = P.pieces.filter((p) => p.kind !== "kept"), kept = P.pieces.filter((p) => p.kind === "kept");
  html += `<h3 class="sub">Cut</h3>${removed.length ? removed.map(piece).join("") : `<div class="hint">Nothing cut.</div>`}`;
  html += `<details class="quiet"><summary>Kept (${kept.length})</summary><div class="body">${kept.map(piece).join("")}</div></details>`;
  if (plan) html += `<textarea id="revise" placeholder="Tell the AI what to change, e.g. keep the part about the button…" style="margin-top:8px"></textarea><div class="actions"><button id="btn-revise" class="small ghost">Ask again</button></div>`;
  box.innerHTML = html;
  box.querySelectorAll(".plan-piece").forEach((el) => {
    const id = el.dataset.id;
    el.querySelector("input").onchange = (e) => { e.stopPropagation(); togglePiece(id); };
    el.onclick = (e) => { if (e.target.tagName === "INPUT") return; e.preventDefault(); select("piece", id); };
  });
  const rv = byId("btn-revise");
  if (rv) rv.onclick = () => { const extra = byId("revise").value.trim(); if (!extra) return; const ta = byId("director.instructions"); ta.value = (ta.value.trim() + "\n\nRevision: " + extra).trim(); syncFromForms(); submit("plan"); };
}

// ─────────────── job watching ───────────────
export function watchJob(id) {
  currentJob = id; seenEvents = 0; currentJobStatus = "queued";
  byId("run-panel").hidden = false; byId("run-empty").hidden = true; byId("result").innerHTML = ""; byId("log").innerHTML = "";
  byId("progress").className = "progress"; $("#progress > div").style.width = "0%";
  $$("#phases span").forEach((s) => (s.className = ""));
  if (pollTimer) clearInterval(pollTimer);
  poll(); pollTimer = setInterval(poll, 1000);
  updateRunButton();
}
async function poll() {
  if (!currentJob) return;
  let j;
  try { j = await api.job(currentJob, seenEvents); } catch { return; }
  currentJobStatus = j.status;
  const log = byId("log");
  for (const ev of j.events) { const d = document.createElement("div"); d.className = "ev"; d.textContent = `[${ev.t}s] ${ev.phase}/${ev.step} ${Math.round(ev.progress * 100)}% — ${ev.message}`; log.appendChild(d); }
  seenEvents = j.event_count;
  const noise = log.querySelector(".noise") || log.appendChild(Object.assign(document.createElement("div"), { className: "noise" }));
  noise.textContent = j.log.filter((l) => !l.startsWith("{")).slice(-60).join("\n");
  log.scrollTop = log.scrollHeight;
  const last = j.events.length ? j.events[j.events.length - 1] : null;
  if (last) byId("status-msg").textContent = last.message;
  if (j.status === "queued") byId("status-msg").textContent = "Waiting for the previous job to finish…";
  const pct = j.status === "done" ? 100 : j.overall;
  byId("status-pct").textContent = `${Math.round(pct)}% · ${fmtSec(j.elapsed)}`;
  $("#progress > div").style.width = `${pct}%`;
  byId("progress").classList.toggle("running", j.status === "running");
  byId("mini-bar").className = "mini-bar " + (j.status === "done" ? "done" : j.status === "error" ? "error" : "");
  $("#mini-bar > div").style.width = `${pct}%`;
  byId("jobs-status").textContent = j.status === "running" ? (last ? last.message.slice(0, 70) : "running…") : j.status;
  byId("phase-combine").hidden = !(j.inputs && j.inputs.length > 1);
  const order = ["combine", "setup", "analysis", "assembly", "ai_enhancement", "encode", "finish"];
  const cur = last ? (last.phase === "ai" ? "ai_enhancement" : last.phase) : null;
  $$("#phases span").forEach((s) => { const i = order.indexOf(s.dataset.phase), c = order.indexOf(cur); s.className = j.status === "done" ? "done" : (i < c ? "done" : i === c ? "active" : ""); });
  byId("btn-cancel").disabled = !(j.status === "queued" || j.status === "running");
  updateRunButton();
  emit("job", j.status);
  if (["done", "error", "cancelled"].includes(j.status)) {
    clearInterval(pollTimer); pollTimer = null;
    if (j.status !== "done") jobKeys.delete(j.id);   // failed/cancelled: nothing ran, stay stale
    byId("progress").classList.add(j.status === "done" ? "done" : "error");
    renderResult(j); refreshJobs();
  }
}

function renderResult(j) {
  const r = j.result, box = byId("result"), P = PROJECT;
  if (j.status === "cancelled") { box.innerHTML = `<div class="banner err">Cancelled.</div>`; return; }
  if (j.status === "error") {
    const prov = PROVIDER_NAMES[collectOptions().director.provider] || "The provider";
    if (j.error_kind && ALERT_TEXT[j.error_kind]) showAlert(j.error_kind, ALERT_TEXT[j.error_kind](prov));
    box.innerHTML = `<div class="banner err"><b>Failed${j.error_kind ? ` (${j.error_kind.replace("_", " ")})` : ""}:</b> ${esc((j.error || "unknown error").replace(/^\s*AI Director failed: /, ""))}<br><span class="hint">Open the log for details.</span></div>`;
    byId("log").hidden = false; byId("btn-toggle-log").textContent = "Hide log"; return;
  }
  if (r.status === "plan") { onPlanResult(j); return; }
  // ── a finished render
  const saved = r.duration_original_sec - r.duration_edited_sec, winOut = toWin(r.output_video), winDir = r.output_folder && toWin(r.output_folder);
  const vo = r.voiceover;
  box.innerHTML = `
    <div class="banner ok">Done in ${fmtSec(r.processing_time_sec)} — ${r.output_folder ? `saved in folder<br><span class="path">${esc(winDir || r.output_folder)}</span><div class="files">${(r.bundle_files || []).map((f) => `<span>${esc(f)}</span>`).join("")}</div>` : `saved to<br><span class="path">${esc(winOut || r.output_video)}</span>`}
      ${r.output_width ? `<div class="hint" style="margin:6px 0 0">Output: ${r.output_width}×${r.output_height}${r.output_height > r.output_width ? " · vertical" : r.output_width === r.output_height ? " · square" : " · landscape"}</div>` : ""}
      ${r.format_error ? `<div class="hint warn">Format conversion failed: ${esc(r.format_error)} — saved at source size.</div>` : ""}
      ${vo && vo.cues ? `<div class="hint" style="margin:4px 0 0">Voiceover: ${vo.cues} cue${vo.cues > 1 ? "s" : ""}${vo.overruns && vo.overruns.length ? ` · <span style="color:var(--warn)">${vo.overruns.length} longer than their slot</span>` : ""}</div>` : ""}</div>
    ${r.director_plan ? `<div class="plan-summary"><b>AI editor${r.director_plan.skill_name ? ` · ${esc(r.director_plan.skill_name)}` : ""}:</b> ${esc(r.director_plan.summary || "")}</div>` : ""}
    <div class="stats"><div class="stat"><b>${fmtSec(r.duration_original_sec)} → ${fmtSec(r.duration_edited_sec)}</b><span>duration (−${saved.toFixed(1)}s, ${Math.round(saved / Math.max(1, r.duration_original_sec) * 100)}%)</span></div>
      ${r.director_plan ? `<div class="stat"><b>${r.director_plan.removed.length}</b><span>AI cuts</span></div><div class="stat"><b>${r.director_plan.keep.length}</b><span>pieces kept</span></div>` : `<div class="stat"><b>${r.fillers_removed}</b><span>filler words cut</span></div><div class="stat"><b>${r.restarts_removed}</b><span>failed takes cut</span></div>`}</div>
    ${costLine(j.cost)}
    <div class="fit">${fitHTML(r.duration_edited_sec, r.output_width || P.source.width, r.output_height || P.source.height, "Edited video")}</div>
    <div class="actions"><button class="small" id="btn-play-output">▶ Play</button>${r.continue_ready ? `<button class="small ghost" id="btn-continue" title="Start a new project on the rendered file (transcript carried over)">✂ Continue from this</button>` : ""}
      <button class="small" onclick="navigator.clipboard.writeText(${JSON.stringify(winDir || winOut || r.output_video)})">Copy ${r.output_folder ? "folder" : "output"} path</button></div>

    ${r.chapters_text ? `<h3 class="sub">YouTube chapters</h3><pre class="chapters">${esc(r.chapters_text)}</pre><div class="actions"><button class="small" onclick="navigator.clipboard.writeText(${JSON.stringify(r.chapters_text)})">Copy chapters</button></div>` : ""}`;
  byId("btn-play-output").onclick = () => emit("render-done", r);
  const cont = byId("btn-continue");
  if (cont) cont.onclick = () => emit("continue-from", { r, job: j });
  if (j.mode === "process") markRan("plan", jobKeys.get(j.id));
  if (j.mode === "process" && !hasCuts() && r.keep_segments && r.keep_segments.length) {
    // one-shot edit: show the cuts it made so the project is re-editable
    P.plan = r.director_plan || null; P.plan_cost = j.cost || null;
    adoptKeep(r.keep_segments, r.director_plan, r.duration_original_sec, !r.director_plan);
  }
  markRan("render", jobKeys.get(j.id));
  P.renders = P.renders || []; P.renders.push({ job_id: j.id, output_video: r.output_video, output_folder: r.output_folder, created: new Date().toISOString(), duration_edited_sec: r.duration_edited_sec, cost: j.cost });
  if (j.cost && !j.cost.carried) { P.cost = P.cost || {}; P.cost.total_usd = Math.round(((P.cost.total_usd || 0) + (j.cost.cost_total || 0)) * 1e5) / 1e5; }
  markDirty("render");
  emit("render-done", r);
}

async function adoptKeep(keep, plan, total, exact) {
  const P = PROJECT;
  if (!P.transcript) { try { const t = await api.transcript({ inputs: P.source.inputs }); if (t.transcript) P.transcript = t.transcript; } catch {} }
  P.pieces = plan ? piecesFromPlan(plan) : piecesFromKeep(keep, total || P.source.duration_sec, P.transcript);
  P.keep_exact = !!exact;
  setKeepSegments(keep, !!exact);
  renderPlanBox(); renderTranscript(); updateRunButton();
}

async function onPlanResult(j) {
  const r = j.result, P = PROJECT;
  markRan("plan", jobKeys.get(j.id));   // the settings this plan was made from, not the current ones
  P.transcript = r.transcript || [];
  P.source.pipeline_input = P.source.inputs.length > 1 ? j.input : P.source.inputs[0];
  if (r.plan) {
    P.plan = r.plan; P.plan_cost = j.cost || null;
    P.pieces = piecesFromPlan(r.plan); P.keep_exact = false;
    if (j.cost && !j.cost.carried) { P.cost = P.cost || {}; P.cost.total_usd = Math.round(((P.cost.total_usd || 0) + (j.cost.cost_total || 0)) * 1e5) / 1e5; }
    await refinalize();
    byId("result").innerHTML = `<div class="banner ok">Plan ready — ${P.pieces.filter((p) => !p.enabled).length} cuts. Review, then <b>Render</b>.</div>${costLine(j.cost)}`;
    showTab("ai");
  } else {
    // analyze: transcript + rule-based cuts
    P.plan = null; P.plan_cost = null;
    const keep = r.keep_segments || [];
    byId("result").innerHTML = `<div class="banner info">Transcribed in ${fmtSec(r.processing_time_sec)}.</div>`;
  }
  renderTranscript(); renderPlanBox(); markDirty("plan"); emit("source-analyzed"); updateRunButton();
}

// ─────────────── history ───────────────
export async function refreshJobs() {
  const { jobs, totals } = await api.jobs(), box = byId("jobs-list"), t = byId("totals");
  t.hidden = !totals.calls;
  t.innerHTML = `This session: <b>${totals.calls}</b> AI call${totals.calls === 1 ? "" : "s"} · <b>${totals.input_tokens.toLocaleString()}</b> in / <b>${totals.output_tokens.toLocaleString()}</b> out · <b>${usd(totals.cost_total)}</b>`;
  byId("jobs-cost").textContent = totals.calls ? `AI spend this session: ${usd(totals.cost_total)}` : "";
  if (!jobs.length) { box.innerHTML = `<div class="hint">No jobs yet.</div>`; return; }
  box.innerHTML = "";
  for (const j of jobs) {
    const el = document.createElement("div"); el.className = "item";
    const name = (j.inputs && j.inputs.length > 1) ? `${j.inputs.length} clips · ${baseName(j.inputs[0])} …` : baseName(j.input);
    const kind = { analyze: "analyze", plan: "AI plan", render: "render", process: "edit" }[j.mode] || j.mode;
    const extra = j.status === "done" && j.result ? (j.result.status === "plan" ? kind : `${kind} · ${fmtSec(j.result.duration_original_sec)} → ${fmtSec(j.result.duration_edited_sec)}`) : `${kind} · ${j.status}`;
    const c = j.cost && !j.cost.carried && j.cost.cost_total != null ? ` · ${usd(j.cost.cost_total)}` : "";
    el.innerHTML = `<span class="dot ${j.status}"></span><span class="name" title="${esc((j.inputs || [j.input]).join("\n"))}">${esc(name)}</span><span class="meta">${esc(extra)}${c}</span>`;
    el.onclick = () => { watchJob(j.id); openJobs(true); };
    box.appendChild(el);
  }
}

export function openJobs(open) {
  const want = open == null ? byId("jobs").hidden : open;
  byId("jobs").hidden = !want; byId("bottom").classList.toggle("jobs-open", want); byId("app").classList.toggle("jobs-open", want);
  byId("jobs-toggle").textContent = want ? "▾ Jobs" : "▴ Jobs";
  emit("layout");
}

export function initJobs() {
  byId("btn-run").onclick = runClick;
  byId("btn-ai-oneshot").onclick = () => submit("process");
  byId("btn-analyze").onclick = () => submit("analyze");
  byId("btn-reset-cuts").onclick = resetCutsClick;
  byId("btn-replan").onclick = replanClick;
  byId("btn-cancel").onclick = async () => { if (currentJob) await api.jobCancel(currentJob); };
  byId("btn-toggle-log").onclick = () => { const l = byId("log"); l.hidden = !l.hidden; byId("btn-toggle-log").textContent = l.hidden ? "Show log" : "Hide log"; };
  byId("btn-show-config").onclick = async () => { if (!currentJob) return; byId("config-text").textContent = await api.jobConfig(currentJob); byId("config-dialog").showModal(); };
  byId("config-close").onclick = () => byId("config-dialog").close();
  byId("jobs-bar").onclick = () => openJobs();
  on("clips", updateRunButton); on("mode", () => { updateRunButton(); updatePlanActions(); }); on("project", () => { renderPlanBox(); renderTranscript(); updateRunButton(); });
  on("pieces", updateRunButton); on("selection", renderPlanBox);
  refreshJobs(); updateRunButton();
}
