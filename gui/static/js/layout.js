// Resizable panels. Each handle drives one CSS custom property on #app; the grid in
// app.css does the rest. Sizes are remembered per browser, and double-clicking a handle
// puts it back to the default.
import { byId, clamp } from "./ui.js";
import { emit } from "./state.js";

// var → [min, max, default]. `max` is a function of the window so a panel can never be
// dragged past the point where the rest of the layout has no room left.
const PANELS = {
  "--left":       { min: 220, max: () => Math.max(260, innerWidth * 0.5), def: 340 },
  "--right":      { min: 220, max: () => Math.max(260, innerWidth * 0.5), def: 330 },
  "--tl":         { min: 90, max: () => Math.max(120, innerHeight * 0.6), def: 250 },
  "--transcript": { min: 0, max: () => Math.max(40, innerHeight * 0.4), def: 64 },
};
const STORE = "ave.layout";

const read = () => { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } };
function write(sizes) { try { localStorage.setItem(STORE, JSON.stringify(sizes)); } catch { /* private mode */ } }

let sizes = {};
function apply(v) {
  const spec = PANELS[v];
  const px = clamp(sizes[v] ?? spec.def, spec.min, spec.max());
  byId("app").style.setProperty(v, px + "px");
}
export function applyAll() { for (const v in PANELS) apply(v); }

function set(v, px) {
  const spec = PANELS[v];
  sizes[v] = clamp(px, spec.min, spec.max());
  apply(v); write(sizes);
  emit("layout");
}

// `sign` maps pointer movement to panel growth: the right panel and the bottom panel
// grow when the pointer moves towards the start of the axis, so they get -1.
function drag(handleId, v, axis, sign) {
  const el = byId(handleId); if (!el) return;
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const from = axis === "x" ? e.clientX : e.clientY;
    const start = parseFloat(getComputedStyle(byId("app")).getPropertyValue(v)) || PANELS[v].def;
    el.setPointerCapture(e.pointerId);
    el.classList.add("dragging"); document.body.classList.add("resizing");
    const move = (ev) => set(v, start + sign * ((axis === "x" ? ev.clientX : ev.clientY) - from));
    const up = (ev) => {
      el.releasePointerCapture(ev.pointerId);
      el.classList.remove("dragging"); document.body.classList.remove("resizing");
      el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up);
      emit("layout");
    };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
  });
  el.addEventListener("dblclick", () => { delete sizes[v]; apply(v); write(sizes); emit("layout"); });
}

export function initLayout() {
  sizes = read();
  applyAll();
  drag("split-left", "--left", "x", 1);
  drag("split-right", "--right", "x", -1);
  drag("split-bottom", "--tl", "y", -1);
  drag("split-transcript", "--transcript", "y", -1);
  // a narrower window can invalidate a stored size
  addEventListener("resize", applyAll);
}
