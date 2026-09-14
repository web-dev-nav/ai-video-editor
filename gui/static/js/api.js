// Thin fetch wrappers for the GUI server.
export async function api(url, opts) {
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || r.statusText); e.status = r.status; e.data = data; throw e; }
  return data;
}
const post = (url, body) => api(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const put = (url, body) => api(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const bootstrap = () => api("/api/bootstrap");
export const saveKey = (provider, api_key) => post("/api/key", { provider, api_key });
export const models = (provider, force) => api(`/api/models?provider=${provider}${force ? "&refresh=1" : ""}`);
export const skills = () => api("/api/skills");
export const whisperModels = () => api("/api/whisper/models");
export const whisperDownload = (m) => api(`/api/whisper/download?model=${m}`, { method: "POST" });
export const whisperStatus = (m) => api(`/api/whisper/status?model=${m}`);
export const browse = (path, kind = "video") => api(`/api/browse?path=${encodeURIComponent(path)}&kind=${kind}`);
export const info = (path) => api(`/api/info?path=${encodeURIComponent(path)}`);
export const upload = (file, kind = "video") => api(`/api/upload?name=${encodeURIComponent(file.name)}&kind=${kind}`, { method: "PUT", body: file });
export const media = (path) => `/api/media?path=${encodeURIComponent(path)}`;
export const jobCreate = (body) => post("/api/jobs", body);
export const jobs = () => api("/api/jobs");
export const job = (id, since = 0) => api(`/api/jobs/${id}?since=${since}`);
export const jobCancel = (id) => api(`/api/jobs/${id}/cancel`, { method: "POST" });
export const jobConfig = async (id) => (await fetch(`/api/jobs/${id}/config`)).text();
export const finalize = (body) => post("/api/plan/finalize", body);
export const transcript = (body) => post("/api/transcript", body);
export const ttsVoices = (engine) => api(`/api/tts/voices?engine=${engine}`);
export const ttsGenerate = (spec) => post("/api/tts/generate", spec);
export const ttsEstimate = (body) => post("/api/tts/estimate", body);
export const scriptSuggest = (body) => post("/api/script/suggest", body);
export const projects = () => api("/api/projects");
export const projectGet = (id) => api(`/api/projects/${id}`);
export const projectPut = (proj) => put(`/api/projects/${proj.id}`, proj);
export const projectDelete = (id) => api(`/api/projects/${id}`, { method: "DELETE" });
export const projectImport = (path) => post("/api/projects/import", { path });
