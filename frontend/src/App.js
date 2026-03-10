import React, { useState, useEffect, useRef, useCallback } from "react";
import { sshConnect, scanDirectory, wsInstallTools, wsRunPipeline, healthCheck } from "./api";

// ─── Constants ──────────────────────────────────────────────────────────────
const STEPS = [
  { id: "connect", label: "SSH Connection", icon: "🔗" },
  { id: "tools", label: "Tool Setup", icon: "🧰" },
  { id: "configure", label: "Configure", icon: "⚙️" },
  { id: "review", label: "Review & Run", icon: "🚀" },
  { id: "running", label: "Execution", icon: "📊" },
];
const TOOL_METHODS = [
  { id: "conda", label: "Conda / Mamba", icon: "🐍", desc: "Conda or mamba environments" },
  { id: "pixi", label: "Pixi", icon: "📦", desc: "Pixi package manager" },
  { id: "path", label: "Already in PATH", icon: "✅", desc: "Tools already installed" },
];
const S = { idle: "idle", running: "running", success: "success", error: "error" };

const mono = "'JetBrains Mono', 'Fira Code', monospace";
const sans = "'IBM Plex Sans', -apple-system, sans-serif";

// ─── Styles ─────────────────────────────────────────────────────────────────
const css = `
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
@keyframes fadeIn { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
input::-webkit-outer-spin-button,input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
input[type=number]{-moz-appearance:textfield}
::-webkit-scrollbar{width:5px} ::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(6,182,212,.2);border-radius:3px}
`;

// ─── UI Primitives ──────────────────────────────────────────────────────────

function StepIndicator({ steps, currentStep }) {
  const idx = steps.findIndex(s => s.id === currentStep);
  return (
    <div style={{ display:"flex",alignItems:"center",gap:0,padding:"20px 28px",borderBottom:"1px solid rgba(255,255,255,.06)",background:"linear-gradient(135deg,rgba(15,23,42,.6),rgba(15,23,42,.3))",backdropFilter:"blur(20px)",overflowX:"auto" }}>
      {steps.map((step, i) => {
        const a = i === idx, d = i < idx, last = i === steps.length - 1;
        return (
          <div key={step.id} style={{ display:"flex",alignItems:"center",flex:last?"0 0 auto":"1" }}>
            <div style={{ display:"flex",alignItems:"center",gap:8,padding:"7px 14px",borderRadius:10,whiteSpace:"nowrap",
              background:a?"linear-gradient(135deg,#06b6d4,#0891b2)":d?"rgba(6,182,212,.15)":"rgba(255,255,255,.03)",
              border:a?"1px solid rgba(6,182,212,.5)":d?"1px solid rgba(6,182,212,.2)":"1px solid rgba(255,255,255,.06)",
              boxShadow:a?"0 0 20px rgba(6,182,212,.25)":"none",transition:"all .4s cubic-bezier(.16,1,.3,1)" }}>
              <span style={{ fontSize:14 }}>{d?"✓":step.icon}</span>
              <span style={{ fontSize:12,fontWeight:a?600:400,color:a?"#fff":d?"#06b6d4":"rgba(255,255,255,.4)" }}>{step.label}</span>
            </div>
            {!last && <div style={{ flex:1,height:2,margin:"0 6px",background:d?"rgba(6,182,212,.4)":"rgba(255,255,255,.06)",minWidth:12 }}/>}
          </div>
        );
      })}
    </div>
  );
}

function Input({ label, value, onChange, type="text", placeholder, hint, required, disabled, isMono, style }) {
  return (
    <div style={{ display:"flex",flexDirection:"column",gap:6,...style }}>
      <label style={{ fontSize:11,fontWeight:500,color:"rgba(255,255,255,.5)",letterSpacing:".08em",textTransform:"uppercase" }}>
        {label} {required && <span style={{ color:"#f43f5e" }}>*</span>}
      </label>
      <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} disabled={disabled}
        style={{ padding:"11px 14px",borderRadius:10,border:"1px solid rgba(255,255,255,.08)",
          background:disabled?"rgba(255,255,255,.02)":"rgba(255,255,255,.04)",
          color:disabled?"rgba(255,255,255,.3)":"#e2e8f0",fontSize:13,outline:"none",
          fontFamily:isMono?mono:sans,transition:"all .2s ease" }}
        onFocus={e=>{e.target.style.borderColor="rgba(6,182,212,.5)";e.target.style.boxShadow="0 0 0 3px rgba(6,182,212,.1)"}}
        onBlur={e=>{e.target.style.borderColor="rgba(255,255,255,.08)";e.target.style.boxShadow="none"}} />
      {hint && <span style={{ fontSize:11,color:"rgba(255,255,255,.3)" }}>{hint}</span>}
    </div>
  );
}

function NumField({ label, value, onChange, min=1, max=128, def=8 }) {
  const nb = { width:34,height:34,borderRadius:8,border:"1px solid rgba(255,255,255,.1)",background:"rgba(255,255,255,.05)",color:"#06b6d4",fontSize:16,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center" };
  return (
    <div style={{ display:"flex",flexDirection:"column",gap:6 }}>
      <label style={{ fontSize:11,fontWeight:500,color:"rgba(255,255,255,.5)",letterSpacing:".08em",textTransform:"uppercase" }}>{label}</label>
      <div style={{ display:"flex",alignItems:"center",gap:8 }}>
        <button onClick={()=>onChange(Math.max(min,value-1))} style={nb}>−</button>
        <input type="number" value={value} onChange={e=>onChange(Number(e.target.value))} min={min} max={max}
          style={{ width:64,padding:8,borderRadius:10,border:"1px solid rgba(255,255,255,.08)",background:"rgba(255,255,255,.04)",color:"#e2e8f0",fontSize:15,textAlign:"center",outline:"none",fontFamily:mono,fontWeight:600 }}/>
        <button onClick={()=>onChange(Math.min(max,value+1))} style={nb}>+</button>
        <span style={{ fontSize:11,color:"rgba(255,255,255,.3)",marginLeft:4 }}>threads (default: {def})</span>
      </div>
    </div>
  );
}

function Card({ children, style }) {
  return <div style={{ background:"linear-gradient(135deg,rgba(255,255,255,.02),rgba(255,255,255,.04))",border:"1px solid rgba(255,255,255,.06)",borderRadius:16,padding:"26px 28px",marginBottom:18,...style }}>{children}</div>;
}
function CTitle({ icon, children }) {
  return <h3 style={{ margin:"0 0 18px",fontSize:15,fontWeight:600,color:"#06b6d4",display:"flex",alignItems:"center",gap:8 }}>{icon} {children}</h3>;
}
function Btn({ onClick, disabled, children, color="cyan", style }) {
  const c = color==="green"?{bg:"linear-gradient(135deg,#10b981,#059669)",sh:"rgba(16,185,129,.35)"}:{bg:"linear-gradient(135deg,#06b6d4,#0891b2)",sh:"rgba(6,182,212,.3)"};
  return <button onClick={onClick} disabled={disabled} style={{ flex:1,padding:14,borderRadius:12,border:"none",background:disabled?"rgba(255,255,255,.05)":c.bg,color:disabled?"rgba(255,255,255,.3)":"#fff",fontSize:14,fontWeight:600,cursor:disabled?"not-allowed":"pointer",boxShadow:disabled?"none":`0 4px 20px ${c.sh}`,transition:"all .3s",...style }}>{children}</button>;
}
function Back({ onClick }) {
  return <button onClick={onClick} style={{ padding:"14px 24px",borderRadius:12,border:"1px solid rgba(255,255,255,.1)",background:"rgba(255,255,255,.03)",color:"rgba(255,255,255,.5)",fontSize:13,fontWeight:500,cursor:"pointer" }}>← Back</button>;
}

function LogViewer({ logs, expanded, onToggle, title, status }) {
  const ref = useRef(null);
  useEffect(()=>{if(ref.current)ref.current.scrollTop=ref.current.scrollHeight},[logs]);
  const sc = {[S.idle]:"rgba(255,255,255,.3)",[S.running]:"#f59e0b",[S.success]:"#10b981",[S.error]:"#f43f5e"};
  const sl = {[S.idle]:"Waiting",[S.running]:"Running…",[S.success]:"Complete",[S.error]:"Failed"};
  return (
    <div style={{ borderRadius:14,border:"1px solid rgba(255,255,255,.06)",background:"rgba(0,0,0,.3)",overflow:"hidden" }}>
      <div onClick={onToggle} style={{ display:"flex",alignItems:"center",justifyContent:"space-between",padding:"13px 18px",cursor:"pointer",background:"rgba(255,255,255,.02)",borderBottom:expanded?"1px solid rgba(255,255,255,.06)":"none" }}>
        <div style={{ display:"flex",alignItems:"center",gap:10 }}>
          <div style={{ width:9,height:9,borderRadius:"50%",background:sc[status],boxShadow:status===S.running?`0 0 12px ${sc[status]}`:"none",animation:status===S.running?"pulse 1.5s infinite":"none" }}/>
          <span style={{ fontSize:13,fontWeight:600,color:"#e2e8f0" }}>{title}</span>
          <span style={{ fontSize:10,color:sc[status],padding:"2px 9px",borderRadius:20,background:`${sc[status]}15`,border:`1px solid ${sc[status]}30` }}>{sl[status]}</span>
        </div>
        <span style={{ transform:expanded?"rotate(180deg)":"rotate(0deg)",transition:"transform .2s",fontSize:12,color:"rgba(255,255,255,.4)" }}>▼</span>
      </div>
      {expanded && (
        <div ref={ref} style={{ maxHeight:260,overflowY:"auto",padding:"14px 18px",fontFamily:mono,fontSize:11,lineHeight:1.8,color:"rgba(255,255,255,.6)" }}>
          {logs.length===0?<span style={{ color:"rgba(255,255,255,.2)",fontStyle:"italic" }}>No output yet…</span>
            :logs.map((l,i)=><div key={i} style={{ color:l.startsWith("ERROR")||l.startsWith("✗")?"#f43f5e":l.startsWith("✓")||l.startsWith("SUCCESS")?"#10b981":l.startsWith("$")?"#06b6d4":l.startsWith(">>>")?"#f59e0b":"rgba(255,255,255,.55)" }}>{l}</div>)}
          {status===S.running && <span style={{ color:"#06b6d4",animation:"blink 1s infinite" }}>█</span>}
        </div>
      )}
    </div>
  );
}

function DirTree({ rawDataPath }) {
  const parent = rawDataPath ? rawDataPath.replace(/\/[^/]+\/?$/, "") : "/path/to/project";
  const rawName = rawDataPath ? rawDataPath.split("/").filter(Boolean).pop() : "raw_data";
  const items = [
    { d:0,n:`${rawName}/`,icon:"📁",hl:false,desc:"raw FASTQ files" },
    { d:0,n:"analyses/",icon:"📁",hl:true },
    { d:1,n:"1_QC/",icon:"📁",hl:true },
    { d:2,n:"input/",icon:"📂",desc:"→ symlinked .fastq.gz" },
    { d:2,n:"output/",icon:"📂" },
    { d:3,n:"fastqc_reports/",icon:"📊",desc:"FastQC HTML + ZIP" },
    { d:3,n:"multiqc_report/",icon:"📊",desc:"MultiQC HTML report" },
    { d:2,n:"logs/",icon:"📋",desc:"fastqc.log, multiqc.log" },
    { d:2,n:"scripts/",icon:"📜",desc:"Versioned run scripts" },
  ];
  return (
    <div style={{ borderRadius:12,border:"1px solid rgba(255,255,255,.06)",background:"rgba(0,0,0,.25)",padding:"18px 22px",fontFamily:mono,fontSize:12 }}>
      <div style={{ color:"rgba(255,255,255,.3)",marginBottom:10,fontSize:11 }}>{parent}/</div>
      {items.map((it,i)=>(
        <div key={i} style={{ display:"flex",alignItems:"center",gap:6,padding:`2px 0 2px ${it.d*22}px`,color:it.hl?"#06b6d4":"rgba(255,255,255,.55)" }}>
          {it.d>0&&<span style={{ color:"rgba(255,255,255,.15)" }}>├── </span>}
          <span>{it.icon}</span><span style={{ fontWeight:it.hl?600:400 }}>{it.n}</span>
          {it.desc&&<span style={{ fontSize:10,color:"rgba(255,255,255,.22)",fontStyle:"italic" }}>{it.desc}</span>}
        </div>
      ))}
    </div>
  );
}

function Toggle({ options, value, onChange }) {
  return (
    <div style={{ display:"flex",gap:10 }}>
      {options.map(o=>(
        <button key={o.v} onClick={()=>onChange(o.v)} style={{
          padding:"6px 16px",borderRadius:8,fontSize:13,fontWeight:500,cursor:"pointer",
          background:value===o.v?"rgba(6,182,212,.15)":"rgba(255,255,255,.03)",
          border:value===o.v?"1px solid rgba(6,182,212,.4)":"1px solid rgba(255,255,255,.08)",
          color:value===o.v?"#06b6d4":"rgba(255,255,255,.4)",
        }}>{o.l}</button>
      ))}
    </div>
  );
}

// ─── Main App ───────────────────────────────────────────────────────────────

export default function App() {
  const [step, setStep] = useState("connect");
  const [backendOk, setBackendOk] = useState(null);
  const [sessionId, setSessionId] = useState("");

  // SSH
  const [ssh, setSSH] = useState({ hostname:"",port:"22",username:"",authMethod:"password",password:"",keyPath:"" });
  const [sshStatus, setSshStatus] = useState(S.idle);
  const [sshError, setSshError] = useState("");
  const [sshLogs, setSshLogs] = useState([]);
  const [sshLogX, setSshLogX] = useState(true);

  // Tools
  const [tool, setTool] = useState({ method:"",condaUseMamba:false,condaCreateNew:true,condaEnvName:"metagenomics_qc",pixiCreateNew:true,pixiProjectPath:"",needsFastqc:true,needsMultiqc:true });
  const [instStatus, setInstStatus] = useState(S.idle);
  const [instLogs, setInstLogs] = useState([]);
  const [instX, setInstX] = useState(true);

  // Pipeline
  const [pipe, setPipe] = useState({ rawDataPath:"",fastqcThreads:8,multiqcName:"multiqc_report" });
  const [files, setFiles] = useState([]);
  const [pattern, setPattern] = useState("");
  const [scanSt, setScanSt] = useState(S.idle);
  const [scanErr, setScanErr] = useState("");

  // Execution
  const [fSt, setFSt] = useState(S.idle);
  const [mSt, setMSt] = useState(S.idle);
  const [fLogs, setFLogs] = useState([]);
  const [mLogs, setMLogs] = useState([]);
  const [fX, setFX] = useState(true);
  const [mX, setMX] = useState(true);
  const [editMqc, setEditMqc] = useState(false);

  // Health check
  useEffect(()=>{
    healthCheck().then(()=>setBackendOk(true)).catch(()=>setBackendOk(false));
  },[]);

  // ── SSH Connect ──
  const handleConnect = async () => {
    setSshStatus(S.running); setSshError(""); setSshLogs([]);
    const lg = m => setSshLogs(p=>[...p,m]);

    lg(`>>> Connecting to ${ssh.hostname}:${ssh.port}...`);
    lg(`$ ssh ${ssh.authMethod==="key"?`-i ${ssh.keyPath} `:"" }-p ${ssh.port} ${ssh.username}@${ssh.hostname}`);

    try {
      const res = await sshConnect(ssh);
      setSessionId(res.session_id);
      lg(`✓ ${res.message}`);
      lg(`  Session ID: ${res.session_id}`);
      lg("");
      lg("SUCCESS SSH connection established!");
      setSshStatus(S.success);
      setTimeout(()=>setStep("tools"),800);
    } catch(e) {
      lg(`✗ ${e.message}`);
      lg("");
      lg(`ERROR Connection failed: ${e.message}`);
      setSshStatus(S.error);
      setSshError(e.message);
    }
  };

  // ── Scan Directory ──
  const handleScan = async () => {
    setScanSt(S.running); setScanErr(""); setFiles([]); setPattern("");
    try {
      const res = await scanDirectory(sessionId, pipe.rawDataPath);
      setFiles(res.files);
      setPattern(res.pattern || "");
      if (!res.pattern) setScanErr("Warning: No known paired-end naming pattern detected.");
      setScanSt(S.success);
    } catch(e) {
      setScanSt(S.error);
      setScanErr(e.message);
    }
  };

  // ── Install Tools (WebSocket) ──
  const handleInstall = () => {
    setInstStatus(S.running); setInstLogs([]);
    const payload = {
      session_id: sessionId,
      method: tool.method,
      conda_use_mamba: tool.condaUseMamba,
      conda_create_new: tool.condaCreateNew,
      conda_env_name: tool.condaEnvName,
      pixi_create_new: tool.pixiCreateNew,
      pixi_project_path: tool.pixiProjectPath,
      needs_install_fastqc: tool.needsFastqc,
      needs_install_multiqc: tool.needsMultiqc,
    };
    wsInstallTools(payload, (msg)=>{
      if(msg.type==="log") setInstLogs(p=>[...p,msg.message]);
      if(msg.type==="status") setInstStatus(msg.status);
    });
  };

  // ── Run Pipeline (WebSocket) ──
  const handleRun = () => {
    setStep("running"); setFLogs([]); setMLogs([]); setFSt(S.running); setMSt(S.idle);
    const payload = {
      session_id: sessionId,
      raw_data_path: pipe.rawDataPath,
      fastqc_threads: pipe.fastqcThreads,
      multiqc_name: pipe.multiqcName,
      tool_method: tool.method,
      conda_env_name: tool.condaEnvName,
      pixi_project_path: tool.pixiProjectPath,
      conda_use_mamba: tool.condaUseMamba,
    };
    wsRunPipeline(payload, (msg)=>{
      if(msg.type==="log") {
        if(msg.stage==="fastqc") setFLogs(p=>[...p,msg.message]);
        else setMLogs(p=>[...p,msg.message]);
      }
      if(msg.type==="status") {
        if(msg.stage==="fastqc") setFSt(msg.status);
        else setMSt(msg.status);
      }
    });
  };

  const canTools = tool.method && (tool.method==="path" || (tool.method==="conda"&&tool.condaEnvName) || (tool.method==="pixi"&&tool.pixiProjectPath)) && instStatus===S.success;
  const canReview = pipe.rawDataPath && pipe.multiqcName && files.length>0 && scanSt===S.success;

  const toolLabel = tool.method==="conda"?`${tool.condaUseMamba?"Mamba":"Conda"} (${tool.condaEnvName})`:tool.method==="pixi"?`Pixi (${tool.pixiProjectPath})`:"System PATH";

  const resetAll = () => {
    setStep("connect"); setSshStatus(S.idle); setSessionId("");
    setSshLogs([]); setSshError(""); setInstStatus(S.idle); setInstLogs([]);
    setFiles([]); setPattern(""); setScanSt(S.idle); setScanErr("");
    setFSt(S.idle); setMSt(S.idle); setFLogs([]); setMLogs([]);
  };

  return (
    <div style={{ minHeight:"100vh",background:"#080c14",color:"#e2e8f0",fontFamily:sans }}>
      <style>{css}</style>

      {/* Header */}
      <div style={{ padding:"24px 32px",display:"flex",alignItems:"center",justifyContent:"space-between",background:"linear-gradient(180deg,rgba(6,182,212,.08) 0%,transparent 100%)",borderBottom:"1px solid rgba(255,255,255,.04)" }}>
        <div style={{ display:"flex",alignItems:"center",gap:14 }}>
          <div style={{ width:42,height:42,borderRadius:11,background:"linear-gradient(135deg,#06b6d4,#0e7490)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,boxShadow:"0 0 28px rgba(6,182,212,.3)" }}>🧬</div>
          <div>
            <h1 style={{ margin:0,fontSize:20,fontWeight:700,background:"linear-gradient(135deg,#e2e8f0,#06b6d4)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent" }}>MetaQC Pipeline</h1>
            <p style={{ margin:0,fontSize:11,color:"rgba(255,255,255,.3)",letterSpacing:".1em",textTransform:"uppercase" }}>Metagenomics Quality Control</p>
          </div>
        </div>
        <div style={{ display:"flex",alignItems:"center",gap:12 }}>
          {backendOk===false && <span style={{ fontSize:11,color:"#f43f5e",padding:"4px 10px",borderRadius:8,background:"rgba(244,63,94,.1)",border:"1px solid rgba(244,63,94,.2)" }}>⚠ Backend offline</span>}
          <div style={{ display:"flex",alignItems:"center",gap:10,padding:"7px 14px",borderRadius:10,background:sshStatus===S.success?"rgba(16,185,129,.1)":"rgba(255,255,255,.03)",border:`1px solid ${sshStatus===S.success?"rgba(16,185,129,.2)":"rgba(255,255,255,.06)"}` }}>
            <div style={{ width:7,height:7,borderRadius:"50%",background:sshStatus===S.success?"#10b981":"rgba(255,255,255,.2)" }}/>
            <span style={{ fontSize:11,color:sshStatus===S.success?"#10b981":"rgba(255,255,255,.5)" }}>{sshStatus===S.success?`HPC connected · ${ssh.hostname}:${ssh.port}`:"Not connected"}</span>
          </div>
        </div>
      </div>

      <StepIndicator steps={STEPS} currentStep={step}/>

      <div style={{ maxWidth:860,margin:"0 auto",padding:"32px 20px",animation:"fadeIn .4s ease" }}>

        {/* ═══ STEP 1: SSH ═══ */}
        {step==="connect" && (
          <div style={{ animation:"fadeIn .5s ease" }}>
            <h2 style={{ margin:"0 0 6px",fontSize:26,fontWeight:700 }}>Connect to HPC</h2>
            <p style={{ margin:"0 0 28px",color:"rgba(255,255,255,.4)",fontSize:13 }}>Establish a direct SSH connection to your cluster.</p>
            <Card>
              <CTitle icon="🖥️">SSH Connection</CTitle>
              <div style={{ display:"grid",gridTemplateColumns:"2fr 1fr",gap:18,marginBottom:18 }}>
                <Input label="Hostname / IP" value={ssh.hostname} onChange={v=>setSSH(p=>({...p,hostname:v}))} placeholder="hpc.university.edu" required isMono hint="HPC hostname or IP"/>
                <Input label="Port" value={ssh.port} onChange={v=>setSSH(p=>({...p,port:v}))} placeholder="22" isMono hint="Default: 22"/>
              </div>
              <div style={{ marginBottom:18 }}>
                <Input label="Username" value={ssh.username} onChange={v=>setSSH(p=>({...p,username:v}))} placeholder="your_username" required isMono/>
              </div>
              <div style={{ marginBottom:18 }}>
                <label style={{ fontSize:11,fontWeight:500,color:"rgba(255,255,255,.5)",letterSpacing:".08em",textTransform:"uppercase",display:"block",marginBottom:8 }}>Authentication</label>
                <div style={{ display:"flex",gap:10 }}>
                  {[{id:"password",l:"🔑 Password"},{id:"key",l:"🗝️ SSH Key"}].map(m=>(
                    <div key={m.id} onClick={()=>setSSH(p=>({...p,authMethod:m.id}))} style={{ flex:1,padding:"14px 16px",borderRadius:10,cursor:"pointer",background:ssh.authMethod===m.id?"rgba(6,182,212,.1)":"rgba(255,255,255,.02)",border:ssh.authMethod===m.id?"1.5px solid rgba(6,182,212,.5)":"1px solid rgba(255,255,255,.06)",boxShadow:ssh.authMethod===m.id?"0 0 16px rgba(6,182,212,.1)":"none" }}>
                      <div style={{ fontSize:13,fontWeight:600,color:ssh.authMethod===m.id?"#06b6d4":"#e2e8f0" }}>{m.l}</div>
                    </div>
                  ))}
                </div>
              </div>
              {ssh.authMethod==="password"&&<div style={{ marginBottom:18 }}><Input label="Password" value={ssh.password} onChange={v=>setSSH(p=>({...p,password:v}))} type="password" placeholder="••••••••" required/></div>}
              {ssh.authMethod==="key"&&<div style={{ marginBottom:18 }}><Input label="Private Key Path" value={ssh.keyPath} onChange={v=>setSSH(p=>({...p,keyPath:v}))} placeholder="/home/user/.ssh/id_rsa" required isMono hint="Absolute path to private key"/></div>}
              <div style={{ marginBottom:18,padding:"10px 14px",borderRadius:10,background:"rgba(0,0,0,.25)",border:"1px solid rgba(255,255,255,.04)" }}>
                <div style={{ fontSize:10,color:"rgba(255,255,255,.3)",textTransform:"uppercase",letterSpacing:".06em",marginBottom:4 }}>Command</div>
                <code style={{ fontSize:12,color:"#06b6d4",fontFamily:mono }}>ssh {ssh.authMethod==="key"&&ssh.keyPath?`-i ${ssh.keyPath} `:""}-p {ssh.port||"22"} {ssh.username||"<user>"}@{ssh.hostname||"<hostname>"}</code>
              </div>
              {sshError&&<div style={{ marginBottom:16,padding:"10px 14px",borderRadius:10,background:"rgba(244,63,94,.1)",border:"1px solid rgba(244,63,94,.2)",color:"#f43f5e",fontSize:12 }}>✗ {sshError}</div>}
              <Btn onClick={handleConnect} disabled={backendOk===false||sshStatus===S.running||!ssh.hostname||!ssh.username||(ssh.authMethod==="password"&&!ssh.password)||(ssh.authMethod==="key"&&!ssh.keyPath)}>
                {sshStatus===S.running?"⟳ Connecting…":sshStatus===S.success?"✓ Connected":"🔗 Establish SSH Connection"}
              </Btn>
              {sshLogs.length>0&&<div style={{ marginTop:16 }}><LogViewer title="SSH Connection" logs={sshLogs} status={sshStatus} expanded={sshLogX} onToggle={()=>setSshLogX(p=>!p)}/></div>}
            </Card>
          </div>
        )}

        {/* ═══ STEP 2: Tools ═══ */}
        {step==="tools" && (
          <div style={{ animation:"fadeIn .5s ease" }}>
            <h2 style={{ margin:"0 0 6px",fontSize:26,fontWeight:700 }}>Tool Setup</h2>
            <p style={{ margin:"0 0 28px",color:"rgba(255,255,255,.4)",fontSize:13 }}>Configure FastQC and MultiQC management.</p>
            <Card>
              <CTitle icon="🧰">Package Manager</CTitle>
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12 }}>
                {TOOL_METHODS.map(m=>{const sel=tool.method===m.id;return(
                  <div key={m.id} onClick={()=>{setTool(p=>({...p,method:m.id}));setInstStatus(S.idle);setInstLogs([])}} style={{ padding:"18px 16px",borderRadius:12,cursor:"pointer",textAlign:"center",background:sel?"rgba(6,182,212,.1)":"rgba(255,255,255,.02)",border:sel?"1.5px solid rgba(6,182,212,.5)":"1px solid rgba(255,255,255,.06)",boxShadow:sel?"0 0 20px rgba(6,182,212,.15)":"none",transition:"all .2s" }}>
                    <div style={{ fontSize:24,marginBottom:8 }}>{m.icon}</div>
                    <div style={{ fontSize:14,fontWeight:600,color:sel?"#06b6d4":"#e2e8f0",marginBottom:4 }}>{m.label}</div>
                    <div style={{ fontSize:11,color:"rgba(255,255,255,.35)" }}>{m.desc}</div>
                  </div>
                )})}
              </div>
            </Card>

            {tool.method==="conda"&&(
              <Card style={{ animation:"fadeIn .3s ease" }}>
                <CTitle icon="🐍">Conda / Mamba</CTitle>
                <div style={{ display:"flex",alignItems:"center",gap:12,marginBottom:20 }}>
                  <span style={{ fontSize:12,color:"rgba(255,255,255,.5)" }}>Manager:</span>
                  <Toggle options={[{v:false,l:"conda"},{v:true,l:"mamba"}]} value={tool.condaUseMamba} onChange={v=>setTool(p=>({...p,condaUseMamba:v}))}/>
                </div>
                <div style={{ display:"flex",alignItems:"center",gap:12,marginBottom:20 }}>
                  <span style={{ fontSize:12,color:"rgba(255,255,255,.5)" }}>Environment:</span>
                  <Toggle options={[{v:true,l:"Create new"},{v:false,l:"Use existing"}]} value={tool.condaCreateNew} onChange={v=>setTool(p=>({...p,condaCreateNew:v}))}/>
                </div>
                <Input label="Environment Name" value={tool.condaEnvName} onChange={v=>setTool(p=>({...p,condaEnvName:v}))} placeholder="metagenomics_qc" required isMono hint={tool.condaCreateNew?"Will be created":"Must exist on HPC"}/>
                <div style={{ marginTop:20 }}>
                  <span style={{ fontSize:11,color:"rgba(255,255,255,.5)",letterSpacing:".08em",textTransform:"uppercase" }}>Install</span>
                  <div style={{ display:"flex",gap:12,marginTop:8 }}>
                    {[{k:"needsFastqc",l:"FastQC"},{k:"needsMultiqc",l:"MultiQC"}].map(t=>(
                      <label key={t.k} style={{ display:"flex",alignItems:"center",gap:8,cursor:"pointer",fontSize:13,color:"#e2e8f0" }}>
                        <input type="checkbox" checked={tool[t.k]} onChange={e=>setTool(p=>({...p,[t.k]:e.target.checked}))} style={{ accentColor:"#06b6d4",width:16,height:16 }}/>{t.l}
                      </label>
                    ))}
                  </div>
                </div>
              </Card>
            )}

            {tool.method==="pixi"&&(
              <Card style={{ animation:"fadeIn .3s ease" }}>
                <CTitle icon="📦">Pixi</CTitle>
                <div style={{ display:"flex",alignItems:"center",gap:12,marginBottom:20 }}>
                  <span style={{ fontSize:12,color:"rgba(255,255,255,.5)" }}>Project:</span>
                  <Toggle options={[{v:true,l:"Initialize new"},{v:false,l:"Use existing"}]} value={tool.pixiCreateNew} onChange={v=>setTool(p=>({...p,pixiCreateNew:v}))}/>
                </div>
                <Input label="Pixi Project Path" value={tool.pixiProjectPath} onChange={v=>setTool(p=>({...p,pixiProjectPath:v}))} placeholder="/home/user/pixi_envs/qc" required isMono hint={tool.pixiCreateNew?"Will be created with pixi init":"Must contain pixi.toml"}/>
                <div style={{ marginTop:20 }}>
                  <span style={{ fontSize:11,color:"rgba(255,255,255,.5)",letterSpacing:".08em",textTransform:"uppercase" }}>Install</span>
                  <div style={{ display:"flex",gap:12,marginTop:8 }}>
                    {[{k:"needsFastqc",l:"FastQC"},{k:"needsMultiqc",l:"MultiQC"}].map(t=>(
                      <label key={t.k} style={{ display:"flex",alignItems:"center",gap:8,cursor:"pointer",fontSize:13,color:"#e2e8f0" }}>
                        <input type="checkbox" checked={tool[t.k]} onChange={e=>setTool(p=>({...p,[t.k]:e.target.checked}))} style={{ accentColor:"#06b6d4",width:16,height:16 }}/>{t.l}
                      </label>
                    ))}
                  </div>
                </div>
              </Card>
            )}

            {tool.method==="path"&&(
              <Card style={{ animation:"fadeIn .3s ease" }}>
                <CTitle icon="✅">PATH Verification</CTitle>
                <p style={{ margin:0,fontSize:13,color:"rgba(255,255,255,.45)" }}>Will verify <code style={{ background:"rgba(0,0,0,.3)",padding:"2px 6px",borderRadius:4,fontFamily:mono,fontSize:11 }}>fastqc</code> and <code style={{ background:"rgba(0,0,0,.3)",padding:"2px 6px",borderRadius:4,fontFamily:mono,fontSize:11 }}>multiqc</code> are in PATH.</p>
              </Card>
            )}

            {tool.method&&(
              <Card style={{ animation:"fadeIn .3s ease" }}>
                <CTitle icon="⚡">{tool.method==="path"?"Verify Tools":"Install & Verify"}</CTitle>
                {instStatus!==S.success&&(
                  <Btn onClick={handleInstall} disabled={instStatus===S.running||(tool.method==="conda"&&!tool.condaEnvName)||(tool.method==="pixi"&&!tool.pixiProjectPath)}>
                    {instStatus===S.running?"⟳ Working…":tool.method==="path"?"🔍 Verify":"📥 Install & Verify"}
                  </Btn>
                )}
                {instLogs.length>0&&<div style={{ marginTop:16 }}><LogViewer title="Installation" logs={instLogs} status={instStatus} expanded={instX} onToggle={()=>setInstX(p=>!p)}/></div>}
              </Card>
            )}

            <div style={{ display:"flex",gap:12,marginTop:6 }}>
              <Back onClick={()=>setStep("connect")}/>
              <Btn onClick={()=>setStep("configure")} disabled={!canTools}>Configure Pipeline →</Btn>
            </div>
          </div>
        )}

        {/* ═══ STEP 3: Configure ═══ */}
        {step==="configure" && (
          <div style={{ animation:"fadeIn .5s ease" }}>
            <h2 style={{ margin:"0 0 6px",fontSize:26,fontWeight:700 }}>Configure QC Pipeline</h2>
            <p style={{ margin:"0 0 28px",color:"rgba(255,255,255,.4)",fontSize:13 }}>Set data path and parameters.</p>

            <Card>
              <CTitle icon="📂">Raw Sequence Data</CTitle>
              <Input label="Path to raw FASTQ directory" value={pipe.rawDataPath}
                onChange={v=>{setPipe(p=>({...p,rawDataPath:v}));setFiles([]);setPattern("");setScanSt(S.idle);setScanErr("")}}
                placeholder="/home/user/project/raw_data" required isMono hint="Absolute path to .fastq.gz files"/>

              <button onClick={handleScan} disabled={!pipe.rawDataPath||scanSt===S.running}
                style={{ marginTop:14,padding:"10px 20px",borderRadius:10,border:scanSt===S.success?"1px solid rgba(16,185,129,.25)":"1px solid rgba(6,182,212,.25)",
                  background:scanSt===S.running?"rgba(245,158,11,.15)":scanSt===S.success?"rgba(16,185,129,.12)":"rgba(6,182,212,.12)",
                  color:!pipe.rawDataPath?"rgba(255,255,255,.25)":scanSt===S.running?"#f59e0b":scanSt===S.success?"#10b981":"#06b6d4",
                  fontSize:13,fontWeight:600,cursor:!pipe.rawDataPath||scanSt===S.running?"not-allowed":"pointer",display:"flex",alignItems:"center",gap:8 }}>
                {scanSt===S.running?<><span style={{ animation:"pulse 1s infinite" }}>⟳</span> Scanning via SSH...</>
                  :scanSt===S.success?<>✓ Rescan Directory</>:<>🔍 Scan Directory via SSH</>}
              </button>

              {scanSt===S.running&&(
                <div style={{ marginTop:12,padding:"10px 14px",borderRadius:10,background:"rgba(245,158,11,.06)",border:"1px solid rgba(245,158,11,.1)",fontSize:12,color:"rgba(245,158,11,.7)",fontFamily:mono }}>
                  $ ls -1 {pipe.rawDataPath}/*.fastq.gz
                </div>
              )}
              {scanErr&&scanSt===S.error&&<div style={{ marginTop:12,padding:"10px 14px",borderRadius:10,background:"rgba(244,63,94,.08)",border:"1px solid rgba(244,63,94,.15)",fontSize:12,color:"#f43f5e" }}>✗ {scanErr}</div>}
              {scanErr&&scanSt===S.success&&<div style={{ marginTop:12,padding:"10px 14px",borderRadius:10,background:"rgba(245,158,11,.08)",border:"1px solid rgba(245,158,11,.15)",fontSize:12,color:"#f59e0b" }}>⚠ {scanErr}</div>}

              {files.length>0&&scanSt===S.success&&(
                <div style={{ marginTop:14,padding:"14px 16px",borderRadius:12,background:"rgba(16,185,129,.06)",border:"1px solid rgba(16,185,129,.15)",animation:"fadeIn .3s ease" }}>
                  <div style={{ display:"flex",alignItems:"center",gap:8,marginBottom:8 }}>
                    <span style={{ color:"#10b981" }}>✓</span>
                    <span style={{ fontSize:12,fontWeight:600,color:"#10b981" }}>Found {files.length} file{files.length!==1?"s":""}</span>
                    {pattern&&<span style={{ fontSize:10,color:"rgba(255,255,255,.35)",padding:"2px 8px",borderRadius:6,background:"rgba(255,255,255,.05)" }}>Pattern: {pattern}</span>}
                  </div>
                  <div style={{ marginTop:6,padding:"10px 12px",borderRadius:8,background:"rgba(0,0,0,.2)",maxHeight:160,overflowY:"auto" }}>
                    {files.map((f,i)=><div key={i} style={{ fontSize:11,padding:"3px 0",color:"rgba(255,255,255,.55)",fontFamily:mono,borderBottom:i<files.length-1?"1px solid rgba(255,255,255,.03)":"none" }}>{f}</div>)}
                  </div>
                  <div style={{ marginTop:8,fontSize:11,color:"rgba(255,255,255,.3)" }}>
                    {files.length%2===0?`${files.length/2} paired-end sample${files.length/2!==1?"s":""}`:"⚠ Odd file count — check pairs"}
                  </div>
                </div>
              )}
            </Card>

            <Card><CTitle icon="🔬">FastQC</CTitle><NumField label="Threads" value={pipe.fastqcThreads} onChange={v=>setPipe(p=>({...p,fastqcThreads:v}))}/></Card>

            <Card>
              <CTitle icon="📊">MultiQC</CTitle>
              <Input label="Report Name" value={pipe.multiqcName} onChange={v=>setPipe(p=>({...p,multiqcName:v}))} placeholder="my_project_multiqc" required isMono hint="Without .html"/>
              <div style={{ marginTop:10,fontSize:11,color:"rgba(255,255,255,.3)",fontFamily:mono }}>Output: <span style={{ color:"rgba(6,182,212,.7)" }}>analyses/1_QC/output/multiqc_report/{pipe.multiqcName||"..."}.html</span></div>
            </Card>

            <div style={{ display:"flex",gap:12 }}><Back onClick={()=>setStep("tools")}/><Btn onClick={()=>setStep("review")} disabled={!canReview}>Review →</Btn></div>
          </div>
        )}

        {/* ═══ STEP 4: Review ═══ */}
        {step==="review" && (
          <div style={{ animation:"fadeIn .5s ease" }}>
            <h2 style={{ margin:"0 0 6px",fontSize:26,fontWeight:700 }}>Review & Launch</h2>
            <p style={{ margin:"0 0 28px",color:"rgba(255,255,255,.4)",fontSize:13 }}>Verify before execution.</p>
            <Card>
              <CTitle icon="📋">Summary</CTitle>
              <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:12 }}>
                {[{l:"HPC",v:`${ssh.hostname}:${ssh.port}`},{l:"User",v:ssh.username},{l:"Auth",v:ssh.authMethod==="password"?"Password":`Key (${ssh.keyPath})`},{l:"Tools",v:toolLabel},{l:"Data",v:pipe.rawDataPath},{l:"Files",v:`${files.length} files`},{l:"FastQC Threads",v:`${pipe.fastqcThreads}`},{l:"MultiQC Report",v:`${pipe.multiqcName}.html`}].map((it,i)=>(
                  <div key={i} style={{ padding:"10px 14px",borderRadius:10,background:"rgba(0,0,0,.2)",border:"1px solid rgba(255,255,255,.04)" }}>
                    <div style={{ fontSize:10,color:"rgba(255,255,255,.3)",textTransform:"uppercase",letterSpacing:".06em",marginBottom:3 }}>{it.l}</div>
                    <div style={{ fontSize:12,color:"#e2e8f0",fontFamily:mono,wordBreak:"break-all" }}>{it.v}</div>
                  </div>
                ))}
              </div>
            </Card>
            <Card><CTitle icon="🌳">Directory Structure</CTitle><DirTree rawDataPath={pipe.rawDataPath}/></Card>

            {/* Exact commands preview */}
            {(() => {
              const raw = pipe.rawDataPath;
              const parent = raw.replace(/\/[^/]+\/?$/, "");
              const qc = `${parent}/analyses/1_QC`;
              let fqcCmd, mqcCmd, activateNote;
              if (tool.method === "conda") {
                const env = tool.condaEnvName;
                fqcCmd = `fastqc`;
                mqcCmd = `multiqc`;
                activateNote = `conda activate ${env}`;
              } else if (tool.method === "pixi") {
                fqcCmd = `pixi run fastqc`;
                mqcCmd = `pixi run multiqc`;
                activateNote = `cd ${tool.pixiProjectPath}`;
              } else {
                fqcCmd = `fastqc`;
                mqcCmd = `multiqc`;
                activateNote = null;
              }
              const fullFqc = `${fqcCmd} --threads ${pipe.fastqcThreads} --outdir "${qc}/output/fastqc_reports" "${qc}/input"/*.fastq.gz`;
              const fullMqc = `${mqcCmd} "${qc}/output/fastqc_reports" --outdir "${qc}/output/multiqc_report" --filename "${pipe.multiqcName}" --force`;
              const cmdBlockStyle = {
                padding: "12px 16px", borderRadius: 10, background: "rgba(0,0,0,.3)",
                border: "1px solid rgba(255,255,255,.06)", fontFamily: mono, fontSize: 11,
                lineHeight: 1.8, color: "#06b6d4", overflowX: "auto", whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              };
              const labelStyle = {
                fontSize: 10, color: "rgba(255,255,255,.35)", textTransform: "uppercase",
                letterSpacing: ".06em", marginBottom: 6, fontWeight: 500,
              };
              return (
                <Card>
                  <CTitle icon="💻">Exact Commands</CTitle>
                  {activateNote && (
                    <div style={{ marginBottom: 14 }}>
                      <div style={labelStyle}>Environment Activation</div>
                      <div style={cmdBlockStyle}>$ {activateNote}</div>
                    </div>
                  )}
                  <div style={{ marginBottom: 14 }}>
                    <div style={labelStyle}>FastQC Command</div>
                    <div style={cmdBlockStyle}>$ {fullFqc}</div>
                  </div>
                  <div style={{ marginBottom: 0 }}>
                    <div style={labelStyle}>MultiQC Command (runs automatically after FastQC)</div>
                    <div style={cmdBlockStyle}>$ {fullMqc}</div>
                  </div>
                </Card>
              );
            })()}

            <div style={{ background:"linear-gradient(135deg,rgba(245,158,11,.04),rgba(245,158,11,.08))",border:"1px solid rgba(245,158,11,.15)",borderRadius:16,padding:"18px 24px",marginBottom:18,display:"flex",alignItems:"center",justifyContent:"space-between" }}>
              <div>
                <div style={{ fontSize:11,color:"rgba(245,158,11,.7)",fontWeight:500,marginBottom:4 }}>✏️ MultiQC name (editable)</div>
                {editMqc?<input value={pipe.multiqcName} autoFocus onChange={e=>setPipe(p=>({...p,multiqcName:e.target.value}))} onBlur={()=>setEditMqc(false)} onKeyDown={e=>e.key==="Enter"&&setEditMqc(false)} style={{ padding:"5px 10px",borderRadius:8,border:"1px solid rgba(245,158,11,.3)",background:"rgba(0,0,0,.3)",color:"#e2e8f0",fontSize:13,outline:"none",fontFamily:mono,width:280 }}/>
                  :<span style={{ fontSize:13,fontFamily:mono,color:"#e2e8f0" }}>{pipe.multiqcName}.html</span>}
              </div>
              {!editMqc&&<button onClick={()=>setEditMqc(true)} style={{ padding:"7px 14px",borderRadius:8,border:"1px solid rgba(245,158,11,.2)",background:"rgba(245,158,11,.1)",color:"#f59e0b",fontSize:12,cursor:"pointer" }}>Edit</button>}
            </div>

            <div style={{ display:"flex",gap:12 }}><Back onClick={()=>setStep("configure")}/><Btn onClick={handleRun} color="green" style={{ fontSize:15,fontWeight:700,padding:16 }}>🚀 Start FastQC Analysis</Btn></div>
          </div>
        )}

        {/* ═══ STEP 5: Execution ═══ */}
        {step==="running" && (
          <div style={{ animation:"fadeIn .5s ease" }}>
            <h2 style={{ margin:"0 0 6px",fontSize:26,fontWeight:700 }}>Pipeline Execution</h2>
            <p style={{ margin:"0 0 28px",color:"rgba(255,255,255,.4)",fontSize:13 }}>{fSt===S.success&&mSt===S.success?"All analyses completed!":"Monitoring progress…"}</p>

            <div style={{ display:"flex",gap:12,marginBottom:20 }}>
              {[{l:"FastQC",s:fSt},{l:"MultiQC",s:mSt}].map((x,i)=>(
                <div key={i} style={{ flex:1,padding:"14px 18px",borderRadius:14,textAlign:"center",background:x.s===S.success?"rgba(16,185,129,.08)":x.s===S.running?"rgba(245,158,11,.08)":"rgba(255,255,255,.02)",border:`1px solid ${x.s===S.success?"rgba(16,185,129,.2)":x.s===S.running?"rgba(245,158,11,.2)":"rgba(255,255,255,.06)"}` }}>
                  <div style={{ fontSize:26,marginBottom:4,animation:x.s===S.running?"pulse 1.5s infinite":"none" }}>{x.s===S.success?"✅":x.s===S.running?"⏳":"⏸"}</div>
                  <div style={{ fontSize:13,fontWeight:600,color:x.s===S.success?"#10b981":x.s===S.running?"#f59e0b":"rgba(255,255,255,.3)" }}>{x.l}</div>
                </div>
              ))}
            </div>

            <div style={{ display:"flex",flexDirection:"column",gap:14 }}>
              <LogViewer title="FastQC Execution" logs={fLogs} status={fSt} expanded={fX} onToggle={()=>setFX(p=>!p)}/>
              <LogViewer title="MultiQC Execution (auto-triggered)" logs={mLogs} status={mSt} expanded={mX} onToggle={()=>setMX(p=>!p)}/>
            </div>

            {fSt===S.success&&mSt===S.success&&(
              <div style={{ marginTop:24,padding:"22px 24px",borderRadius:16,background:"linear-gradient(135deg,rgba(16,185,129,.06),rgba(6,182,212,.06))",border:"1px solid rgba(16,185,129,.15)",animation:"fadeIn .5s ease" }}>
                <h3 style={{ margin:"0 0 14px",fontSize:17,fontWeight:700,color:"#10b981" }}>✓ QC Pipeline Complete</h3>
                <DirTree rawDataPath={pipe.rawDataPath}/>
                <div style={{ marginTop:14,padding:"10px 14px",borderRadius:10,background:"rgba(0,0,0,.2)",fontFamily:mono,fontSize:11,color:"rgba(255,255,255,.45)",lineHeight:1.8 }}>
                  <div>📊 FastQC: analyses/1_QC/output/fastqc_reports/</div>
                  <div>📊 MultiQC: analyses/1_QC/output/multiqc_report/{pipe.multiqcName}.html</div>
                  <div>📋 Logs: analyses/1_QC/logs/</div>
                  <div>📜 Scripts: analyses/1_QC/scripts/</div>
                </div>
                <button onClick={resetAll} style={{ marginTop:14,padding:"10px 20px",borderRadius:10,border:"1px solid rgba(6,182,212,.2)",background:"rgba(6,182,212,.08)",color:"#06b6d4",fontSize:13,fontWeight:500,cursor:"pointer" }}>↻ New Analysis</button>
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ padding:"18px 32px",borderTop:"1px solid rgba(255,255,255,.04)",textAlign:"center",fontSize:10,color:"rgba(255,255,255,.18)",letterSpacing:".06em" }}>MetaQC Pipeline · FastQC + MultiQC · conda / mamba / pixi / PATH</div>
    </div>
  );
}
