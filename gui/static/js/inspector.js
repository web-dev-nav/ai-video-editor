// Right-hand inspector: export/settings by default, else the selected piece / cue / music.
import { byId, esc, mmssd, num, baseName, showTab } from "./ui.js";
import { PROJECT, SEL, on, emit, select, selectedPiece, selectedCue, srcToOut, outToSrc, markDirty, round3 } from "./state.js";
import { voiceName } from "./settings.js";
import { togglePiece } from "./jobs.js";
import { generateCue, deleteCue, cueFitInfo, touchCue } from "./voiceover.js";
import * as api from "./api.js";
import { disp, romanOn, toRoman } from "./translit.js";

export function renderInspector() {
  const piece = selectedPiece(), cue = selectedCue(), music = SEL.kind === "music";
  byId("insp-default").hidden = !!(piece || cue || music);
  byId("insp-piece").hidden = !piece; byId("insp-cue").hidden = !cue; byId("insp-music").hidden = !music;
  byId("insp-title").textContent = piece ? "Piece" : cue ? "Cue" : music ? "Music" : "Export";
  byId("insp-tag").innerHTML = piece || cue || music ? `<button class="small ghost" id="insp-back">✕</button>` : "";
  const back = byId("insp-back"); if (back) back.onclick = () => select(null, null);
  if (piece) renderPiece(piece);
  if (cue) renderCue(cue);
  if (music) renderMusic();
}

function renderPiece(p) {
  const on = p.enabled, kind = p.kind === "kept" ? "kept" : (on ? "restored" : "removed");
  const k = byId("piece-kind"); k.className = `piece-kind ${kind}`; k.textContent = { kept: "Kept", restored: "Restored (was cut)", removed: "Cut" }[kind];
  byId("piece-src").textContent = `${mmssd(p.start)} → ${mmssd(p.end)}`;
  byId("piece-out").textContent = on ? `${mmssd(srcToOut(p.start))} → ${mmssd(srcToOut(p.end))}` : "— (not in the edit)";
  byId("piece-len").textContent = `${(p.end - p.start).toFixed(1)} s`;
  byId("piece-reason").textContent = p.reason ? `Why it was cut: ${p.reason}` : p.note ? `Note: ${p.note}` : "";
  byId("piece-text").textContent = disp(p.text) || "(no speech)";
  const b = byId("btn-piece-toggle");
  b.textContent = on ? "✂ Remove this piece" : "↩ Put it back";
  b.onclick = () => togglePiece(p.id);
  byId("btn-piece-seek").onclick = () => emit("seek", srcToOut(p.start));
}

function renderCue(c) {
  byId("cue.text").value = c.text || "";
  byId("cue.start").value = c.start; byId("cue.end").value = c.end ?? "";
  byId("cue.voice").value = c.voice || ""; byId("cue.speed").value = c.speed ?? ""; byId("cue.instructions").value = c.instructions || "";
  byId("cue-instr-field").hidden = !(PROJECT.voiceover.engine === "openai" && (PROJECT.voiceover.model || "").startsWith("gpt-4o"));
  byId("cue-fit").innerHTML = cueFitInfo(c);
  const rom = byId("cue-roman"); const r = toRoman(c.text || "");
  rom.hidden = !(romanOn() && r !== (c.text || "")); rom.textContent = r;
  const st = byId("cue-status");
  st.textContent = c.status === "ready" ? `${voiceName(c.voice || PROJECT.voiceover.voice)} · ${c.engine || PROJECT.voiceover.engine}${c.cost_usd ? ` · $${c.cost_usd.toFixed(4)}` : ""}` : c.status === "stale" ? "Changed — generate again." : c.status === "error" ? `Failed: ${c.error || ""}` : "Not generated yet (the render will).";
  st.className = "hint " + ({ ready: "ok", stale: "warn", error: "err" }[c.status] || "");
  byId("btn-cue-play").disabled = !c.audio || c.status === "stale";
  byId("btn-cue-gen").onclick = () => generateCue(c.id);
  byId("btn-cue-play").onclick = () => { const a = byId("cue-audio"); a.src = api.media(c.audio); a.playbackRate = c.tempo || 1; a.play(); };
  byId("btn-cue-seek").onclick = () => emit("seek", c.start);
  byId("btn-cue-del").onclick = () => deleteCue(c.id);
}

function renderMusic() {
  const m = PROJECT.music;
  byId("music-kv").innerHTML = [["File", esc(baseName(m.path))], ["Level", `${m.gain_db} dB`], ["Fades", `${m.fade_in_sec}s in · ${m.fade_out_sec}s out`], ["Start at", `${m.start_offset_sec}s`], ["Loop", m.loop ? "yes" : "no"], ["Ducking", m.duck ? `${m.duck_db} dB under speech` : "off"], ["Enabled", m.enabled ? "yes" : "no"]]
    .map(([k, v]) => `<div>${k}</div><div>${v}</div>`).join("");
  byId("btn-music-tab").onclick = () => showTab("audio");
}

export function initInspector() {
  on("selection", renderInspector);
  on("cues", () => { if (SEL.kind === "cue") renderInspector(); });
  on("pieces", () => { if (SEL.kind === "piece") renderInspector(); });
  on("music", () => { if (SEL.kind === "music") renderInspector(); });
  on("project", renderInspector); on("roman", renderInspector);
  // cue form edits → cue
  const sect = byId("insp-cue");
  sect.addEventListener("input", (e) => {
    const c = selectedCue(); if (!c) return;
    if (e.target.id === "cue.text") { c.text = byId("cue.text").value; touchCue(c); }
    if (e.target.id === "cue.start") { c.start = Math.max(0, num("cue.start")); c.src = round3(outToSrc(c.start)); }
    if (e.target.id === "cue.end") { const v = byId("cue.end").value.trim(); c.end = v === "" ? null : Math.max(0, parseFloat(v)); c.src_end = c.end != null ? round3(outToSrc(c.end)) : null; }
    if (e.target.id === "cue.speed") { const v = byId("cue.speed").value.trim(); c.speed = v === "" ? null : parseFloat(v); touchCue(c); }
    if (e.target.id === "cue.instructions") { c.instructions = byId("cue.instructions").value; touchCue(c); }
    byId("cue-fit").innerHTML = cueFitInfo(c);
    const rom = byId("cue-roman"); const r = toRoman(c.text || ""); rom.hidden = !(romanOn() && r !== (c.text || "")); rom.textContent = r;
    markDirty("cue"); emit("cues-quiet");
  });
  sect.addEventListener("change", (e) => {
    const c = selectedCue(); if (!c) return;
    if (e.target.id === "cue.voice") { c.voice = byId("cue.voice").value || null; touchCue(c); }
    markDirty("cue"); emit("cues");
  });
  renderInspector();
}
