/**
 * MetaQC Pipeline — API Client
 * REST calls + WebSocket connections to the FastAPI backend.
 */

const BASE = process.env.REACT_APP_API_URL || "";
const WS_BASE = BASE.replace(/^http/, "ws") || `ws://${window.location.host}`;

// ─── REST helpers ───────────────────────────────────────────────────────────

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function healthCheck() {
  const res = await fetch(`${BASE}/api/health`);
  return res.json();
}

export async function sshConnect({ hostname, port, username, authMethod, password, keyPath }) {
  return post("/api/ssh/connect", {
    hostname,
    port: parseInt(port, 10) || 22,
    username,
    auth_method: authMethod,
    password: authMethod === "password" ? password : undefined,
    key_path: authMethod === "key" ? keyPath : undefined,
  });
}

export async function sshDisconnect(sessionId) {
  return post(`/api/ssh/disconnect?session_id=${sessionId}`, {});
}

export async function scanDirectory(sessionId, path) {
  return post("/api/scan-directory", { session_id: sessionId, path });
}

export async function downloadReports({ sessionId, rawDataPath, multiqcName, includePostTrim, postTrimMultiqcName, includeDecontam, decontamMultiqcName }) {
  const res = await fetch(`${BASE}/api/download-reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      raw_data_path: rawDataPath,
      multiqc_name: multiqcName,
      include_post_trim: includePostTrim,
      post_trim_multiqc_name: postTrimMultiqcName,
      include_decontam: includeDecontam || false,
      decontam_multiqc_name: decontamMultiqcName || "",
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "multiqc_reports.zip";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Autocomplete ───────────────────────────────────────────────────────────

export async function loadAllSuggestions() {
  try {
    const res = await fetch(`${BASE}/api/autocomplete/all`);
    if (res.ok) return res.json();
  } catch (e) { /* ignore */ }
  return {};
}

export async function saveSuggestions(fields) {
  try {
    await post("/api/autocomplete/save", { fields });
  } catch (e) { /* ignore */ }
}

// ─── WebSocket helpers ──────────────────────────────────────────────────────

function openWS(path, payload, onMessage, onClose) {
  const ws = new WebSocket(`${WS_BASE}${path}`);
  ws.onopen = () => ws.send(JSON.stringify(payload));
  ws.onmessage = (evt) => {
    try { onMessage(JSON.parse(evt.data)); } catch (e) { console.error("WS parse error:", e); }
  };
  ws.onerror = (err) => console.error("WS error:", err);
  ws.onclose = () => { if (onClose) onClose(); };
  return () => { if (ws.readyState <= 1) ws.close(); };
}

export function wsInstallTools(payload, onMessage, onClose) {
  return openWS("/ws/install-tools", payload, onMessage, onClose);
}

export function wsRunPipeline(payload, onMessage, onClose) {
  return openWS("/ws/run-pipeline", payload, onMessage, onClose);
}

export function wsSetupBBDuk(payload, onMessage, onClose) {
  return openWS("/ws/setup-bbduk", payload, onMessage, onClose);
}

export function wsRunPreprocessing(payload, onMessage, onClose) {
  return openWS("/ws/run-preprocessing", payload, onMessage, onClose);
}

export function wsRunDecontamination(payload, onMessage, onClose) {
  return openWS("/ws/run-decontamination", payload, onMessage, onClose);
}
