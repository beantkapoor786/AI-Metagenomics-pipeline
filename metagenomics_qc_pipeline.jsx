import { useState, useEffect, useRef, useCallback } from "react";

// ─── Configuration ──────────────────────────────────────────────────────────
// When running via Docker Compose, the backend is at localhost:8000
// Change this if your backend is hosted elsewhere
const API_BASE = window.location.hostname === "localhost"
  ? "http://localhost:8000"
  : `${window.location.protocol}//${window.location.hostname}:8000`;
const WS_BASE = API_BASE.replace("http", "ws");

// ─── Constants ──────────────────────────────────────────────────────────────
const STEPS = [
  { id: "connect", label: "SSH Connection", icon: "🔗" },
  { id: "tools", label: "Tool Setup", icon: "🧰" },
  { id: "configure", label: "Configure Pipeline", icon: "⚙️" },
  { id: "review", label: "Review & Run", icon: "🚀" },
  { id: "running", label: "Execution", icon: "📊" },
];

const TOOL_METHODS = [
  { id: "conda", label: "Conda / Mamba", icon: "🐍", desc: "Use conda or mamba to manage environments" },
  { id: "pixi", label: "Pixi", icon: "📦", desc: "Use pixi package manager" },
  { id: "path", label: "Already in PATH", icon: "✅", desc: "Tools already installed and accessible" },
];

const FASTQ_PATTERNS = [
  { regex: "_R1_001.fastq.gz", label: "_R1/_R2_001.fastq.gz (Illumina)" },
  { regex: "_1.fastq.gz", label: "_1/_2.fastq.gz" },
  { regex: "_R1.fastq.gz", label: "_R1/_R2.fastq.gz" },
  { regex: ".R1.fastq.gz", label: ".R1/.R2.fastq.gz" },
];

const S = { idle: "idle", running: "running", success: "success", error: "error" };
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── API Helper ─────────────────────────────────────────────────────────────
async function apiFetch(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ─── Reusable UI Components ────────────────────────────────────────────────

function StepIndicator({ steps, currentStep }) {
  const idx = steps.findIndex(s => s.id === currentStep);
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 0,
      padding: "20px 28px", borderBottom: "1px solid rgba(255,255,255,0.06)",
      background: "linear-gradient(135deg, rgba(15,23,42,0.6), rgba(15,23,42,0.3))",
      backdropFilter: "blur(20px)", overflowX: "auto",
    }}>
      {steps.map((step, i) => {
        const active = i === idx, done = i < idx, last = i === steps.length - 1;
        return (
          <div key={step.id} style={{ display: "flex", alignItems: "center", flex: last ? "0 0 auto" : "1" }}>
            <div style={{
              display: "flex", alignItems: "center", gap: "8px",
              padding: "7px 14px", borderRadius: "10px", whiteSpace: "nowrap",
              background: active ? "linear-gradient(135deg, #06b6d4, #0891b2)" : done ? "rgba(6,182,212,0.15)" : "rgba(255,255,255,0.03)",
              border: active ? "1px solid rgba(6,182,212,0.5)" : done ? "1px solid rgba(6,182,212,0.2)" : "1px solid rgba(255,255,255,0.06)",
              transition: "all 0.4s cubic-bezier(0.16,1,0.3,1)",
              boxShadow: active ? "0 0 20px rgba(6,182,212,0.25)" : "none",
            }}>
              <span style={{ fontSize: "14px" }}>{done ? "✓" : step.icon}</span>
              <span style={{
                fontSize: "12px", fontWeight: active ? "600" : "400",
                color: active ? "#fff" : done ? "#06b6d4" : "rgba(255,255,255,0.4)",
              }}>{step.label}</span>
            </div>
            {!last && <div style={{
              flex: 1, height: "2px", margin: "0 6px",
              background: done ? "rgba(6,182,212,0.4)" : "rgba(255,255,255,0.06)",
              borderRadius: "1px", minWidth: "12px",
            }} />}
          </div>
        );
      })}
    </div>
  );
}

function InputField({ label, value, onChange, type = "text", placeholder, hint, required, disabled, mono, style }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px", ...style }}>
      <label style={{ fontSize: "11px", fontWeight: "500", color: "rgba(255,255,255,0.5)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
        {label} {required && <span style={{ color: "#f43f5e" }}>*</span>}
      </label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} disabled={disabled}
        style={{
          padding: "11px 14px", borderRadius: "10px", border: "1px solid rgba(255,255,255,0.08)",
          background: disabled ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.04)",
          color: disabled ? "rgba(255,255,255,0.3)" : "#e2e8f0", fontSize: "13px", outline: "none",
          fontFamily: mono ? "'JetBrains Mono', monospace" : "'IBM Plex Sans', sans-serif",
          transition: "all 0.2s ease",
        }}
        onFocus={e => { e.target.style.borderColor = "rgba(6,182,212,0.5)"; e.target.style.boxShadow = "0 0 0 3px rgba(6,182,212,0.1)"; }}
        onBlur={e => { e.target.style.borderColor = "rgba(255,255,255,0.08)"; e.target.style.boxShadow = "none"; }}
      />
      {hint && <span style={{ fontSize: "11px", color: "rgba(255,255,255,0.3)" }}>{hint}</span>}
    </div>
  );
}

function NumberField({ label, value, onChange, min, max, defaultVal, hint }) {
  const nb = { width: "34px", height: "34px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.05)", color: "#06b6d4", fontSize: "16px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <label style={{ fontSize: "11px", fontWeight: "500", color: "rgba(255,255,255,0.5)", letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</label>
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <button onClick={() => onChange(Math.max(min || 1, value - 1))} style={nb}>−</button>
        <input type="number" value={value} onChange={e => onChange(Number(e.target.value))} min={min} max={max}
          style={{ width: "64px", padding: "8px", borderRadius: "10px", border: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.04)", color: "#e2e8f0", fontSize: "15px", textAlign: "center", outline: "none", fontFamily: "'JetBrains Mono', monospace", fontWeight: "600" }} />
        <button onClick={() => onChange(Math.min(max || 128, value + 1))} style={nb}>+</button>
        <span style={{ fontSize: "11px", color: "rgba(255,255,255,0.3)", marginLeft: "4px" }}>threads (default: {defaultVal})</span>
      </div>
      {hint && <span style={{ fontSize: "11px", color: "rgba(255,255,255,0.3)" }}>{hint}</span>}
    </div>
  );
}

function Card({ children, style }) {
  return (
    <div style={{
      background: "linear-gradient(135deg, rgba(255,255,255,0.02), rgba(255,255,255,0.04))",
      border: "1px solid rgba(255,255,255,0.06)", borderRadius: "16px", padding: "26px 28px", marginBottom: "18px", ...style,
    }}>{children}</div>
  );
}

function CardTitle({ icon, children }) {
  return <h3 style={{ margin: "0 0 18px", fontSize: "15px", fontWeight: "600", color: "#06b6d4", display: "flex", alignItems: "center", gap: "8px" }}>{icon} {children}</h3>;
}

function PrimaryBtn({ onClick, disabled, children, color = "cyan", style }) {
  const colors = { cyan: { bg: "linear-gradient(135deg, #06b6d4, #0891b2)", shadow: "rgba(6,182,212,0.3)" }, green: { bg: "linear-gradient(135deg, #10b981, #059669)", shadow: "rgba(16,185,129,0.35)" } };
  const c = colors[color];
  return (
    <button onClick={onClick} disabled={disabled} style={{
      flex: 1, padding: "14px", borderRadius: "12px", border: "none",
      background: disabled ? "rgba(255,255,255,0.05)" : c.bg,
      color: disabled ? "rgba(255,255,255,0.3)" : "#fff",
      fontSize: "14px", fontWeight: "600", cursor: disabled ? "not-allowed" : "pointer",
      boxShadow: disabled ? "none" : `0 4px 20px ${c.shadow}`,
      transition: "all 0.3s ease", ...style,
    }}>{children}</button>
  );
}

function BackBtn({ onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: "14px 24px", borderRadius: "12px", border: "1px solid rgba(255,255,255,0.1)",
      background: "rgba(255,255,255,0.03)", color: "rgba(255,255,255,0.5)", fontSize: "13px",
      fontWeight: "500", cursor: "pointer",
    }}>← Back</button>
  );
}

function LogViewer({ logs, expanded, onToggle, title, status }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [logs]);
  const sc = { [S.idle]: "rgba(255,255,255,0.3)", [S.running]: "#f59e0b", [S.success]: "#10b981", [S.error]: "#f43f5e" };
  const sl = { [S.idle]: "Waiting", [S.running]: "Running…", [S.success]: "Complete", [S.error]: "Failed" };
  return (
    <div style={{ borderRadius: "14px", border: "1px solid rgba(255,255,255,0.06)", background: "rgba(0,0,0,0.3)", overflow: "hidden" }}>
      <div onClick={onToggle} style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "13px 18px", cursor: "pointer", background: "rgba(255,255,255,0.02)",
        borderBottom: expanded ? "1px solid rgba(255,255,255,0.06)" : "none",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{
            width: "9px", height: "9px", borderRadius: "50%", background: sc[status],
            boxShadow: status === S.running ? `0 0 12px ${sc[status]}` : "none",
            animation: status === S.running ? "pulse 1.5s infinite" : "none",
          }} />
          <span style={{ fontSize: "13px", fontWeight: "600", color: "#e2e8f0" }}>{title}</span>
          <span style={{
            fontSize: "10px", color: sc[status], padding: "2px 9px", borderRadius: "20px",
            background: `${sc[status]}15`, border: `1px solid ${sc[status]}30`,
          }}>{sl[status]}</span>
        </div>
        <span style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s ease", fontSize: "12px", color: "rgba(255,255,255,0.4)" }}>▼</span>
      </div>
      {expanded && (
        <div ref={ref} style={{
          maxHeight: "260px", overflowY: "auto", padding: "14px 18px",
          fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", lineHeight: "1.8", color: "rgba(255,255,255,0.6)",
        }}>
          {logs.length === 0 ? <span style={{ color: "rgba(255,255,255,0.2)", fontStyle: "italic" }}>No output yet…</span>
            : logs.map((log, i) => (
              <div key={i} style={{
                color: log.startsWith("ERROR") || log.startsWith("✗") ? "#f43f5e" :
                  log.startsWith("✓") || log.startsWith("SUCCESS") ? "#10b981" :
                  log.startsWith("$") ? "#06b6d4" : log.startsWith(">>>") ? "#f59e0b" : "rgba(255,255,255,0.55)",
              }}>{log}</div>
            ))}
          {status === S.running && <span style={{ color: "#06b6d4", animation: "blink 1s infinite" }}>█</span>}
        </div>
      )}
    </div>
  );
}

function DirectoryTree({ rawDataPath }) {
  const parentDir = rawDataPath ? rawDataPath.replace(/\/[^/]+\/?$/, "") : "/path/to/project";
  const rawDirName = rawDataPath ? rawDataPath.split("/").filter(Boolean).pop() : "raw_data";
  const items = [
    { depth: 0, name: `${rawDirName}/`, icon: "📁", hl: false, desc: "raw FASTQ files" },
    { depth: 0, name: "analyses/", icon: "📁", hl: true },
    { depth: 1, name: "1_QC/", icon: "📁", hl: true },
    { depth: 2, name: "input/", icon: "📂", desc: "→ symlinked .fastq.gz" },
    { depth: 2, name: "output/", icon: "📂" },
    { depth: 3, name: "fastqc_reports/", icon: "📊", desc: "FastQC HTML + ZIP" },
    { depth: 3, name: "multiqc_report/", icon: "📊", desc: "MultiQC HTML report" },
    { depth: 2, name: "logs/", icon: "📋", desc: "fastqc.log, multiqc.log" },
    { depth: 2, name: "scripts/", icon: "📜", desc: "Versioned run scripts" },
  ];
  return (
    <div style={{
      borderRadius: "12px", border: "1px solid rgba(255,255,255,0.06)",
      background: "rgba(0,0,0,0.25)", padding: "18px 22px",
      fontFamily: "'JetBrains Mono', monospace", fontSize: "12px",
    }}>
      <div style={{ color: "rgba(255,255,255,0.3)", marginBottom: "10px", fontSize: "11px" }}>{parentDir}/</div>
      {items.map((item, i) => (
        <div key={i} style={{
          display: "flex", alignItems: "center", gap: "6px",
          padding: `2px 0 2px ${item.depth * 22}px`,
          color: item.hl ? "#06b6d4" : "rgba(255,255,255,0.55)",
        }}>
          {item.depth > 0 && <span style={{ color: "rgba(255,255,255,0.15)" }}>├── </span>}
          <span>{item.icon}</span>
          <span style={{ fontWeight: item.hl ? "600" : "400" }}>{item.name}</span>
          {item.desc && <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.22)", fontStyle: "italic" }}>{item.desc}</span>}
        </div>
      ))}
    </div>
  );
}

// ─── Main Application ───────────────────────────────────────────────────────
export default function MetagenomicsQCPipeline() {
  const [step, setStep] = useState("connect");
  const [sessionId, setSessionId] = useState(null);
  const [backendAlive, setBackendAlive] = useState(null); // null=checking, true, false

  // SSH
  const [sshCfg, setSSHCfg] = useState({ hostname: "", port: "22", username: "", authMethod: "password", password: "", keyPath: "" });
  const [sshStatus, setSSHStatus] = useState(S.idle);
  const [sshError, setSSHError] = useState("");
  const [sshLogs, setSSHLogs] = useState([]);
  const [sshLogExpanded, setSSHLogExpanded] = useState(true);

  // Tool config
  const [toolCfg, setToolCfg] = useState({
    method: "", condaUseMamba: false, condaCreateNew: true, condaEnvName: "metagenomics_qc",
    pixiCreateNew: true, pixiProjectPath: "",
    needsInstallFastqc: true, needsInstallMultiqc: true,
  });
  const [installStatus, setInstallStatus] = useState(S.idle);
  const [installLogs, setInstallLogs] = useState([]);
  const [installExpanded, setInstallExpanded] = useState(true);

  // Pipeline config
  const [pipeCfg, setPipeCfg] = useState({ rawDataPath: "", fastqcThreads: 8, multiqcName: "multiqc_report" });
  const [detectedFiles, setDetectedFiles] = useState([]);
  const [detectedPattern, setDetectedPattern] = useState("");
  const [scanStatus, setScanStatus] = useState(S.idle);
  const [scanError, setScanError] = useState("");

  // Execution
  const [fqcStatus, setFqcStatus] = useState(S.idle);
  const [mqcStatus, setMqcStatus] = useState(S.idle);
  const [fqcLogs, setFqcLogs] = useState([]);
  const [mqcLogs, setMqcLogs] = useState([]);
  const [fqcExpanded, setFqcExpanded] = useState(true);
  const [mqcExpanded, setMqcExpanded] = useState(true);
  const [editingMqcName, setEditingMqcName] = useState(false);

  // ── Check backend health on mount ──
  useEffect(() => {
    fetch(`${API_BASE}/health`).then(r => r.json())
      .then(() => setBackendAlive(true))
      .catch(() => setBackendAlive(false));
  }, []);

  // ── SSH Connect (real) ──
  const handleConnect = async () => {
    setSSHStatus(S.running); setSSHError(""); setSSHLogs([]);
    const addLog = (msg) => setSSHLogs(p => [...p, msg]);

    addLog(`>>> Connecting to ${sshCfg.hostname}:${sshCfg.port}...`);
    addLog(`$ ssh ${sshCfg.authMethod === "key" ? `-i ${sshCfg.keyPath} ` : ""}-p ${sshCfg.port} ${sshCfg.username}@${sshCfg.hostname}`);

    try {
      const result = await apiFetch("/ssh/connect", {
        hostname: sshCfg.hostname,
        port: parseInt(sshCfg.port) || 22,
        username: sshCfg.username,
        auth_method: sshCfg.authMethod,
        password: sshCfg.authMethod === "password" ? sshCfg.password : null,
        key_path: sshCfg.authMethod === "key" ? sshCfg.keyPath : null,
      });

      if (result.success) {
        setSessionId(result.session_id);
        addLog(`  ✓ SSH handshake complete`);
        addLog(`  ✓ Authenticated as ${result.remote_user}`);
        addLog(`  ✓ Remote host: ${result.remote_host}`);
        addLog(``);
        addLog(`SUCCESS ${result.message}`);
        setSSHStatus(S.success);
        setTimeout(() => setStep("tools"), 1000);
      } else {
        addLog(`  ✗ ${result.error}`);
        setSSHStatus(S.error);
        setSSHError(result.error);
      }
    } catch (err) {
      const msg = `Cannot reach backend at ${API_BASE}. Is the server running?`;
      addLog(`ERROR ${msg}`);
      setSSHStatus(S.error);
      setSSHError(msg);
    }
  };

  // ── Scan Directory (real) ──
  const handleScanDirectory = async () => {
    if (!pipeCfg.rawDataPath || !sessionId) return;
    setScanStatus(S.running); setScanError(""); setDetectedFiles([]); setDetectedPattern("");

    try {
      const result = await apiFetch("/scan", {
        session_id: sessionId,
        path: pipeCfg.rawDataPath,
      });

      if (!result.success) {
        setScanStatus(S.error);
        setScanError(result.error || "Scan failed.");
        return;
      }

      const files = result.files || [];
      setDetectedFiles(files);

      if (files.length === 0) {
        setScanStatus(S.error);
        setScanError(result.message || `No .fastq.gz files found in ${pipeCfg.rawDataPath}`);
        return;
      }

      // Auto-detect naming pattern
      let patternFound = false;
      for (const pat of FASTQ_PATTERNS) {
        const marker = pat.regex.replace(".fastq.gz", "");
        if (files.some(f => f.includes(marker))) {
          setDetectedPattern(pat.label);
          patternFound = true;
          break;
        }
      }

      if (!patternFound) {
        setDetectedPattern("");
        setScanError("Warning: Could not auto-detect a known paired-end naming pattern. Files found but pattern may be non-standard.");
      }

      setScanStatus(S.success);
    } catch (err) {
      setScanStatus(S.error);
      setScanError(`Cannot reach backend: ${err.message}`);
    }
  };

  // ── Install Tools (WebSocket) ──
  const handleInstall = () => {
    setInstallStatus(S.running); setInstallLogs([]);
    const ws = new WebSocket(`${WS_BASE}/ws/install`);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        session_id: sessionId,
        tool_method: toolCfg.method,
        conda_use_mamba: toolCfg.condaUseMamba,
        conda_create_new: toolCfg.condaCreateNew,
        conda_env_name: toolCfg.condaEnvName,
        pixi_create_new: toolCfg.pixiCreateNew,
        pixi_project_path: toolCfg.pixiProjectPath,
        needs_install_fastqc: toolCfg.needsInstallFastqc,
        needs_install_multiqc: toolCfg.needsInstallMultiqc,
      }));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "log") {
        setInstallLogs(p => [...p, msg.line]);
      } else if (msg.type === "complete") {
        setInstallStatus(msg.status === "success" ? S.success : S.error);
      } else if (msg.type === "error") {
        setInstallLogs(p => [...p, `ERROR ${msg.message}`]);
        setInstallStatus(S.error);
      }
    };

    ws.onerror = () => {
      setInstallLogs(p => [...p, `ERROR WebSocket connection failed`]);
      setInstallStatus(S.error);
    };
  };

  // ── Run Pipeline (WebSocket) ──
  const runPipeline = () => {
    setStep("running"); setFqcLogs([]); setMqcLogs([]); setFqcStatus(S.running); setMqcStatus(S.idle);

    const ws = new WebSocket(`${WS_BASE}/ws/pipeline`);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        session_id: sessionId,
        raw_data_path: pipeCfg.rawDataPath,
        fastqc_threads: pipeCfg.fastqcThreads,
        multiqc_name: pipeCfg.multiqcName,
        tool_method: toolCfg.method,
        conda_use_mamba: toolCfg.condaUseMamba,
        conda_env_name: toolCfg.condaEnvName,
        pixi_project_path: toolCfg.pixiProjectPath,
      }));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === "log") {
        if (msg.stage === "fastqc") setFqcLogs(p => [...p, msg.line]);
        else if (msg.stage === "multiqc") setMqcLogs(p => [...p, msg.line]);
      } else if (msg.type === "status") {
        if (msg.stage === "fastqc") setFqcStatus(S.running);
        else if (msg.stage === "multiqc") { setMqcStatus(S.running); }
      } else if (msg.type === "stage_complete") {
        const st = msg.status === "success" ? S.success : S.error;
        if (msg.stage === "fastqc") setFqcStatus(st);
        else if (msg.stage === "multiqc") setMqcStatus(st);
      } else if (msg.type === "pipeline_complete") {
        // All done
      } else if (msg.type === "error") {
        if (msg.stage === "fastqc") { setFqcLogs(p => [...p, `ERROR ${msg.message}`]); setFqcStatus(S.error); }
        else if (msg.stage === "multiqc") { setMqcLogs(p => [...p, `ERROR ${msg.message}`]); setMqcStatus(S.error); }
        else { setFqcLogs(p => [...p, `ERROR ${msg.message}`]); setFqcStatus(S.error); }
      }
    };

    ws.onerror = () => {
      setFqcLogs(p => [...p, "ERROR WebSocket connection failed"]);
      setFqcStatus(S.error);
    };
  };

  // ── Derived state ──
  const canConfigProceed = pipeCfg.rawDataPath && pipeCfg.multiqcName && detectedFiles.length > 0 && scanStatus === S.success;
  const toolReady = installStatus === S.success;
  const needsInstall = toolCfg.needsInstallFastqc || toolCfg.needsInstallMultiqc;
  const canProceedFromTools = toolCfg.method && (toolCfg.method === "path" ? toolReady :
    toolCfg.method === "conda" ? toolCfg.condaEnvName && toolReady :
    toolCfg.method === "pixi" ? toolCfg.pixiProjectPath && toolReady : false);
  const toolMethodSummary = toolCfg.method === "conda"
    ? `${toolCfg.condaUseMamba ? "Mamba" : "Conda"} (env: ${toolCfg.condaEnvName})`
    : toolCfg.method === "pixi" ? `Pixi (${toolCfg.pixiProjectPath})`
    : "System PATH";

  // ── Render ──
  return (
    <div style={{
      minHeight: "100vh", background: "#080c14", color: "#e2e8f0",
      fontFamily: "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
        @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.4 } }
        @keyframes blink { 0%,100% { opacity:1 } 50% { opacity:0 } }
        @keyframes fadeIn { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
        input::-webkit-outer-spin-button, input::-webkit-inner-spin-button { -webkit-appearance:none; margin:0 }
        input[type=number] { -moz-appearance:textfield }
        ::-webkit-scrollbar { width:5px } ::-webkit-scrollbar-track { background:transparent }
        ::-webkit-scrollbar-thumb { background:rgba(6,182,212,0.2); border-radius:3px }
      `}</style>

      {/* Header */}
      <div style={{
        padding: "24px 32px", display: "flex", alignItems: "center", justifyContent: "space-between",
        background: "linear-gradient(180deg, rgba(6,182,212,0.08) 0%, transparent 100%)",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
          <div style={{
            width: "42px", height: "42px", borderRadius: "11px",
            background: "linear-gradient(135deg, #06b6d4, #0e7490)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "20px", boxShadow: "0 0 28px rgba(6,182,212,0.3)",
          }}>🧬</div>
          <div>
            <h1 style={{
              margin: 0, fontSize: "20px", fontWeight: "700",
              background: "linear-gradient(135deg, #e2e8f0, #06b6d4)",
              WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
            }}>MetaQC Pipeline</h1>
            <p style={{ margin: 0, fontSize: "11px", color: "rgba(255,255,255,0.3)", letterSpacing: "0.1em", textTransform: "uppercase" }}>
              Metagenomics Quality Control
            </p>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
          {/* Backend status */}
          <div style={{
            display: "flex", alignItems: "center", gap: "7px",
            padding: "6px 12px", borderRadius: "8px",
            background: backendAlive === true ? "rgba(16,185,129,0.08)" : backendAlive === false ? "rgba(244,63,94,0.08)" : "rgba(255,255,255,0.03)",
            border: `1px solid ${backendAlive === true ? "rgba(16,185,129,0.15)" : backendAlive === false ? "rgba(244,63,94,0.15)" : "rgba(255,255,255,0.06)"}`,
          }}>
            <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: backendAlive === true ? "#10b981" : backendAlive === false ? "#f43f5e" : "#f59e0b", animation: backendAlive === null ? "pulse 1s infinite" : "none" }} />
            <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.45)" }}>
              {backendAlive === true ? "Backend" : backendAlive === false ? "Backend offline" : "Checking..."}
            </span>
          </div>
          {/* SSH status */}
          <div style={{
            display: "flex", alignItems: "center", gap: "7px",
            padding: "6px 12px", borderRadius: "8px",
            background: sshStatus === S.success ? "rgba(16,185,129,0.08)" : "rgba(255,255,255,0.03)",
            border: `1px solid ${sshStatus === S.success ? "rgba(16,185,129,0.15)" : "rgba(255,255,255,0.06)"}`,
          }}>
            <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: sshStatus === S.success ? "#10b981" : "rgba(255,255,255,0.2)" }} />
            <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.45)" }}>
              {sshStatus === S.success ? `${sshCfg.hostname}:${sshCfg.port}` : "SSH"}
            </span>
          </div>
        </div>
      </div>

      <StepIndicator steps={STEPS} currentStep={step} />

      <div style={{ maxWidth: "860px", margin: "0 auto", padding: "32px 20px", animation: "fadeIn 0.4s ease" }}>

        {/* Backend offline warning */}
        {backendAlive === false && step === "connect" && (
          <div style={{
            marginBottom: "20px", padding: "14px 18px", borderRadius: "12px",
            background: "rgba(244,63,94,0.08)", border: "1px solid rgba(244,63,94,0.2)",
            animation: "fadeIn 0.3s ease",
          }}>
            <div style={{ fontSize: "13px", fontWeight: "600", color: "#f43f5e", marginBottom: "6px" }}>⚠ Backend server not reachable</div>
            <div style={{ fontSize: "12px", color: "rgba(255,255,255,0.5)", lineHeight: "1.6" }}>
              The FastAPI backend at <code style={{ background: "rgba(0,0,0,0.3)", padding: "2px 6px", borderRadius: "4px", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px" }}>{API_BASE}</code> is not responding.
              Start it with: <code style={{ background: "rgba(0,0,0,0.3)", padding: "2px 6px", borderRadius: "4px", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px" }}>docker compose up</code>
            </div>
          </div>
        )}

        {/* ══════ STEP 1: SSH ══════ */}
        {step === "connect" && (
          <div style={{ animation: "fadeIn 0.5s ease" }}>
            <h2 style={{ margin: "0 0 6px", fontSize: "26px", fontWeight: "700" }}>Connect to HPC</h2>
            <p style={{ margin: "0 0 28px", color: "rgba(255,255,255,0.4)", fontSize: "13px" }}>
              Establish a direct SSH connection to your high-performance computing cluster.
            </p>
            <Card>
              <CardTitle icon="🖥️">SSH Connection Details</CardTitle>
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "18px", marginBottom: "18px" }}>
                <InputField label="Hostname / IP" value={sshCfg.hostname} onChange={v => setSSHCfg(p => ({ ...p, hostname: v }))} placeholder="hpc.university.edu" hint="HPC hostname or IP address" required mono />
                <InputField label="Port" value={sshCfg.port} onChange={v => setSSHCfg(p => ({ ...p, port: v }))} placeholder="22" hint="Default: 22" mono />
              </div>
              <div style={{ marginBottom: "18px" }}>
                <InputField label="Username" value={sshCfg.username} onChange={v => setSSHCfg(p => ({ ...p, username: v }))} placeholder="your_username" required mono />
              </div>

              <div style={{ marginBottom: "18px" }}>
                <label style={{ fontSize: "11px", fontWeight: "500", color: "rgba(255,255,255,0.5)", letterSpacing: "0.08em", textTransform: "uppercase", display: "block", marginBottom: "8px" }}>
                  Authentication Method
                </label>
                <div style={{ display: "flex", gap: "10px" }}>
                  {[{ id: "password", label: "🔑 Password", desc: "Username & password" }, { id: "key", label: "🗝️ SSH Key", desc: "Private key file" }].map(m => {
                    const sel = sshCfg.authMethod === m.id;
                    return (
                      <div key={m.id} onClick={() => setSSHCfg(p => ({ ...p, authMethod: m.id }))} style={{
                        flex: 1, padding: "14px 16px", borderRadius: "10px", cursor: "pointer",
                        background: sel ? "rgba(6,182,212,0.1)" : "rgba(255,255,255,0.02)",
                        border: sel ? "1.5px solid rgba(6,182,212,0.5)" : "1px solid rgba(255,255,255,0.06)",
                        boxShadow: sel ? "0 0 16px rgba(6,182,212,0.1)" : "none",
                      }}>
                        <div style={{ fontSize: "13px", fontWeight: "600", color: sel ? "#06b6d4" : "#e2e8f0", marginBottom: "2px" }}>{m.label}</div>
                        <div style={{ fontSize: "11px", color: "rgba(255,255,255,0.35)" }}>{m.desc}</div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {sshCfg.authMethod === "password" && (
                <div style={{ marginBottom: "18px", animation: "fadeIn 0.2s ease" }}>
                  <InputField label="Password" value={sshCfg.password} onChange={v => setSSHCfg(p => ({ ...p, password: v }))} type="password" placeholder="••••••••" required />
                </div>
              )}
              {sshCfg.authMethod === "key" && (
                <div style={{ marginBottom: "18px", animation: "fadeIn 0.2s ease" }}>
                  <InputField label="Private Key Path" value={sshCfg.keyPath} onChange={v => setSSHCfg(p => ({ ...p, keyPath: v }))} placeholder="/home/user/.ssh/id_rsa" hint="Path on the machine running the backend server" required mono />
                </div>
              )}

              <div style={{
                marginBottom: "18px", padding: "10px 14px", borderRadius: "10px",
                background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.04)",
              }}>
                <div style={{ fontSize: "10px", color: "rgba(255,255,255,0.3)", marginBottom: "4px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Command Preview</div>
                <code style={{ fontSize: "12px", color: "#06b6d4", fontFamily: "'JetBrains Mono', monospace" }}>
                  ssh {sshCfg.authMethod === "key" && sshCfg.keyPath ? `-i ${sshCfg.keyPath} ` : ""}-p {sshCfg.port || "22"} {sshCfg.username || "<user>"}@{sshCfg.hostname || "<hostname>"}
                </code>
              </div>

              {sshError && <div style={{ marginBottom: "16px", padding: "10px 14px", borderRadius: "10px", background: "rgba(244,63,94,0.1)", border: "1px solid rgba(244,63,94,0.2)", color: "#f43f5e", fontSize: "12px" }}>✗ {sshError}</div>}

              <PrimaryBtn onClick={handleConnect}
                disabled={backendAlive !== true || sshStatus === S.running || !sshCfg.hostname || !sshCfg.username ||
                  (sshCfg.authMethod === "password" && !sshCfg.password) || (sshCfg.authMethod === "key" && !sshCfg.keyPath)}>
                {sshStatus === S.running ? "⟳ Connecting…" : sshStatus === S.success ? "✓ Connected — Proceeding…" : "🔗 Establish SSH Connection"}
              </PrimaryBtn>

              {sshLogs.length > 0 && (
                <div style={{ marginTop: "16px" }}>
                  <LogViewer title="SSH Connection" logs={sshLogs} status={sshStatus} expanded={sshLogExpanded} onToggle={() => setSSHLogExpanded(p => !p)} />
                </div>
              )}
            </Card>
          </div>
        )}

        {/* ══════ STEP 2: Tool Setup ══════ */}
        {step === "tools" && (
          <div style={{ animation: "fadeIn 0.5s ease" }}>
            <h2 style={{ margin: "0 0 6px", fontSize: "26px", fontWeight: "700" }}>Tool Setup</h2>
            <p style={{ margin: "0 0 28px", color: "rgba(255,255,255,0.4)", fontSize: "13px" }}>Configure how FastQC and MultiQC are managed on the HPC.</p>

            <Card>
              <CardTitle icon="🧰">Package Manager</CardTitle>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px" }}>
                {TOOL_METHODS.map(m => {
                  const sel = toolCfg.method === m.id;
                  return (
                    <div key={m.id} onClick={() => { setToolCfg(p => ({ ...p, method: m.id })); setInstallStatus(S.idle); setInstallLogs([]); }}
                      style={{
                        padding: "18px 16px", borderRadius: "12px", cursor: "pointer", textAlign: "center",
                        background: sel ? "rgba(6,182,212,0.1)" : "rgba(255,255,255,0.02)",
                        border: sel ? "1.5px solid rgba(6,182,212,0.5)" : "1px solid rgba(255,255,255,0.06)",
                        boxShadow: sel ? "0 0 20px rgba(6,182,212,0.15)" : "none",
                      }}>
                      <div style={{ fontSize: "24px", marginBottom: "8px" }}>{m.icon}</div>
                      <div style={{ fontSize: "14px", fontWeight: "600", color: sel ? "#06b6d4" : "#e2e8f0", marginBottom: "4px" }}>{m.label}</div>
                      <div style={{ fontSize: "11px", color: "rgba(255,255,255,0.35)" }}>{m.desc}</div>
                    </div>
                  );
                })}
              </div>
            </Card>

            {toolCfg.method === "conda" && (
              <Card style={{ animation: "fadeIn 0.3s ease" }}>
                <CardTitle icon="🐍">Conda / Mamba Configuration</CardTitle>
                <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "20px" }}>
                  <span style={{ fontSize: "12px", color: "rgba(255,255,255,0.5)" }}>Manager:</span>
                  {["conda", "mamba"].map(opt => (
                    <button key={opt} onClick={() => setToolCfg(p => ({ ...p, condaUseMamba: opt === "mamba" }))} style={{
                      padding: "6px 16px", borderRadius: "8px", fontSize: "13px", fontWeight: "500", cursor: "pointer",
                      background: (opt === "mamba" ? toolCfg.condaUseMamba : !toolCfg.condaUseMamba) ? "rgba(6,182,212,0.15)" : "rgba(255,255,255,0.03)",
                      border: (opt === "mamba" ? toolCfg.condaUseMamba : !toolCfg.condaUseMamba) ? "1px solid rgba(6,182,212,0.4)" : "1px solid rgba(255,255,255,0.08)",
                      color: (opt === "mamba" ? toolCfg.condaUseMamba : !toolCfg.condaUseMamba) ? "#06b6d4" : "rgba(255,255,255,0.4)",
                    }}>{opt}</button>
                  ))}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "20px" }}>
                  <span style={{ fontSize: "12px", color: "rgba(255,255,255,0.5)" }}>Environment:</span>
                  {[{ v: true, l: "Create new" }, { v: false, l: "Use existing" }].map(opt => (
                    <button key={String(opt.v)} onClick={() => setToolCfg(p => ({ ...p, condaCreateNew: opt.v }))} style={{
                      padding: "6px 16px", borderRadius: "8px", fontSize: "13px", fontWeight: "500", cursor: "pointer",
                      background: toolCfg.condaCreateNew === opt.v ? "rgba(6,182,212,0.15)" : "rgba(255,255,255,0.03)",
                      border: toolCfg.condaCreateNew === opt.v ? "1px solid rgba(6,182,212,0.4)" : "1px solid rgba(255,255,255,0.08)",
                      color: toolCfg.condaCreateNew === opt.v ? "#06b6d4" : "rgba(255,255,255,0.4)",
                    }}>{opt.l}</button>
                  ))}
                </div>
                <InputField label="Environment Name" value={toolCfg.condaEnvName} onChange={v => setToolCfg(p => ({ ...p, condaEnvName: v }))} placeholder="metagenomics_qc" required mono />
                <div style={{ marginTop: "20px" }}>
                  <span style={{ fontSize: "11px", color: "rgba(255,255,255,0.5)", letterSpacing: "0.08em", textTransform: "uppercase" }}>Tools to install</span>
                  <div style={{ display: "flex", gap: "12px", marginTop: "8px" }}>
                    {[{ key: "needsInstallFastqc", label: "FastQC" }, { key: "needsInstallMultiqc", label: "MultiQC" }].map(t => (
                      <label key={t.key} style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "13px", color: "#e2e8f0" }}>
                        <input type="checkbox" checked={toolCfg[t.key]} onChange={e => setToolCfg(p => ({ ...p, [t.key]: e.target.checked }))} style={{ accentColor: "#06b6d4", width: "16px", height: "16px" }} />
                        {t.label}
                      </label>
                    ))}
                  </div>
                </div>
              </Card>
            )}

            {toolCfg.method === "pixi" && (
              <Card style={{ animation: "fadeIn 0.3s ease" }}>
                <CardTitle icon="📦">Pixi Configuration</CardTitle>
                <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "20px" }}>
                  <span style={{ fontSize: "12px", color: "rgba(255,255,255,0.5)" }}>Project:</span>
                  {[{ v: true, l: "Initialize new" }, { v: false, l: "Use existing" }].map(opt => (
                    <button key={String(opt.v)} onClick={() => setToolCfg(p => ({ ...p, pixiCreateNew: opt.v }))} style={{
                      padding: "6px 16px", borderRadius: "8px", fontSize: "13px", fontWeight: "500", cursor: "pointer",
                      background: toolCfg.pixiCreateNew === opt.v ? "rgba(6,182,212,0.15)" : "rgba(255,255,255,0.03)",
                      border: toolCfg.pixiCreateNew === opt.v ? "1px solid rgba(6,182,212,0.4)" : "1px solid rgba(255,255,255,0.08)",
                      color: toolCfg.pixiCreateNew === opt.v ? "#06b6d4" : "rgba(255,255,255,0.4)",
                    }}>{opt.l}</button>
                  ))}
                </div>
                <InputField label="Pixi Project Path" value={toolCfg.pixiProjectPath} onChange={v => setToolCfg(p => ({ ...p, pixiProjectPath: v }))} placeholder="/home/user/pixi_envs/metagenomics_qc" required mono />
                <div style={{ marginTop: "20px" }}>
                  <span style={{ fontSize: "11px", color: "rgba(255,255,255,0.5)", letterSpacing: "0.08em", textTransform: "uppercase" }}>Tools to install</span>
                  <div style={{ display: "flex", gap: "12px", marginTop: "8px" }}>
                    {[{ key: "needsInstallFastqc", label: "FastQC" }, { key: "needsInstallMultiqc", label: "MultiQC" }].map(t => (
                      <label key={t.key} style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "13px", color: "#e2e8f0" }}>
                        <input type="checkbox" checked={toolCfg[t.key]} onChange={e => setToolCfg(p => ({ ...p, [t.key]: e.target.checked }))} style={{ accentColor: "#06b6d4", width: "16px", height: "16px" }} />
                        {t.label}
                      </label>
                    ))}
                  </div>
                </div>
              </Card>
            )}

            {toolCfg.method === "path" && (
              <Card style={{ animation: "fadeIn 0.3s ease" }}>
                <CardTitle icon="✅">PATH Verification</CardTitle>
                <p style={{ margin: 0, fontSize: "13px", color: "rgba(255,255,255,0.45)" }}>
                  Will verify <code style={{ background: "rgba(0,0,0,0.3)", padding: "2px 6px", borderRadius: "4px", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px" }}>fastqc</code> and <code style={{ background: "rgba(0,0,0,0.3)", padding: "2px 6px", borderRadius: "4px", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px" }}>multiqc</code> are in system PATH on the HPC.
                </p>
              </Card>
            )}

            {toolCfg.method && (
              <Card>
                <CardTitle icon="⚡">{toolCfg.method === "path" ? "Verify Tools" : needsInstall ? "Install & Verify" : "Verify"}</CardTitle>
                {installStatus !== S.success && (
                  <PrimaryBtn onClick={handleInstall}
                    disabled={installStatus === S.running || (toolCfg.method === "conda" && !toolCfg.condaEnvName) || (toolCfg.method === "pixi" && !toolCfg.pixiProjectPath)}>
                    {installStatus === S.running ? "⟳ Working…" : toolCfg.method === "path" ? "🔍 Verify FastQC & MultiQC" : needsInstall ? "📥 Install & Verify" : "🔍 Verify"}
                  </PrimaryBtn>
                )}
                {installLogs.length > 0 && (
                  <div style={{ marginTop: "16px" }}>
                    <LogViewer title={toolCfg.method === "path" ? "Verification" : "Installation"} logs={installLogs} status={installStatus} expanded={installExpanded} onToggle={() => setInstallExpanded(p => !p)} />
                  </div>
                )}
              </Card>
            )}

            <div style={{ display: "flex", gap: "12px", marginTop: "6px" }}>
              <BackBtn onClick={() => setStep("connect")} />
              <PrimaryBtn onClick={() => setStep("configure")} disabled={!canProceedFromTools}>Configure Pipeline →</PrimaryBtn>
            </div>
          </div>
        )}

        {/* ══════ STEP 3: Configure ══════ */}
        {step === "configure" && (
          <div style={{ animation: "fadeIn 0.5s ease" }}>
            <h2 style={{ margin: "0 0 6px", fontSize: "26px", fontWeight: "700" }}>Configure QC Pipeline</h2>
            <p style={{ margin: "0 0 28px", color: "rgba(255,255,255,0.4)", fontSize: "13px" }}>Set data path and analysis parameters.</p>

            <Card>
              <CardTitle icon="📂">Raw Sequence Data</CardTitle>
              <InputField label="Path to raw FASTQ directory" value={pipeCfg.rawDataPath}
                onChange={v => { setPipeCfg(p => ({ ...p, rawDataPath: v })); setDetectedFiles([]); setDetectedPattern(""); setScanStatus(S.idle); setScanError(""); }}
                placeholder="/home/user/project/raw_data" hint="Absolute path containing paired-end .fastq.gz files" required mono />

              <button onClick={handleScanDirectory} disabled={!pipeCfg.rawDataPath || scanStatus === S.running}
                style={{
                  marginTop: "14px", padding: "10px 20px", borderRadius: "10px", border: "none",
                  background: !pipeCfg.rawDataPath ? "rgba(255,255,255,0.04)" : scanStatus === S.running ? "rgba(245,158,11,0.15)" : scanStatus === S.success ? "rgba(16,185,129,0.12)" : "rgba(6,182,212,0.12)",
                  color: !pipeCfg.rawDataPath ? "rgba(255,255,255,0.25)" : scanStatus === S.running ? "#f59e0b" : scanStatus === S.success ? "#10b981" : "#06b6d4",
                  fontSize: "13px", fontWeight: "600", cursor: !pipeCfg.rawDataPath || scanStatus === S.running ? "not-allowed" : "pointer",
                  display: "flex", alignItems: "center", gap: "8px",
                  border: !pipeCfg.rawDataPath ? "1px solid rgba(255,255,255,0.06)" : scanStatus === S.success ? "1px solid rgba(16,185,129,0.25)" : "1px solid rgba(6,182,212,0.25)",
                }}>
                {scanStatus === S.running ? <><span style={{ animation: "pulse 1s infinite" }}>⟳</span> Scanning via SSH...</>
                  : scanStatus === S.success ? <><span>✓</span> Rescan Directory</>
                  : <><span>🔍</span> Scan Directory via SSH</>}
              </button>

              {scanStatus === S.running && (
                <div style={{ marginTop: "12px", padding: "10px 14px", borderRadius: "10px", background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.1)", fontSize: "12px", color: "rgba(245,158,11,0.7)", fontFamily: "'JetBrains Mono', monospace", animation: "fadeIn 0.2s ease" }}>
                  $ ls -1 {pipeCfg.rawDataPath}/*.fastq.gz
                </div>
              )}

              {scanError && scanStatus === S.error && (
                <div style={{ marginTop: "12px", padding: "10px 14px", borderRadius: "10px", background: "rgba(244,63,94,0.08)", border: "1px solid rgba(244,63,94,0.15)", fontSize: "12px", color: "#f43f5e" }}>✗ {scanError}</div>
              )}

              {scanError && scanStatus === S.success && (
                <div style={{ marginTop: "12px", padding: "10px 14px", borderRadius: "10px", background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.15)", fontSize: "12px", color: "#f59e0b" }}>⚠ {scanError}</div>
              )}

              {detectedFiles.length > 0 && scanStatus === S.success && (
                <div style={{ marginTop: "14px", padding: "14px 16px", borderRadius: "12px", background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.15)", animation: "fadeIn 0.3s ease" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                    <span style={{ color: "#10b981" }}>✓</span>
                    <span style={{ fontSize: "12px", fontWeight: "600", color: "#10b981" }}>Found {detectedFiles.length} file{detectedFiles.length !== 1 ? "s" : ""}</span>
                    {detectedPattern && <span style={{ fontSize: "10px", color: "rgba(255,255,255,0.35)", padding: "2px 8px", borderRadius: "6px", background: "rgba(255,255,255,0.05)" }}>Pattern: {detectedPattern}</span>}
                  </div>
                  <div style={{ marginTop: "6px", padding: "10px 12px", borderRadius: "8px", background: "rgba(0,0,0,0.2)", maxHeight: "160px", overflowY: "auto" }}>
                    {detectedFiles.map((f, i) => (
                      <div key={i} style={{ fontSize: "11px", padding: "3px 0", color: "rgba(255,255,255,0.55)", fontFamily: "'JetBrains Mono', monospace", borderBottom: i < detectedFiles.length - 1 ? "1px solid rgba(255,255,255,0.03)" : "none" }}>{f}</div>
                    ))}
                  </div>
                  <div style={{ marginTop: "8px", fontSize: "11px", color: "rgba(255,255,255,0.3)" }}>
                    {detectedFiles.length % 2 === 0 ? `${detectedFiles.length / 2} paired-end sample${detectedFiles.length / 2 !== 1 ? "s" : ""} detected` : "⚠ Odd number of files — verify all pairs are present"}
                  </div>
                </div>
              )}
            </Card>

            <Card>
              <CardTitle icon="🔬">FastQC Configuration</CardTitle>
              <NumberField label="Threads" value={pipeCfg.fastqcThreads} onChange={v => setPipeCfg(p => ({ ...p, fastqcThreads: v }))} min={1} max={128} defaultVal={8} />
            </Card>

            <Card>
              <CardTitle icon="📊">MultiQC Configuration</CardTitle>
              <InputField label="Custom Report Name" value={pipeCfg.multiqcName} onChange={v => setPipeCfg(p => ({ ...p, multiqcName: v }))} placeholder="my_project_multiqc" hint="Without .html extension." required mono />
              <div style={{ marginTop: "10px", fontSize: "11px", color: "rgba(255,255,255,0.3)", fontFamily: "'JetBrains Mono', monospace" }}>
                Output: <span style={{ color: "rgba(6,182,212,0.7)" }}>analyses/1_QC/output/multiqc_report/{pipeCfg.multiqcName || "..."}.html</span>
              </div>
            </Card>

            <div style={{ display: "flex", gap: "12px" }}>
              <BackBtn onClick={() => setStep("tools")} />
              <PrimaryBtn onClick={() => setStep("review")} disabled={!canConfigProceed}>Review Pipeline →</PrimaryBtn>
            </div>
          </div>
        )}

        {/* ══════ STEP 4: Review ══════ */}
        {step === "review" && (
          <div style={{ animation: "fadeIn 0.5s ease" }}>
            <h2 style={{ margin: "0 0 6px", fontSize: "26px", fontWeight: "700" }}>Review & Launch</h2>
            <p style={{ margin: "0 0 28px", color: "rgba(255,255,255,0.4)", fontSize: "13px" }}>Verify configuration before execution.</p>

            <Card>
              <CardTitle icon="📋">Configuration Summary</CardTitle>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                {[
                  { label: "HPC Connection", value: `${sshCfg.hostname}:${sshCfg.port}` },
                  { label: "Username", value: sshCfg.username },
                  { label: "Auth Method", value: sshCfg.authMethod === "password" ? "Password" : `SSH Key (${sshCfg.keyPath})` },
                  { label: "Tool Manager", value: toolMethodSummary },
                  { label: "Raw Data", value: pipeCfg.rawDataPath },
                  { label: "Detected Files", value: `${detectedFiles.length} file${detectedFiles.length !== 1 ? "s" : ""}` },
                  { label: "Pattern", value: detectedPattern || "Unknown" },
                  { label: "FastQC Threads", value: `${pipeCfg.fastqcThreads} threads` },
                  { label: "MultiQC Report", value: `${pipeCfg.multiqcName}.html` },
                ].map((item, i) => (
                  <div key={i} style={{ padding: "10px 14px", borderRadius: "10px", background: "rgba(0,0,0,0.2)", border: "1px solid rgba(255,255,255,0.04)" }}>
                    <div style={{ fontSize: "10px", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "3px" }}>{item.label}</div>
                    <div style={{ fontSize: "12px", color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", wordBreak: "break-all" }}>{item.value}</div>
                  </div>
                ))}
              </div>
            </Card>

            <Card>
              <CardTitle icon="🌳">Directory Structure</CardTitle>
              <DirectoryTree rawDataPath={pipeCfg.rawDataPath} />
            </Card>

            <div style={{
              background: "linear-gradient(135deg, rgba(245,158,11,0.04), rgba(245,158,11,0.08))",
              border: "1px solid rgba(245,158,11,0.15)", borderRadius: "16px",
              padding: "18px 24px", marginBottom: "18px",
              display: "flex", alignItems: "center", justifyContent: "space-between",
            }}>
              <div>
                <div style={{ fontSize: "11px", color: "rgba(245,158,11,0.7)", fontWeight: "500", marginBottom: "4px" }}>✏️ MultiQC report name (editable)</div>
                {editingMqcName ? (
                  <input value={pipeCfg.multiqcName} autoFocus
                    onChange={e => setPipeCfg(p => ({ ...p, multiqcName: e.target.value }))}
                    onBlur={() => setEditingMqcName(false)} onKeyDown={e => e.key === "Enter" && setEditingMqcName(false)}
                    style={{ padding: "5px 10px", borderRadius: "8px", border: "1px solid rgba(245,158,11,0.3)", background: "rgba(0,0,0,0.3)", color: "#e2e8f0", fontSize: "13px", outline: "none", fontFamily: "'JetBrains Mono', monospace", width: "280px" }} />
                ) : (
                  <span style={{ fontSize: "13px", fontFamily: "'JetBrains Mono', monospace", color: "#e2e8f0" }}>{pipeCfg.multiqcName}.html</span>
                )}
              </div>
              {!editingMqcName && <button onClick={() => setEditingMqcName(true)} style={{ padding: "7px 14px", borderRadius: "8px", border: "1px solid rgba(245,158,11,0.2)", background: "rgba(245,158,11,0.1)", color: "#f59e0b", fontSize: "12px", cursor: "pointer" }}>Edit</button>}
            </div>

            <div style={{ display: "flex", gap: "12px" }}>
              <BackBtn onClick={() => setStep("configure")} />
              <PrimaryBtn onClick={runPipeline} color="green" style={{ fontSize: "15px", fontWeight: "700", padding: "16px" }}>🚀 Start FastQC Analysis</PrimaryBtn>
            </div>
          </div>
        )}

        {/* ══════ STEP 5: Execution ══════ */}
        {step === "running" && (
          <div style={{ animation: "fadeIn 0.5s ease" }}>
            <h2 style={{ margin: "0 0 6px", fontSize: "26px", fontWeight: "700" }}>Pipeline Execution</h2>
            <p style={{ margin: "0 0 28px", color: "rgba(255,255,255,0.4)", fontSize: "13px" }}>
              {fqcStatus === S.success && mqcStatus === S.success ? "All analyses completed!" : "Streaming real-time output from HPC…"}
            </p>

            <div style={{ display: "flex", gap: "12px", marginBottom: "20px" }}>
              {[{ label: "FastQC", status: fqcStatus }, { label: "MultiQC", status: mqcStatus }].map((s, i) => (
                <div key={i} style={{
                  flex: 1, padding: "14px 18px", borderRadius: "14px", textAlign: "center",
                  background: s.status === S.success ? "rgba(16,185,129,0.08)" : s.status === S.running ? "rgba(245,158,11,0.08)" : "rgba(255,255,255,0.02)",
                  border: `1px solid ${s.status === S.success ? "rgba(16,185,129,0.2)" : s.status === S.running ? "rgba(245,158,11,0.2)" : "rgba(255,255,255,0.06)"}`,
                }}>
                  <div style={{ fontSize: "26px", marginBottom: "4px", animation: s.status === S.running ? "pulse 1.5s infinite" : "none" }}>
                    {s.status === S.success ? "✅" : s.status === S.running ? "⏳" : s.status === S.error ? "❌" : "⏸"}
                  </div>
                  <div style={{ fontSize: "13px", fontWeight: "600", color: s.status === S.success ? "#10b981" : s.status === S.running ? "#f59e0b" : s.status === S.error ? "#f43f5e" : "rgba(255,255,255,0.3)" }}>{s.label}</div>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              <LogViewer title="FastQC Execution" logs={fqcLogs} status={fqcStatus} expanded={fqcExpanded} onToggle={() => setFqcExpanded(p => !p)} />
              <LogViewer title="MultiQC Execution (auto-triggered)" logs={mqcLogs} status={mqcStatus} expanded={mqcExpanded} onToggle={() => setMqcExpanded(p => !p)} />
            </div>

            {fqcStatus === S.success && mqcStatus === S.success && (
              <div style={{
                marginTop: "24px", padding: "22px 24px", borderRadius: "16px",
                background: "linear-gradient(135deg, rgba(16,185,129,0.06), rgba(6,182,212,0.06))",
                border: "1px solid rgba(16,185,129,0.15)", animation: "fadeIn 0.5s ease",
              }}>
                <h3 style={{ margin: "0 0 14px", fontSize: "17px", fontWeight: "700", color: "#10b981" }}>✓ QC Pipeline Complete</h3>
                <DirectoryTree rawDataPath={pipeCfg.rawDataPath} />
                <div style={{ marginTop: "14px", padding: "10px 14px", borderRadius: "10px", background: "rgba(0,0,0,0.2)", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", color: "rgba(255,255,255,0.45)", lineHeight: "1.8" }}>
                  <div>📊 FastQC: analyses/1_QC/output/fastqc_reports/</div>
                  <div>📊 MultiQC: analyses/1_QC/output/multiqc_report/{pipeCfg.multiqcName}.html</div>
                  <div>📋 Logs: analyses/1_QC/logs/</div>
                  <div>📜 Scripts: analyses/1_QC/scripts/</div>
                </div>
                <button onClick={() => {
                  setStep("connect"); setSSHStatus(S.idle); setFqcStatus(S.idle); setMqcStatus(S.idle);
                  setFqcLogs([]); setMqcLogs([]); setDetectedFiles([]); setInstallStatus(S.idle); setInstallLogs([]);
                  setSSHLogs([]); setSSHError(""); setScanStatus(S.idle); setScanError(""); setSessionId(null);
                }} style={{
                  marginTop: "14px", padding: "10px 20px", borderRadius: "10px",
                  border: "1px solid rgba(6,182,212,0.2)", background: "rgba(6,182,212,0.08)",
                  color: "#06b6d4", fontSize: "13px", fontWeight: "500", cursor: "pointer",
                }}>↻ Start New Analysis</button>
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ padding: "18px 32px", borderTop: "1px solid rgba(255,255,255,0.04)", textAlign: "center", fontSize: "10px", color: "rgba(255,255,255,0.18)", letterSpacing: "0.06em" }}>
        MetaQC Pipeline · FastQC + MultiQC · FastAPI + Paramiko Backend
      </div>
    </div>
  );
}
