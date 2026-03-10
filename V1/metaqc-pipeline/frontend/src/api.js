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

// ─── WebSocket helpers ──────────────────────────────────────────────────────

/**
 * Opens a WebSocket, sends the initial payload, and calls onMessage for each
 * incoming message. Returns a cleanup function to close the socket.
 */
function openWS(path, payload, onMessage, onClose) {
  const ws = new WebSocket(`${WS_BASE}${path}`);

  ws.onopen = () => {
    ws.send(JSON.stringify(payload));
  };

  ws.onmessage = (evt) => {
    try {
      const data = JSON.parse(evt.data);
      onMessage(data);
    } catch (e) {
      console.error("WS parse error:", e);
    }
  };

  ws.onerror = (err) => {
    console.error("WS error:", err);
  };

  ws.onclose = () => {
    if (onClose) onClose();
  };

  return () => {
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
