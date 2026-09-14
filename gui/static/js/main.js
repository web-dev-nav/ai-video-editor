// Boot: load server state, wire every module, open the last project.
import * as api from "./api.js";
import { byId, initTabs, esc, hideAlert } from "./ui.js";
import { setBoot, BOOT, on, emit, newProject } from "./state.js";
const emitRoman = () => emit("roman");
import { initSettings, loadSkills, refreshWhisper, loadAllModelPickers, syncFromForms, updateTags } from "./settings.js";
import { initBrowser } from "./browser.js";
import { initPreview, renderTranscript, highlightTranscript } from "./preview.js";
import { initTimeline } from "./timeline.js";
import { initInspector } from "./inspector.js";
import { initVoiceover } from "./voiceover.js";
import { initJobs } from "./jobs.js";
import { initProjects, bootProject } from "./projects.js";
import { romanOn, setRoman } from "./translit.js";
import { renderPlanBox } from "./jobs.js";

function setKeyPills() {
  const names = { anthropic: "Claude", openai: "OpenAI", openrouter: "OpenRouter", nvidia: "NVIDIA" };
  const have = Object.keys(names).filter((k) => BOOT.keys[k]);
  byId("key-pills").innerHTML = have.length
    ? `<span class="pill ok" title="Keys set: ${have.map((k) => names[k]).join(", ")}">${have.length} key${have.length > 1 ? "s" : ""} ✓</span>`
    : `<span class="pill warn" title="No API keys yet — the AI editor needs one">no keys</span>`;
}

(async () => {
  setBoot(await api.bootstrap());
  newProject("");   // modules expect a project to exist; bootProject() replaces it
  byId("ffmpeg-pill").hidden = !!BOOT.ffmpeg;
  setKeyPills();
  initTabs();
  byId("alert-close").onclick = hideAlert;
  const romanBtn = byId("btn-roman");
  const paintRoman = () => { romanBtn.classList.toggle("on", romanOn()); };
  romanBtn.onclick = () => { setRoman(!romanOn()); paintRoman(); renderTranscript(); renderPlanBox(); emitRoman(); };
  paintRoman();

  // API keys dialog
  const openKeys = () => { byId("key-input").value = ""; byId("key-provider").value = byId("director.provider").value; byId("key-dialog").showModal(); };
  byId("btn-key").onclick = openKeys; byId("btn-key").hidden = true;
  byId("key-pills").onclick = openKeys; byId("key-pills").style.cursor = "pointer"; byId("key-pills").title = "API keys";
  byId("key-cancel").onclick = () => byId("key-dialog").close();
  byId("key-save").onclick = async () => {
    const r = await api.saveKey(byId("key-provider").value, byId("key-input").value);
    BOOT.keys = r.keys; BOOT.api_key_present = r.api_key_present; setKeyPills(); byId("key-dialog").close();
    try { const b = await api.bootstrap(); BOOT.tts = b.tts; } catch {}
    syncFromForms(); updateTags(); loadAllModelPickers(true);
    const { setEngine, loadVoices } = await import("./settings.js"); setEngine(byId("engine-pills").querySelector(".active")?.dataset.engine || "edge", false); loadVoices(true);
  };

  initSettings();
  await loadSkills();
  initBrowser();
  initPreview();
  initTimeline();
  initVoiceover();
  initJobs();
  initInspector();
  initProjects();
  on("time", highlightTranscript);
  on("source-analyzed", renderTranscript);
  await bootProject();
  refreshWhisper();
  loadAllModelPickers();
})().catch((e) => { console.error(e); document.body.insertAdjacentHTML("afterbegin", `<div class="banner err" style="margin:12px">GUI failed to start: ${esc(e.message)} — check the terminal.</div>`); });
