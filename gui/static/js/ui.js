// Small DOM/format helpers shared by every module.
export const $ = (s) => document.querySelector(s);
export const $$ = (s) => Array.from(document.querySelectorAll(s));
export const byId = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const fmtSec = (s) => { s = Math.round(s || 0); const m = Math.floor(s / 60); return m ? `${m}m ${s % 60}s` : `${s}s`; };
export const mmss = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
export const mmssd = (s) => { s = Math.max(0, s || 0); const m = Math.floor(s / 60), r = s - m * 60; return `${m}:${r < 10 ? "0" : ""}${r.toFixed(1)}`; };
export const fmtMB = (b) => b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`;
export const usd = (x) => x == null ? "—" : (x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(3)}`);
export const toWin = (p) => { const m = p && p.match(/^\/mnt\/([a-z])\/(.*)$/); return m ? `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}` : null; };
export const baseName = (p) => String(p || "").split(/[\\/]/).pop();
export const num = (id) => { const v = parseFloat(byId(id).value); return Number.isFinite(v) ? v : 0; };
export const csv = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const uid = (p = "c") => p + Math.random().toString(36).slice(2, 8);
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

export function flash(btn, text, ms = 1200) {
  if (!btn) return;
  const t = btn.textContent; btn.textContent = text; btn.disabled = true;
  setTimeout(() => { btn.textContent = t; btn.disabled = false; }, ms);
}

export function showAlert(kind, html) { const a = byId("alert"); a.className = kind; byId("alert-text").innerHTML = html; a.hidden = false; }
export function hideAlert() { byId("alert").hidden = true; }

export const PROVIDER_NAMES = { anthropic: "Claude (Anthropic)", openai: "ChatGPT (OpenAI)", openrouter: "OpenRouter", nvidia: "NVIDIA NIM" };
export const ALERT_TEXT = {
  quota: (p) => `<b>Model limit reached — ${p} credits or quota are exhausted.</b> Top up the account, or switch provider/model and try again (the transcript is cached, nothing is lost).`,
  rate_limit: (p) => `<b>${p} is rate-limiting you.</b> Wait a minute and try again, or switch to another provider.`,
  auth: (p) => `<b>${p} rejected the API key.</b> Check it under API keys — it may be missing, mistyped, revoked, or lack permission.`,
  model: (p) => `<b>${p} does not serve the selected model.</b> Pick another one from the Model dropdown (↻ refreshes the list).`,
  refusal: (p) => `<b>${p} declined this request.</b> Try a different model or rephrase the instructions.`,
  network: (p) => `<b>${p} could not be reached.</b> Check the internet connection and try again.`,
  engine_missing: (p) => `<b>${p} is not installed.</b> See the note next to the engine, then restart the GUI.`,
};

// Platform limits (2025). Shorts/Reels also expect vertical 9:16.
const PLATFORMS = [
  { name: "YouTube Shorts", max: 180, vertical: true }, { name: "Instagram Reels", max: 180, vertical: true },
  { name: "Facebook Reels", max: 90, vertical: true }, { name: "YouTube video", max: 12 * 3600, vertical: false },
  { name: "Facebook video", max: 240 * 60, vertical: false }, { name: "Instagram feed video", max: 60 * 60, vertical: false },
];
export function fitHTML(durationSec, w, h, label) {
  if (!durationSec) return "";
  const cls = durationSec <= 60 ? "very short (≤ 1 min)" : durationSec <= 180 ? "short-form (≤ 3 min)" : durationSec <= 600 ? "medium (3–10 min)" : "long-form (> 10 min)";
  const vertical = w && h ? h > w : null;
  const badges = PLATFORMS.map((p) => {
    const ok = durationSec <= p.max;
    const orient = p.vertical && vertical === false ? " · landscape (expects 9:16)" : "";
    const c = !ok ? "badge-no" : orient ? "badge-warn" : "badge-ok";
    return `<span class="${c}" title="max ${mmss(p.max)}">${ok ? "✓" : "✗"} ${p.name}${!ok ? ` (max ${mmss(p.max)})` : orient}</span>`;
  }).join("");
  return `<div><b>${label}:</b> ${mmss(durationSec)} — ${cls}${vertical === null ? "" : vertical ? " · vertical" : " · landscape"}</div><div class="row-b">${badges}</div>`;
}

export function costLine(c) {
  if (!c) return "";
  const price = c.cost_total != null
    ? `<b>${usd(c.cost_total)}</b>${c.price_in_per_m ? ` <span title="${esc(c.price_source || "")}">(${c.price_in_per_m}/${c.price_out_per_m} $ per 1M)</span>` : ""}`
    : `price unknown for this model`;
  const items = (c.items || []).map((it) => it.step === "voiceover" ? `voiceover ${it.chars.toLocaleString()} chars ${usd(it.cost_total)}` : `${it.step} ${usd(it.cost_total)}`).join(" · ");
  return `<div class="cost">🧾 ${esc(c.model || c.provider || "")}${c.carried ? " (plan cost, no new call)" : ""}: <b>${(c.input_tokens || 0).toLocaleString()}</b> in · <b>${(c.output_tokens || 0).toLocaleString()}</b> out · ${price}${items ? `<br><span>${esc(items)}</span>` : ""}</div>`;
}

// Left-panel tabs
export function showTab(name) {
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  ["media", "ai", "voice", "audio"].forEach((t) => { byId(`tab-${t}`).hidden = t !== name; });
  localStorage.setItem("ave.tab", name);
}
export function initTabs() {
  $$(".tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  showTab(localStorage.getItem("ave.tab") || "media");
}
