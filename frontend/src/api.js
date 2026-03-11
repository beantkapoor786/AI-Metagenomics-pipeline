/**
 * MetaQC Pipeline — API Client
 * REST calls + WebSocket connections to the FastAPI backend.
 */

// Auto-detect backend URL: in Docker, nginx proxies /api and /ws.
// For local dev, override with REACT_APP_API_URL.
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

export async function downloadReports({ sessionId, rawDataPath, multiqcName, includePostTrim, postTrimMultiqcName }) {
  const res = await fetch(`${BASE}/api/download-reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      raw_data_path: rawDataPath,
      multiqc_name: multiqcName,
      include_post_trim: includePostTrim,
      post_trim_multiqc_name: postTrimMultiqcName,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  // Trigger browser download
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

// ─── WebSocket helpers ──────────────────────────────────────────────────────

/**
 * Opens a WebSocket, sends the initial payload, and calls onMessage for each
 * incoming message. Returns a cleanup function to close the socket.
 */
function openWS(path, payload, onMessage, onClose) {
  const ws = new WebSocket(`${WS_BASE}${path}`);
  let receivedFinalStatus = false;

  ws.onopen = () => {
    ws.send(JSON.stringify(payload));
  };

  ws.onmessage = (evt) => {
    try {
      const data = JSON.parse(evt.data);
      if (data.type === "status" && (data.status === "success" || data.status === "error")) {
        receivedFinalStatus = true;
      }
      onMessage(data);
    } catch (e) {
      console.error("WS parse error:", e);
    }
  };

  ws.onerror = (err) => {
    console.error("WS error:", err);
    // Send error status so UI doesn't stay stuck
    if (!receivedFinalStatus) {
      onMessage({ type: "log", message: "ERROR WebSocket connection error", level: "error", stage: "fastqc" });
      onMessage({ type: "status", status: "error", stage: "fastqc" });
    }
  };

  ws.onclose = (evt) => {
    // If closed without a final status, report error so UI doesn't stay stuck
    if (!receivedFinalStatus) {
      onMessage({ type: "log", message: `ERROR Connection closed unexpectedly (code: ${evt.code})`, level: "error", stage: "fastqc" });
      onMessage({ type: "status", status: "error", stage: "fastqc" });
    }
    if (onClose) onClose();
  };

  return () => {
    receivedFinalStatus = true; // prevent error on intentional close
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  };
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
