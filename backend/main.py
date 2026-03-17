"""
MetaQC Pipeline — FastAPI Backend
SSH via paramiko, real-time logs via WebSocket.
SQLite for field autocomplete history.
"""

import asyncio
import functools
import io
import json
import logging
import os
import sqlite3
import uuid
import zipfile
from contextlib import asynccontextmanager
from typing import Optional, List

import paramiko
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("metaqc")

sessions: dict = {}

# ─── SQLite for field autocomplete ───────────────────────────────────────────
DB_PATH = os.environ.get("METAQC_DB", "/data/metaqc_history.db")


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS field_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            field_name TEXT NOT NULL,
            field_value TEXT NOT NULL,
            used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(field_name, field_value)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_field_name ON field_history(field_name)")
    conn.commit()
    conn.close()
    logger.info(f"SQLite DB initialized at {DB_PATH}")


def db_save_field(field_name: str, value: str):
    if not value or not value.strip():
        return
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "INSERT OR REPLACE INTO field_history (field_name, field_value, used_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
        (field_name, value.strip())
    )
    conn.commit()
    conn.close()


def db_get_suggestions(field_name: str, prefix: str = "") -> list:
    conn = sqlite3.connect(DB_PATH)
    if prefix:
        rows = conn.execute(
            "SELECT field_value FROM field_history WHERE field_name = ? AND field_value LIKE ? ORDER BY used_at DESC LIMIT 10",
            (field_name, f"{prefix}%")
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT field_value FROM field_history WHERE field_name = ? ORDER BY used_at DESC LIMIT 10",
            (field_name,)
        ).fetchall()
    conn.close()
    return [r[0] for r in rows]


def db_save_many(fields: dict):
    """Save multiple field values at once. fields = {field_name: value}"""
    conn = sqlite3.connect(DB_PATH)
    for name, value in fields.items():
        if value and str(value).strip():
            conn.execute(
                "INSERT OR REPLACE INTO field_history (field_name, field_value, used_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
                (name, str(value).strip())
            )
    conn.commit()
    conn.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield
    for sid, s in sessions.items():
        try:
            s["ssh_client"].close()
        except Exception:
            pass
    sessions.clear()


app = FastAPI(title="MetaQC Pipeline API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Models

class SSHConnectRequest(BaseModel):
    hostname: str
    port: int = 22
    username: str
    auth_method: str = "password"
    password: Optional[str] = None
    key_path: Optional[str] = None


class ScanDirectoryRequest(BaseModel):
    session_id: str
    path: str


class InstallToolsPayload(BaseModel):
    session_id: str
    method: str
    conda_use_mamba: bool = False
    conda_create_new: bool = True
    conda_env_name: str = "metagenomics_qc"
    pixi_create_new: bool = True
    pixi_project_path: str = ""
    needs_install_fastqc: bool = True
    needs_install_multiqc: bool = True


class RunPipelinePayload(BaseModel):
    session_id: str
    raw_data_path: str
    fastqc_threads: int = 8
    multiqc_name: str = "multiqc_report"
    tool_method: str = "conda"
    conda_env_name: str = ""
    pixi_project_path: str = ""
    conda_use_mamba: bool = False
    # BBDuk settings
    run_bbduk: bool = False
    bbduk_path: str = ""  # path to bbduk.sh (or empty if in PATH)
    bbmap_dir: str = ""   # path to bbmap install dir (for adapters.fa)
    bbduk_adapter_path: str = ""  # custom adapter file, empty = use built-in
    bbduk_ktrim: str = "r"
    bbduk_k: int = 23
    bbduk_mink: int = 11
    bbduk_hdist: int = 1
    bbduk_qtrim: str = "rl"
    bbduk_trimq: int = 20
    bbduk_minlen: int = 50
    bbduk_threads: int = 8
    post_trim_multiqc_name: str = "post_trim_multiqc_report"


class SetupBBDukPayload(BaseModel):
    session_id: str
    installed: bool = False        # True = already installed
    bbduk_path: str = ""           # path to bbduk.sh if installed
    install_path: str = ""         # where to download bbmap if not installed


# Helpers

def get_client(session_id: str) -> paramiko.SSHClient:
    if session_id not in sessions:
        raise HTTPException(404, "Session not found")
    c = sessions[session_id]["ssh_client"]
    t = c.get_transport()
    if not t or not t.is_active():
        raise HTTPException(410, "SSH connection lost")
    return c


def _ssh_exec_sync(client, cmd, timeout=120):
    """Blocking SSH exec."""
    try:
        _, stdout, stderr = client.exec_command(cmd, timeout=timeout)
        code = stdout.channel.recv_exit_status()
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        return out, err, code
    except Exception as e:
        return "", str(e), -1


async def ssh_exec(client, cmd, timeout=120):
    """Non-blocking SSH exec via thread pool."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None, functools.partial(_ssh_exec_sync, client, cmd, timeout)
    )


async def stream_channel_async(channel, websocket, stage):
    """Stream SSH channel output to websocket without blocking."""
    lines = []
    loop = asyncio.get_event_loop()
    while True:
        has_data = await loop.run_in_executor(None, channel.recv_ready)
        if has_data:
            chunk = await loop.run_in_executor(None, channel.recv, 4096)
            chunk = chunk.decode("utf-8", errors="replace")
            for line in chunk.split("\n"):
                if line.strip():
                    await websocket.send_json({
                        "type": "log", "stage": stage,
                        "message": f"  {line.strip()}", "level": "info",
                    })
                    lines.append(line)
        is_done = await loop.run_in_executor(None, channel.exit_status_ready)
        if is_done:
            while True:
                has_more = await loop.run_in_executor(None, channel.recv_ready)
                if not has_more:
                    break
                chunk = await loop.run_in_executor(None, channel.recv, 4096)
                chunk = chunk.decode("utf-8", errors="replace")
                for line in chunk.split("\n"):
                    if line.strip():
                        await websocket.send_json({
                            "type": "log", "stage": stage,
                            "message": f"  {line.strip()}", "level": "info",
                        })
                        lines.append(line)
            break
        await asyncio.sleep(0.15)
    exit_code = await loop.run_in_executor(None, channel.recv_exit_status)
    return exit_code, lines


def build_activate(req):
    method = getattr(req, "tool_method", None) or getattr(req, "method", "path")
    if method == "conda":
        env = req.conda_env_name
        act = f"source activate {env} 2>/dev/null || conda activate {env} 2>/dev/null"
        return act, "fastqc", "multiqc"
    elif method == "pixi":
        act = f'cd "{req.pixi_project_path}"'
        return act, "pixi run fastqc", "pixi run multiqc"
    return "", "fastqc", "multiqc"


def wrap_cmd(activate, cmd):
    if activate:
        return f'bash -c "{activate} && {cmd}"'
    return cmd


# REST Endpoints

@app.get("/api/health")
async def health():
    return {"status": "ok", "sessions": len(sessions)}


# ─── Autocomplete endpoints ──────────────────────────────────────────────────

class SaveFieldsRequest(BaseModel):
    fields: dict  # {field_name: value}


@app.get("/api/autocomplete/{field_name}")
async def get_autocomplete(field_name: str, prefix: str = ""):
    """Get autocomplete suggestions for a field."""
    suggestions = db_get_suggestions(field_name, prefix)
    return {"field": field_name, "suggestions": suggestions}


@app.post("/api/autocomplete/save")
async def save_autocomplete(req: SaveFieldsRequest):
    """Save multiple field values for future autocomplete."""
    db_save_many(req.fields)
    return {"saved": len(req.fields)}


@app.get("/api/autocomplete/all")
async def get_all_autocomplete():
    """Get all saved field values grouped by field name."""
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT field_name, field_value FROM field_history ORDER BY field_name, used_at DESC"
    ).fetchall()
    conn.close()
    result = {}
    for name, value in rows:
        if name not in result:
            result[name] = []
        if len(result[name]) < 10:
            result[name].append(value)
    return result


@app.post("/api/ssh/connect")
async def ssh_connect_endpoint(req: SSHConnectRequest):
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    kwargs = {
        "hostname": req.hostname, "port": req.port,
        "username": req.username,
        "timeout": 15, "banner_timeout": 15, "auth_timeout": 15,
    }

    try:
        if req.auth_method == "key" and req.key_path:
            kp = req.key_path
            key_filename = os.path.basename(kp)
            container_ssh_dir = "/home/appuser/.ssh"
            remapped = os.path.join(container_ssh_dir, key_filename)
            if os.path.exists(remapped):
                kp = remapped
                logger.info(f"Remapped key: {req.key_path} -> {kp}")
            elif os.path.exists(os.path.expanduser(kp)):
                kp = os.path.expanduser(kp)
            else:
                raise FileNotFoundError(
                    f"Key '{key_filename}' not found in mounted SSH directory. "
                    f"Ensure ~/.ssh is mounted in Docker and contains this key."
                )
            kwargs["key_filename"] = kp
        elif req.auth_method == "password" and req.password:
            kwargs["password"] = req.password
        else:
            raise ValueError("Provide password or key path")

        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, functools.partial(client.connect, **kwargs))

        sid = str(uuid.uuid4())[:12]
        sessions[sid] = {"ssh_client": client, "config": {
            "hostname": req.hostname, "port": req.port,
            "username": req.username, "auth_method": req.auth_method,
        }}

        uname, _, _ = await ssh_exec(client, "uname -n")
        logger.info(f"Connected: {req.username}@{req.hostname}:{req.port} [{sid}]")

        # Auto-save SSH fields for autocomplete
        db_save_many({
            "ssh_hostname": req.hostname,
            "ssh_port": str(req.port),
            "ssh_username": req.username,
            **({"ssh_key_path": req.key_path} if req.key_path else {}),
        })

        return {
            "session_id": sid, "success": True,
            "message": f"Connected to {uname.strip() or req.hostname}",
            "remote_hostname": uname.strip() or req.hostname,
        }
    except paramiko.AuthenticationException:
        client.close()
        raise HTTPException(401, "Authentication failed")
    except paramiko.SSHException as e:
        client.close()
        raise HTTPException(502, f"SSH error: {e}")
    except FileNotFoundError as e:
        client.close()
        raise HTTPException(400, str(e))
    except Exception as e:
        client.close()
        raise HTTPException(500, f"Connection failed: {e}")


@app.post("/api/ssh/disconnect")
async def ssh_disconnect(session_id: str):
    if session_id in sessions:
        try:
            sessions[session_id]["ssh_client"].close()
        except Exception:
            pass
        del sessions[session_id]
        return {"success": True}
    raise HTTPException(404, "Session not found")


@app.post("/api/scan-directory")
async def scan_directory(req: ScanDirectoryRequest):
    client = get_client(req.session_id)
    bad = [";", "&", "|", "`", "$", "(", ")", "{", "}"]
    if any(c in req.path for c in bad):
        raise HTTPException(400, "Invalid characters in path")

    out, _, code = await ssh_exec(client, f'test -d "{req.path}" && echo "Y" || echo "N"')
    if "N" in out:
        raise HTTPException(404, f"Directory not found: {req.path}")

    out, _, code = await ssh_exec(client, f'ls -1 "{req.path}"/*.fastq.gz 2>/dev/null')
    if code != 0 or not out.strip():
        raise HTTPException(404, f"No .fastq.gz files found in {req.path}")

    files = sorted([
        os.path.basename(f.strip())
        for f in out.strip().split("\n")
        if f.strip().endswith(".fastq.gz")
    ])
    if not files:
        raise HTTPException(404, f"No .fastq.gz files found in {req.path}")

    patterns = [
        ("_R1_001", "_R1/_R2_001.fastq.gz (Illumina)"),
        ("_1.fastq", "_1/_2.fastq.gz"),
        ("_R1.fastq", "_R1/_R2.fastq.gz"),
        (".R1.fastq", ".R1/.R2.fastq.gz"),
    ]
    detected = None
    for marker, label in patterns:
        if any(marker in f for f in files):
            detected = label
            break
    return {"files": files, "count": len(files), "pattern": detected, "path": req.path}


# Download MultiQC Reports

class DownloadReportsRequest(BaseModel):
    session_id: str
    raw_data_path: str
    multiqc_name: str = "multiqc_report"
    include_post_trim: bool = False
    post_trim_multiqc_name: str = "post_trim_multiqc_report"
    include_decontam: bool = False
    decontam_multiqc_name: str = "decontam_multiqc_report"


@app.post("/api/download-reports")
async def download_reports(req: DownloadReportsRequest):
    """Fetch MultiQC HTML reports from HPC via SFTP and return as a zip."""
    client = get_client(req.session_id)

    raw = req.raw_data_path.rstrip("/")
    parent = os.path.dirname(raw)

    reports = []
    qc_report = f"{parent}/analyses/1_QC/output/multiqc_report/{req.multiqc_name}.html"
    reports.append(("1_QC_multiqc", qc_report))

    if req.include_post_trim:
        pt_report = f"{parent}/analyses/2_reads_preprocessing/1_adapter_trimming_and_filtering/output/multiqc_report/{req.post_trim_multiqc_name}.html"
        reports.append(("post_trim_multiqc", pt_report))

    if req.include_decontam:
        dc_report = f"{parent}/analyses/2_reads_preprocessing/2_decontamination/output/multiqc_report/{req.decontam_multiqc_name}.html"
        reports.append(("post_decontam_multiqc", dc_report))

    # Open SFTP and read files
    loop = asyncio.get_event_loop()

    def _build_zip():
        sftp = client.open_sftp()
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for label, remote_path in reports:
                try:
                    with sftp.open(remote_path, "r") as rf:
                        data = rf.read()
                    filename = os.path.basename(remote_path)
                    # Prefix with label to avoid name collisions
                    zf.writestr(f"{label}/{filename}", data)
                    logger.info(f"Added to zip: {label}/{filename}")
                except FileNotFoundError:
                    logger.warning(f"Report not found: {remote_path}")
                    # Add a note file instead
                    zf.writestr(f"{label}/NOT_FOUND.txt", f"Report not found on HPC:\n{remote_path}")
                except Exception as e:
                    logger.error(f"Error reading {remote_path}: {e}")
                    zf.writestr(f"{label}/ERROR.txt", f"Error reading report:\n{remote_path}\n{str(e)}")
        sftp.close()
        buf.seek(0)
        return buf

    try:
        zip_buf = await loop.run_in_executor(None, _build_zip)
    except Exception as e:
        raise HTTPException(500, f"Failed to fetch reports: {str(e)}")

    return StreamingResponse(
        zip_buf,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=multiqc_reports.zip"},
    )


# WebSocket: Install Tools

@app.websocket("/ws/install-tools")
async def ws_install_tools(websocket: WebSocket):
    await websocket.accept()
    try:
        data = await websocket.receive_json()
        req = InstallToolsPayload(**data)
        client = get_client(req.session_id)

        # Auto-save tool config
        fields = {"tool_method": req.method}
        if req.method == "conda":
            fields["conda_env_name"] = req.conda_env_name
        elif req.method == "pixi":
            fields["pixi_project_path"] = req.pixi_project_path
        db_save_many(fields)

        async def log(msg, lvl="info"):
            await websocket.send_json({"type": "log", "message": msg, "level": lvl})

        async def set_status(s):
            await websocket.send_json({"type": "status", "status": s})

        await set_status("running")

        if req.method == "path":
            for tn in ["fastqc", "multiqc"]:
                await log(f">>> Checking {tn} availability...")
                out, err, code = await ssh_exec(client, f"which {tn} 2>/dev/null")
                if code == 0 and out.strip():
                    await log(f"$ which {tn}")
                    await log(f"  {out.strip()}")
                    await log(f">>> Getting {tn} version...")
                    v, _, _ = await ssh_exec(client, f"{tn} --version 2>&1", timeout=60)
                    await log(f"  {v.strip()}")
                    await log(f"✓ {tn} found", "success")
                else:
                    await log(f"✗ {tn} not found in PATH", "error")
                    if err.strip():
                        await log(f"  {err.strip()}", "error")
                    await set_status("error")
                    return
                await log("")
            await log("SUCCESS All tools verified!", "success")
            await set_status("success")

        elif req.method == "conda":
            mgr = "mamba" if req.conda_use_mamba else "conda"
            if req.conda_create_new:
                await log(f">>> Creating {mgr} environment: {req.conda_env_name}")
                cmd = f"{mgr} create -n {req.conda_env_name} -y 2>&1"
                await log(f"$ {cmd}")
                out, err, code = await ssh_exec(client, cmd, timeout=300)
                for ln in out.strip().split("\n")[-5:]:
                    if ln.strip():
                        await log(f"  {ln.strip()}")
                if code != 0:
                    await log(f"✗ Failed: {err.strip()}", "error")
                    await set_status("error")
                    return
                await log("✓ Environment created", "success")
                await log("")

            for tn, flag in [("fastqc", req.needs_install_fastqc), ("multiqc", req.needs_install_multiqc)]:
                if flag:
                    await log(f">>> Installing {tn} via {mgr}...")
                    cmd = f"{mgr} install -n {req.conda_env_name} -c bioconda -c conda-forge {tn} -y 2>&1"
                    await log(f"$ {cmd}")
                    out, err, code = await ssh_exec(client, cmd, timeout=600)
                    for ln in out.strip().split("\n")[-5:]:
                        if ln.strip():
                            await log(f"  {ln.strip()}")
                    if code != 0:
                        await log(f"✗ {tn} install failed: {err.strip()}", "error")
                        await set_status("error")
                        return
                    await log(f"✓ {tn} installed", "success")
                    await log("")

            await log(">>> Verifying (may take a moment)...")
            act = f"source activate {req.conda_env_name} 2>/dev/null || conda activate {req.conda_env_name} 2>/dev/null"
            for tn in ["fastqc", "multiqc"]:
                await log(f"  Checking {tn}...")
                v, err, code = await ssh_exec(client, f'bash -c "{act} && {tn} --version 2>&1"', timeout=120)
                if v.strip():
                    await log(f"  {tn}: {v.strip()}")
                else:
                    await log(f"  {tn}: no output (exit {code})", "error")
            await log("")
            await log("SUCCESS All tools installed and verified!", "success")
            await set_status("success")

        elif req.method == "pixi":
            if req.pixi_create_new:
                await log(f">>> Initializing pixi project at {req.pixi_project_path}")
                cmd = f'mkdir -p "{req.pixi_project_path}" && cd "{req.pixi_project_path}" && pixi init 2>&1'
                await log(f"$ {cmd}")
                out, err, code = await ssh_exec(client, cmd, timeout=60)
                if out.strip():
                    await log(f"  {out.strip()}")
                if code != 0 and "already" not in (out + err).lower():
                    await log(f"✗ pixi init failed: {err.strip()}", "error")
                    await set_status("error")
                    return
                await log("✓ Project initialized", "success")

                for ch in ["bioconda", "conda-forge"]:
                    cmd = f'cd "{req.pixi_project_path}" && pixi project channel add {ch} 2>&1'
                    await log(f"$ pixi project channel add {ch}")
                    out, _, _ = await ssh_exec(client, cmd, timeout=30)
                    if out.strip():
                        await log(f"  {out.strip()}")
                    await log(f"✓ Channel {ch} added", "success")
                await log("")
            else:
                # Existing project: verify pixi.toml exists
                await log(f">>> Verifying pixi project at {req.pixi_project_path}...")
                out, _, code = await ssh_exec(
                    client,
                    f'test -f "{req.pixi_project_path}/pixi.toml" && echo "FOUND" || echo "MISSING"'
                )
                if "MISSING" in out:
                    await log(f"✗ No pixi.toml found at {req.pixi_project_path}", "error")
                    await log("  Ensure the path points to an initialized pixi project.", "error")
                    await set_status("error")
                    return
                await log("✓ pixi.toml found", "success")
                await log("")

            # Install tools if checkboxes are checked
            for tn, flag in [("fastqc", req.needs_install_fastqc), ("multiqc", req.needs_install_multiqc)]:
                if flag:
                    await log(f">>> Adding {tn} to pixi project...")
                    cmd = f'cd "{req.pixi_project_path}" && pixi add {tn} 2>&1'
                    await log(f"$ {cmd}")
                    out, err, code = await ssh_exec(client, cmd, timeout=300)
                    for ln in out.strip().split("\n")[-5:]:
                        if ln.strip():
                            await log(f"  {ln.strip()}")
                    if code != 0:
                        await log(f"✗ Failed to add {tn}: {err.strip()}", "error")
                        await set_status("error")
                        return
                    await log(f"✓ {tn} added", "success")
                    await log("")

            # Verify tools — use streaming to show progress (pixi first-run can be slow)
            await log(">>> Verifying tools...")
            await log("  (First run may take a while as pixi resolves the environment)")
            await log("")
            for tn in ["fastqc", "multiqc"]:
                await log(f"  Checking {tn}...")
                cmd = f'cd "{req.pixi_project_path}" && pixi run {tn} --version 2>&1'
                await log(f"  $ {cmd}")

                # Use streaming channel so output appears in real-time
                transport = client.get_transport()
                channel = transport.open_session()
                channel.settimeout(600)  # 10 min for first pixi resolve
                channel.exec_command(cmd)

                tool_output = []
                loop = asyncio.get_event_loop()
                heartbeat_count = 0
                while True:
                    has_data = await loop.run_in_executor(None, channel.recv_ready)
                    if has_data:
                        chunk = await loop.run_in_executor(None, channel.recv, 4096)
                        text = chunk.decode("utf-8", errors="replace")
                        for line in text.split("\n"):
                            if line.strip():
                                await log(f"    {line.strip()}")
                                tool_output.append(line.strip())
                    is_done = await loop.run_in_executor(None, lambda: channel.exit_status_ready())
                    if is_done:
                        # Drain remaining
                        while True:
                            has_more = await loop.run_in_executor(None, channel.recv_ready)
                            if not has_more:
                                break
                            chunk = await loop.run_in_executor(None, channel.recv, 4096)
                            text = chunk.decode("utf-8", errors="replace")
                            for line in text.split("\n"):
                                if line.strip():
                                    await log(f"    {line.strip()}")
                                    tool_output.append(line.strip())
                        break
                    # Send heartbeat so frontend knows we're alive
                    heartbeat_count += 1
                    if heartbeat_count % 10 == 0:
                        await log(f"    ... still working ({heartbeat_count // 5}s elapsed)")
                    await asyncio.sleep(0.5)

                exit_code = channel.recv_exit_status()
                channel.close()

                if exit_code == 0 and tool_output:
                    await log(f"  ✓ {tn} verified", "success")
                else:
                    await log(f"  ✗ {tn} verification failed (exit {exit_code})", "error")
                    await set_status("error")
                    return
                await log("")

            await log("SUCCESS All tools installed and verified!", "success")
            await set_status("success")

    except WebSocketDisconnect:
        logger.info("WS disconnected (install)")
    except Exception as e:
        logger.error(f"Install error: {e}", exc_info=True)
        try:
            await websocket.send_json({"type": "log", "message": f"ERROR {e}", "level": "error"})
            await websocket.send_json({"type": "status", "status": "error"})
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


# WebSocket: Setup BBDuk

@app.websocket("/ws/setup-bbduk")
async def ws_setup_bbduk(websocket: WebSocket):
    await websocket.accept()
    try:
        data = await websocket.receive_json()
        req = SetupBBDukPayload(**data)
        client = get_client(req.session_id)

        async def log(msg, lvl="info"):
            await websocket.send_json({"type": "log", "message": msg, "level": lvl})

        async def set_status(s, **extra):
            await websocket.send_json({"type": "status", "status": s, **extra})

        await set_status("running")

        if req.installed:
            # Verify existing bbduk.sh
            bbduk = req.bbduk_path.rstrip("/")
            await log(f">>> Verifying BBDuk at: {bbduk}")
            out, err, code = await ssh_exec(client, f'test -f "{bbduk}" && echo "FOUND" || echo "MISSING"')
            if "MISSING" in out:
                await log(f"✗ bbduk.sh not found at {bbduk}", "error")
                await set_status("error")
                return
            await log("✓ bbduk.sh found")

            # Test it runs
            await log(">>> Testing bbduk.sh...")
            out, err, code = await ssh_exec(client, f'bash "{bbduk}" --version 2>&1 | head -3', timeout=30)
            if out.strip():
                for line in out.strip().split("\n")[:3]:
                    await log(f"  {line.strip()}")
            await log("✓ BBDuk is functional", "success")

            # Find bbmap dir (parent of bbduk.sh) for adapters.fa
            bbmap_dir = os.path.dirname(bbduk)
            adapters = f"{bbmap_dir}/resources/adapters.fa"
            await log(f">>> Checking built-in adapters at: {adapters}")
            out, _, _ = await ssh_exec(client, f'test -f "{adapters}" && echo "FOUND" || echo "MISSING"')
            if "FOUND" in out:
                await log("✓ adapters.fa found", "success")
            else:
                await log("⚠ adapters.fa not found — you'll need to provide a custom adapter file", "info")
                adapters = ""

            await log("")
            await log("SUCCESS BBDuk verified!", "success")
            db_save_many({"bbduk_path": bbduk, "bbmap_dir": bbmap_dir})
            await set_status("success", bbmap_dir=bbmap_dir, bbduk_path=bbduk, adapters_path=adapters)

        else:
            # Download and install BBMap/BBDuk
            install_dir = req.install_path.rstrip("/")
            await log(f">>> Installing BBMap suite to: {install_dir}")
            await log(f"$ mkdir -p \"{install_dir}\"")
            _, err, code = await ssh_exec(client, f'mkdir -p "{install_dir}"')
            if code != 0:
                await log(f"✗ Failed to create directory: {err.strip()}", "error")
                await set_status("error")
                return
            await log("✓ Directory created")
            await log("")

            # Download latest BBMap
            await log(">>> Downloading BBMap from SourceForge...")
            dl_url = "https://sourceforge.net/projects/bbmap/files/latest/download"
            dl_cmd = f'cd "{install_dir}" && curl -L -o bbmap.tar.gz "{dl_url}" 2>&1'
            await log(f"$ curl -L -o bbmap.tar.gz {dl_url}")

            loop = asyncio.get_event_loop()
            ch = await loop.run_in_executor(None, client.get_transport().open_session)
            ch.settimeout(600)
            await loop.run_in_executor(None, ch.exec_command, dl_cmd)
            exit_code, _ = await stream_channel_async(ch, websocket, "bbduk_install")
            await loop.run_in_executor(None, ch.close)

            if exit_code != 0:
                await log("✗ Download failed", "error")
                await set_status("error")
                return
            await log("✓ Download complete")
            await log("")

            # Extract
            await log(">>> Extracting BBMap...")
            ext_cmd = f'cd "{install_dir}" && tar -xzf bbmap.tar.gz 2>&1'
            await log(f"$ tar -xzf bbmap.tar.gz")
            out, err, code = await ssh_exec(client, ext_cmd, timeout=120)
            if code != 0:
                await log(f"✗ Extraction failed: {err.strip()}", "error")
                await set_status("error")
                return
            await log("✓ Extracted")

            # Clean up tarball
            await ssh_exec(client, f'rm -f "{install_dir}/bbmap.tar.gz"')
            await log("")

            # Verify
            bbmap_dir = f"{install_dir}/bbmap"
            bbduk_path = f"{bbmap_dir}/bbduk.sh"
            await log(f">>> Verifying installation at: {bbduk_path}")
            out, _, code = await ssh_exec(client, f'test -f "{bbduk_path}" && echo "FOUND" || echo "MISSING"')
            if "MISSING" in out or code != 0:
                await log("✗ bbduk.sh not found after extraction", "error")
                await set_status("error")
                return
            await log("✓ bbduk.sh found")

            out, _, _ = await ssh_exec(client, f'bash "{bbduk_path}" --version 2>&1 | head -3', timeout=30)
            if out.strip():
                for line in out.strip().split("\n")[:3]:
                    await log(f"  {line.strip()}")

            adapters = f"{bbmap_dir}/resources/adapters.fa"
            out, _, _ = await ssh_exec(client, f'test -f "{adapters}" && echo "FOUND" || echo "MISSING"')
            if "FOUND" in out:
                await log("✓ Built-in adapters.fa found", "success")
            else:
                adapters = ""
                await log("⚠ adapters.fa not found", "info")

            await log("")
            await log("SUCCESS BBMap/BBDuk installed!", "success")
            db_save_many({"bbduk_path": bbduk_path, "bbmap_dir": bbmap_dir, "bbduk_install_path": install_dir})
            await set_status("success", bbmap_dir=bbmap_dir, bbduk_path=bbduk_path, adapters_path=adapters)

    except WebSocketDisconnect:
        logger.info("WS disconnected (bbduk setup)")
    except Exception as e:
        logger.error(f"BBDuk setup error: {e}", exc_info=True)
        try:
            await websocket.send_json({"type": "log", "message": f"ERROR {e}", "level": "error"})
            await websocket.send_json({"type": "status", "status": "error"})
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


# WebSocket: Run Pipeline

@app.websocket("/ws/run-pipeline")
async def ws_run_pipeline(websocket: WebSocket):
    await websocket.accept()
    try:
        data = await websocket.receive_json()
        req = RunPipelinePayload(**data)
        client = get_client(req.session_id)
        activate, fqc_cmd, mqc_cmd = build_activate(req)

        async def log(msg, stage="fastqc", lvl="info"):
            await websocket.send_json({"type": "log", "stage": stage, "message": msg, "level": lvl})

        async def set_status(stage, s):
            await websocket.send_json({"type": "status", "stage": stage, "status": s})

        raw = req.raw_data_path.rstrip("/")
        parent = os.path.dirname(raw)
        qc = f"{parent}/analyses/1_QC"
        loop = asyncio.get_event_loop()

        # Auto-save pipeline fields for autocomplete
        db_save_many({
            "raw_data_path": req.raw_data_path,
            "multiqc_name": req.multiqc_name,
        })

        # FASTQC
        await set_status("fastqc", "running")

        await log(">>> Creating directory structure...", "fastqc")
        mk = f'mkdir -p "{qc}/input" "{qc}/output/fastqc_reports" "{qc}/output/multiqc_report" "{qc}/logs" "{qc}/scripts"'
        await log(f"$ {mk}", "fastqc")
        _, err, code = await ssh_exec(client, mk)
        if code != 0:
            await log(f"✗ {err.strip()}", "fastqc", "error")
            await set_status("fastqc", "error")
            return
        await log("✓ Directories created", "fastqc", "success")
        await log("", "fastqc")

        await log(">>> Symlinking raw FASTQ files...", "fastqc")
        sym = f'for f in "{raw}"/*.fastq.gz; do [ -e "$f" ] && ln -sf "$f" "{qc}/input/$(basename "$f")"; done'
        await log(f"$ {sym}", "fastqc")
        await ssh_exec(client, sym)

        ls_out, _, _ = await ssh_exec(client, f'ls -1 "{qc}/input/"*.fastq.gz 2>/dev/null')
        linked = [os.path.basename(f.strip()) for f in ls_out.strip().split("\n") if f.strip()]
        for f in linked:
            await log(f"  -> {f}", "fastqc")
        await log(f"✓ {len(linked)} files symlinked", "fastqc", "success")
        await log("", "fastqc")

        await log(">>> Recording FastQC version...", "fastqc")
        v_out, _, _ = await ssh_exec(client, wrap_cmd(activate, f"{fqc_cmd} --version 2>&1"), timeout=120)
        fqc_ver = v_out.strip()
        await log(f"  {fqc_ver}", "fastqc")
        await ssh_exec(client, f'echo "FastQC: {fqc_ver}" > "{qc}/logs/software_versions.txt"')
        await log("", "fastqc")

        script = generate_fastqc_script(req, activate, fqc_cmd, qc, raw, fqc_ver)
        await ssh_exec(client, f"cat > \"{qc}/scripts/run_fastqc.sh\" << 'METAQC_EOF'\n{script}\nMETAQC_EOF")
        await ssh_exec(client, f'chmod +x "{qc}/scripts/run_fastqc.sh"')

        await log(f">>> Running FastQC with {req.fastqc_threads} threads...", "fastqc")
        run = wrap_cmd(activate, f'{fqc_cmd} --threads {req.fastqc_threads} --outdir "{qc}/output/fastqc_reports" "{qc}/input"/*.fastq.gz 2>&1')
        await log(f"$ {fqc_cmd} --threads {req.fastqc_threads} --outdir .../fastqc_reports/ .../input/*.fastq.gz", "fastqc")

        ch = await loop.run_in_executor(None, client.get_transport().open_session)
        await loop.run_in_executor(None, ch.exec_command, run)
        exit_code, log_lines = await stream_channel_async(ch, websocket, "fastqc")
        await loop.run_in_executor(None, ch.close)

        await ssh_exec(client, f"cat > \"{qc}/logs/fastqc.log\" << 'METAQC_EOF'\n" + "\n".join(log_lines) + "\nMETAQC_EOF")

        if exit_code != 0:
            await log(f"✗ FastQC failed (exit {exit_code})", "fastqc", "error")
            await set_status("fastqc", "error")
            return

        await log("", "fastqc")
        await log("✓ FastQC complete", "fastqc", "success")
        vc = fqc_ver.replace("FastQC v", "").replace("FastQC ", "").strip()
        await ssh_exec(client, f'cp "{qc}/scripts/run_fastqc.sh" "{qc}/scripts/run_fastqc_v{vc}.sh" 2>/dev/null')
        await log(f"✓ Script archived: run_fastqc_v{vc}.sh", "fastqc", "success")
        await set_status("fastqc", "success")

        # MULTIQC
        await asyncio.sleep(0.5)
        await set_status("multiqc", "running")

        await log(">>> Recording MultiQC version...", "multiqc")
        v_out, _, _ = await ssh_exec(client, wrap_cmd(activate, f"{mqc_cmd} --version 2>&1"), timeout=120)
        mqc_ver = v_out.strip()
        await log(f"  {mqc_ver}", "multiqc")
        await ssh_exec(client, f'echo "MultiQC: {mqc_ver}" >> "{qc}/logs/software_versions.txt"')
        await log("", "multiqc")

        script = generate_multiqc_script(req, activate, mqc_cmd, qc, mqc_ver)
        await ssh_exec(client, f"cat > \"{qc}/scripts/run_multiqc.sh\" << 'METAQC_EOF'\n{script}\nMETAQC_EOF")
        await ssh_exec(client, f'chmod +x "{qc}/scripts/run_multiqc.sh"')

        await log(">>> Running MultiQC...", "multiqc")
        run = wrap_cmd(activate, f'{mqc_cmd} "{qc}/output/fastqc_reports" --outdir "{qc}/output/multiqc_report" --filename "{req.multiqc_name}" --force 2>&1')
        await log(f"$ {mqc_cmd} .../fastqc_reports/ --outdir .../multiqc_report/ --filename {req.multiqc_name} --force", "multiqc")

        ch = await loop.run_in_executor(None, client.get_transport().open_session)
        await loop.run_in_executor(None, ch.exec_command, run)
        exit_code, log_lines = await stream_channel_async(ch, websocket, "multiqc")
        await loop.run_in_executor(None, ch.close)

        await ssh_exec(client, f"cat > \"{qc}/logs/multiqc.log\" << 'METAQC_EOF'\n" + "\n".join(log_lines) + "\nMETAQC_EOF")

        if exit_code != 0:
            await log(f"✗ MultiQC failed (exit {exit_code})", "multiqc", "error")
            await set_status("multiqc", "error")
            return

        await log("", "multiqc")
        await log("✓ MultiQC complete", "multiqc", "success")
        await log(f"✓ Report: {qc}/output/multiqc_report/{req.multiqc_name}.html", "multiqc", "success")
        vc = mqc_ver.split("version")[-1].strip().strip(",") if "version" in mqc_ver else mqc_ver.strip()
        await ssh_exec(client, f'cp "{qc}/scripts/run_multiqc.sh" "{qc}/scripts/run_multiqc_v{vc}.sh" 2>/dev/null')
        await log(f"✓ Script archived: run_multiqc_v{vc}.sh", "multiqc", "success")
        await log("", "multiqc")
        await log("SUCCESS QC complete!", "multiqc", "success")
        await set_status("multiqc", "success")

    except WebSocketDisconnect:
        logger.info("WS disconnected (pipeline)")
    except Exception as e:
        logger.error(f"Pipeline error: {e}", exc_info=True)
        try:
            await websocket.send_json({"type": "log", "stage": "fastqc", "message": f"ERROR {e}", "level": "error"})
            await websocket.send_json({"type": "status", "stage": "fastqc", "status": "error"})
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


# ─── WebSocket: Run Preprocessing (BBDuk + post-trim QC) ─────────────────────

class RunPreprocessingPayload(BaseModel):
    session_id: str
    raw_data_path: str
    fastqc_threads: int = 8
    tool_method: str = "conda"
    conda_env_name: str = ""
    pixi_project_path: str = ""
    conda_use_mamba: bool = False
    bbduk_path: str = ""
    bbmap_dir: str = ""
    bbduk_adapter_path: str = ""
    bbduk_ktrim: str = "r"
    bbduk_k: int = 23
    bbduk_mink: int = 11
    bbduk_hdist: int = 1
    bbduk_qtrim: str = "rl"
    bbduk_trimq: int = 20
    bbduk_minlen: int = 50
    bbduk_threads: int = 8
    trimmed_suffix: str = "_trimmed"
    post_trim_multiqc_name: str = "post_trim_multiqc_report"


@app.websocket("/ws/run-preprocessing")
async def ws_run_preprocessing(websocket: WebSocket):
    await websocket.accept()
    try:
        data = await websocket.receive_json()
        req = RunPreprocessingPayload(**data)
        client = get_client(req.session_id)
        activate, fqc_cmd, mqc_cmd = build_activate(req)

        async def log(msg, stage="bbduk", lvl="info"):
            await websocket.send_json({"type": "log", "stage": stage, "message": msg, "level": lvl})

        async def set_status(stage, s):
            await websocket.send_json({"type": "status", "stage": stage, "status": s})

        raw = req.raw_data_path.rstrip("/")
        parent = os.path.dirname(raw)
        preproc = f"{parent}/analyses/2_reads_preprocessing/1_adapter_trimming_and_filtering"
        loop = asyncio.get_event_loop()

        bbduk_sh = req.bbduk_path or f"{req.bbmap_dir}/bbduk.sh"
        adapter_ref = req.bbduk_adapter_path or f"{req.bbmap_dir}/resources/adapters.fa"

        # Auto-save preprocessing fields
        db_save_many({
            "trimmed_suffix": req.trimmed_suffix,
            "post_trim_multiqc_name": req.post_trim_multiqc_name,
        })

        # ════════ BBDUK ════════
        await set_status("bbduk", "running")

        await log(">>> Creating directory structure...")
        mk = f'mkdir -p "{preproc}/input" "{preproc}/output/trimmed_reads" "{preproc}/output/fastqc_reports" "{preproc}/output/multiqc_report" "{preproc}/logs" "{preproc}/scripts"'
        await log(f"$ {mk}")
        _, err, code = await ssh_exec(client, mk)
        if code != 0:
            await log(f"✗ {err.strip()}", "bbduk", "error")
            await set_status("bbduk", "error")
            return
        await log("✓ Directories created", "bbduk", "success")
        await log("")

        await log(">>> Symlinking raw FASTQ to input...")
        sym = f'for f in "{raw}"/*.fastq.gz; do [ -e "$f" ] && ln -sf "$f" "{preproc}/input/$(basename "$f")"; done'
        await ssh_exec(client, sym)
        ls_out, _, _ = await ssh_exec(client, f'ls -1 "{preproc}/input/"*.fastq.gz 2>/dev/null')
        linked = [os.path.basename(f.strip()) for f in ls_out.strip().split("\n") if f.strip()]
        for f in linked:
            await log(f"  → {f}")
        await log(f"✓ {len(linked)} files symlinked", "bbduk", "success")
        await log("")

        await log(">>> Recording BBDuk version...")
        v_out, _, _ = await ssh_exec(client, f'bash "{bbduk_sh}" --version 2>&1 | head -1', timeout=30)
        bbduk_ver = v_out.strip()
        await log(f"  {bbduk_ver}")
        await ssh_exec(client, f'echo "BBDuk: {bbduk_ver}" > "{preproc}/logs/software_versions.txt"')
        await log("")

        # Get R1 files
        ls_out, _, _ = await ssh_exec(client, f'ls -1 "{preproc}/input/"*_R1*.fastq.gz 2>/dev/null || ls -1 "{preproc}/input/"*_1.fastq.gz 2>/dev/null')
        r1_files = [os.path.basename(f.strip()) for f in ls_out.strip().split("\n") if f.strip()]

        if not r1_files:
            await log("✗ No R1 files found for paired-end processing", "bbduk", "error")
            await set_status("bbduk", "error")
            return

        await log(f">>> Processing {len(r1_files)} paired-end samples with BBDuk...")

        bbduk_params = (
            f"ref={adapter_ref} "
            f"ktrim={req.bbduk_ktrim} k={req.bbduk_k} mink={req.bbduk_mink} hdist={req.bbduk_hdist} "
            f"qtrim={req.bbduk_qtrim} trimq={req.bbduk_trimq} minlen={req.bbduk_minlen} "
            f"threads={req.bbduk_threads} tpe tbo"
        )

        # Save script
        bbduk_script = generate_bbduk_script(req, bbduk_sh, adapter_ref, preproc, raw, bbduk_ver)
        await ssh_exec(client, f"cat > \"{preproc}/scripts/run_bbduk.sh\" << 'METAQC_EOF'\n{bbduk_script}\nMETAQC_EOF")
        await ssh_exec(client, f'chmod +x "{preproc}/scripts/run_bbduk.sh"')

        all_bbduk_logs = []
        suffix = req.trimmed_suffix  # e.g. "_trimmed"
        for r1 in r1_files:
            if "_R1_" in r1:
                r2 = r1.replace("_R1_", "_R2_")
                # sample_28_R1_001.fastq.gz -> sample_28_R1_trimmed.fastq.gz
                out1 = r1.replace(".fastq.gz", f"{suffix}.fastq.gz")
                out2 = r2.replace(".fastq.gz", f"{suffix}.fastq.gz")
            elif "_R1." in r1:
                r2 = r1.replace("_R1.", "_R2.")
                out1 = r1.replace("_R1.", f"_R1{suffix}.")
                out2 = r2.replace("_R2.", f"_R2{suffix}.")
            elif "_1.fastq" in r1:
                r2 = r1.replace("_1.fastq", "_2.fastq")
                out1 = r1.replace("_1.fastq", f"_1{suffix}.fastq")
                out2 = r2.replace("_2.fastq", f"_2{suffix}.fastq")
            else:
                await log(f"  ⚠ Can't determine R2 for {r1}, skipping")
                continue

            sample = r1.split("_R1")[0].split("_1.fastq")[0]

            await log(f"  >>> Processing: {sample}")
            cmd = (
                f'bash "{bbduk_sh}" '
                f'in1="{preproc}/input/{r1}" in2="{preproc}/input/{r2}" '
                f'out1="{preproc}/output/trimmed_reads/{out1}" out2="{preproc}/output/trimmed_reads/{out2}" '
                f'{bbduk_params} 2>&1'
            )
            await log(f"  $ bbduk.sh in1={r1} in2={r2} out1={out1} out2={out2} {bbduk_params}")

            ch = await loop.run_in_executor(None, client.get_transport().open_session)
            ch.settimeout(1800)
            await loop.run_in_executor(None, ch.exec_command, cmd)
            exit_code, lines = await stream_channel_async(ch, websocket, "bbduk")
            await loop.run_in_executor(None, ch.close)
            all_bbduk_logs.extend(lines)

            if exit_code != 0:
                await log(f"  ✗ BBDuk failed for {sample} (exit {exit_code})", "bbduk", "error")
                await set_status("bbduk", "error")
                return
            await log(f"  ✓ {sample} trimmed", "bbduk", "success")
            await log("")

        await ssh_exec(client, f"cat > \"{preproc}/logs/bbduk.log\" << 'METAQC_EOF'\n" + "\n".join(all_bbduk_logs) + "\nMETAQC_EOF")
        ver_clean = bbduk_ver.split()[-1] if bbduk_ver else "unknown"
        await ssh_exec(client, f'cp "{preproc}/scripts/run_bbduk.sh" "{preproc}/scripts/run_bbduk_v{ver_clean}.sh" 2>/dev/null')
        await log("")
        await log(f"✓ All {len(r1_files)} samples trimmed", "bbduk", "success")
        await log(f"✓ Script archived: run_bbduk_v{ver_clean}.sh", "bbduk", "success")
        await set_status("bbduk", "success")

        # ════════ POST-TRIM FASTQC ════════
        await asyncio.sleep(0.5)
        await set_status("post_fastqc", "running")

        await log(f">>> Running FastQC on trimmed reads ({req.fastqc_threads} threads)...", "post_fastqc")
        run = wrap_cmd(activate, f'{fqc_cmd} --threads {req.fastqc_threads} --outdir "{preproc}/output/fastqc_reports" "{preproc}/output/trimmed_reads"/*.fastq.gz 2>&1')
        await log(f"$ {fqc_cmd} --threads {req.fastqc_threads} --outdir .../output/fastqc_reports/ .../output/trimmed_reads/*.fastq.gz", "post_fastqc")

        ch = await loop.run_in_executor(None, client.get_transport().open_session)
        await loop.run_in_executor(None, ch.exec_command, run)
        exit_code, log_lines = await stream_channel_async(ch, websocket, "post_fastqc")
        await loop.run_in_executor(None, ch.close)

        await ssh_exec(client, f"cat > \"{preproc}/logs/post_trim_fastqc.log\" << 'METAQC_EOF'\n" + "\n".join(log_lines) + "\nMETAQC_EOF")
        if exit_code != 0:
            await log(f"✗ Post-trim FastQC failed (exit {exit_code})", "post_fastqc", "error")
            await set_status("post_fastqc", "error")
            return
        await log("✓ Post-trim FastQC complete", "post_fastqc", "success")
        await set_status("post_fastqc", "success")

        # ════════ POST-TRIM MULTIQC ════════
        await asyncio.sleep(0.3)
        await set_status("post_multiqc", "running")

        ptmqc_name = req.post_trim_multiqc_name
        await log(">>> Running MultiQC on post-trim FastQC reports...", "post_multiqc")
        run = wrap_cmd(activate, f'{mqc_cmd} "{preproc}/output/fastqc_reports" --outdir "{preproc}/output/multiqc_report" --filename "{ptmqc_name}" --force 2>&1')
        await log(f"$ {mqc_cmd} .../output/fastqc_reports/ --outdir .../output/multiqc_report/ --filename {ptmqc_name} --force", "post_multiqc")

        ch = await loop.run_in_executor(None, client.get_transport().open_session)
        await loop.run_in_executor(None, ch.exec_command, run)
        exit_code, log_lines = await stream_channel_async(ch, websocket, "post_multiqc")
        await loop.run_in_executor(None, ch.close)

        await ssh_exec(client, f"cat > \"{preproc}/logs/post_trim_multiqc.log\" << 'METAQC_EOF'\n" + "\n".join(log_lines) + "\nMETAQC_EOF")
        if exit_code != 0:
            await log(f"✗ Post-trim MultiQC failed (exit {exit_code})", "post_multiqc", "error")
            await set_status("post_multiqc", "error")
            return
        await log("✓ Post-trim MultiQC complete", "post_multiqc", "success")
        await log(f"✓ Report: {preproc}/output/multiqc_report/{ptmqc_name}.html", "post_multiqc", "success")
        await log("")
        await log("SUCCESS Preprocessing complete! BBDuk → FastQC → MultiQC", "post_multiqc", "success")
        await set_status("post_multiqc", "success")

    except WebSocketDisconnect:
        logger.info("WS disconnected (preprocessing)")
    except Exception as e:
        logger.error(f"Preprocessing error: {e}", exc_info=True)
        try:
            await websocket.send_json({"type": "log", "stage": "bbduk", "message": f"ERROR {e}", "level": "error"})
            await websocket.send_json({"type": "status", "stage": "bbduk", "status": "error"})
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


# Script Generators

def generate_fastqc_script(req, activate, fqc_cmd, qc, raw, version):
    act_line = f"\n# Activate environment\n{activate}\n" if activate else ""
    return f"""#!/usr/bin/env bash
# FastQC Script - Generated by MetaQC Pipeline
# Version: {version} | Method: {req.tool_method}
set -euo pipefail
{act_line}
RAW="{raw}"
QC="{qc}"

mkdir -p "$QC"/{{input,output/fastqc_reports,output/multiqc_report,logs,scripts}}
for f in "$RAW"/*.fastq.gz; do [ -e "$f" ] && ln -sf "$f" "$QC/input/$(basename "$f")"; done

{fqc_cmd} --threads {req.fastqc_threads} --outdir "$QC/output/fastqc_reports" "$QC/input"/*.fastq.gz 2>&1 | tee "$QC/logs/fastqc.log"
"""


def generate_multiqc_script(req, activate, mqc_cmd, qc, version):
    act_line = f"\n# Activate environment\n{activate}\n" if activate else ""
    return f"""#!/usr/bin/env bash
# MultiQC Script - Generated by MetaQC Pipeline
# Version: {version} | Method: {req.tool_method}
set -euo pipefail
{act_line}
QC="{qc}"

{mqc_cmd} "$QC/output/fastqc_reports" --outdir "$QC/output/multiqc_report" --filename "{req.multiqc_name}" --force 2>&1 | tee "$QC/logs/multiqc.log"
"""


def generate_bbduk_script(req, bbduk_sh, adapter_ref, preproc, raw, version):
    suffix = req.trimmed_suffix
    return f"""#!/usr/bin/env bash
# BBDuk Read Preprocessing Script - Generated by MetaQC Pipeline
# Version: {version}
# Suffix: {suffix}
# Parameters: ktrim={req.bbduk_ktrim} k={req.bbduk_k} mink={req.bbduk_mink} hdist={req.bbduk_hdist} qtrim={req.bbduk_qtrim} trimq={req.bbduk_trimq} minlen={req.bbduk_minlen} threads={req.bbduk_threads}
set -euo pipefail

BBDUK="{bbduk_sh}"
REF="{adapter_ref}"
RAW="{raw}"
PREPROC="{preproc}"
SUFFIX="{suffix}"

mkdir -p "$PREPROC"/{{input,output/trimmed_reads,output/fastqc_reports,output/multiqc_report,logs,scripts}}

# Symlink raw data
for f in "$RAW"/*.fastq.gz; do
  [ -e "$f" ] && ln -sf "$f" "$PREPROC/input/$(basename "$f")"
done

# Process each R1/R2 pair
for R1 in "$PREPROC/input/"*_R1*.fastq.gz "$PREPROC/input/"*_1.fastq.gz; do
  [ -e "$R1" ] || continue
  BASENAME=$(basename "$R1")

  if [[ "$BASENAME" == *"_R1_"* ]]; then
    R2=$(echo "$R1" | sed 's/_R1_/_R2_/')
    OUT1=$(echo "$BASENAME" | sed "s/.fastq.gz/${{SUFFIX}}.fastq.gz/")
    OUT2=$(echo "$OUT1" | sed 's/_R1_/_R2_/')
  elif [[ "$BASENAME" == *"_R1."* ]]; then
    R2=$(echo "$R1" | sed 's/_R1\\./_R2./')
    OUT1=$(echo "$BASENAME" | sed "s/_R1\\./_R1${{SUFFIX}}./")
    OUT2=$(echo "$OUT1" | sed "s/_R1${{SUFFIX}}/_R2${{SUFFIX}}/")
  elif [[ "$BASENAME" == *"_1.fastq"* ]]; then
    R2=$(echo "$R1" | sed 's/_1\\.fastq/_2.fastq/')
    OUT1=$(echo "$BASENAME" | sed "s/_1\\.fastq/_1${{SUFFIX}}.fastq/")
    OUT2=$(echo "$OUT1" | sed "s/_1${{SUFFIX}}/_2${{SUFFIX}}/")
  else
    continue
  fi

  echo "Processing: $BASENAME -> $OUT1, $OUT2"
  bash "$BBDUK" \\
    in1="$R1" in2="$R2" \\
    out1="$PREPROC/output/trimmed_reads/$OUT1" out2="$PREPROC/output/trimmed_reads/$OUT2" \\
    ref="$REF" \\
    ktrim={req.bbduk_ktrim} k={req.bbduk_k} mink={req.bbduk_mink} hdist={req.bbduk_hdist} \\
    qtrim={req.bbduk_qtrim} trimq={req.bbduk_trimq} minlen={req.bbduk_minlen} \\
    threads={req.bbduk_threads} tpe tbo \\
    2>&1 | tee -a "$PREPROC/logs/bbduk.log"
done

echo "BBDuk preprocessing complete"
"""


# ─── Decontamination (BBSplit) ────────────────────────────────────────────────

class RunDecontamPayload(BaseModel):
    session_id: str
    raw_data_path: str
    fastqc_threads: int = 8
    tool_method: str = "conda"
    conda_env_name: str = ""
    pixi_project_path: str = ""
    conda_use_mamba: bool = False
    bbmap_dir: str = ""
    genomes: list = []          # [{"name":"human","path":"resources/...","enabled":true}]
    custom_genomes: list = []   # [{"name":"custom1","path":"/abs/path"}]
    minid: int = 93
    bbsplit_threads: int = 4
    keep_contaminant_reads: bool = False
    decontam_suffix: str = "_decontam"
    decontam_multiqc_name: str = "decontam_multiqc_report"
    trimmed_suffix: str = "_trimmed"


@app.websocket("/ws/run-decontamination")
async def ws_run_decontamination(websocket: WebSocket):
    await websocket.accept()
    try:
        data = await websocket.receive_json()
        req = RunDecontamPayload(**data)
        client = get_client(req.session_id)
        activate, fqc_cmd, mqc_cmd = build_activate(req)

        async def log(msg, stage="bbsplit", lvl="info"):
            await websocket.send_json({"type": "log", "stage": stage, "message": msg, "level": lvl})

        async def set_status(stage, s):
            await websocket.send_json({"type": "status", "stage": stage, "status": s})

        raw = req.raw_data_path.rstrip("/")
        parent = os.path.dirname(raw)
        bbmap_dir = req.bbmap_dir.rstrip("/")
        bbsplit_sh = f"{bbmap_dir}/bbsplit.sh"
        trimming_output = f"{parent}/analyses/2_reads_preprocessing/1_adapter_trimming_and_filtering/output/trimmed_reads"
        decontam_dir = f"{parent}/analyses/2_reads_preprocessing/2_decontamination"
        loop = asyncio.get_event_loop()

        db_save_many({"decontam_suffix": req.decontam_suffix, "decontam_multiqc_name": req.decontam_multiqc_name})

        # ════════ BBSPLIT ════════
        await set_status("bbsplit", "running")

        await log(">>> Creating directory structure...")
        dirs = f'"{decontam_dir}/input" "{decontam_dir}/output/clean_reads" "{decontam_dir}/output/fastqc_reports" "{decontam_dir}/output/multiqc_report" "{decontam_dir}/logs" "{decontam_dir}/scripts"'
        if req.keep_contaminant_reads:
            dirs += f' "{decontam_dir}/output/contaminant_reads"'
        mk = f"mkdir -p {dirs}"
        await log(f"$ {mk}")
        _, err, code = await ssh_exec(client, mk)
        if code != 0:
            await log(f"✗ {err.strip()}", "bbsplit", "error")
            await set_status("bbsplit", "error"); return
        await log("✓ Directories created", "bbsplit", "success")
        await log("")

        await log(">>> Symlinking trimmed reads...")
        sym = f'for f in "{trimming_output}"/*.fastq.gz; do [ -e "$f" ] && ln -sf "$f" "{decontam_dir}/input/$(basename "$f")"; done'
        await ssh_exec(client, sym)
        ls_out, _, _ = await ssh_exec(client, f'ls -1 "{decontam_dir}/input/"*.fastq.gz 2>/dev/null')
        linked = [os.path.basename(f.strip()) for f in ls_out.strip().split("\n") if f.strip()]
        for f in linked:
            await log(f"  → {f}")
        await log(f"✓ {len(linked)} files symlinked", "bbsplit", "success")
        await log("")

        await log(">>> Verifying bbsplit.sh...")
        out, _, code = await ssh_exec(client, f'test -f "{bbsplit_sh}" && echo "FOUND" || echo "MISSING"')
        if "MISSING" in out:
            await log("✗ bbsplit.sh not found", "bbsplit", "error")
            await set_status("bbsplit", "error"); return
        await log("✓ bbsplit.sh found", "bbsplit", "success")
        await log("")

        enabled_genomes = [g for g in req.genomes if g.get("enabled", True)]
        all_genomes = enabled_genomes + req.custom_genomes
        if not all_genomes:
            await log("✗ No contaminant genomes selected", "bbsplit", "error")
            await set_status("bbsplit", "error"); return

        await log(f">>> Verifying {len(all_genomes)} genome references...")
        ref_parts = []
        for g in all_genomes:
            gpath = g["path"]
            if not gpath.startswith("/"):
                gpath = f"{bbmap_dir}/{gpath}"
            out, _, _ = await ssh_exec(client, f'test -f "{gpath}" && echo "FOUND" || echo "MISSING"')
            if "MISSING" in out:
                await log(f"  ✗ {g['name']}: NOT FOUND at {gpath}", "bbsplit", "error")
                await set_status("bbsplit", "error"); return
            await log(f"  ✓ {g['name']}: {gpath}")
            ref_parts.append(f"ref_{g['name']}={gpath}")
        ref_string = " ".join(ref_parts)
        await log("")

        await log(">>> Recording BBSplit version...")
        v_out, _, _ = await ssh_exec(client, f'bash "{bbsplit_sh}" --version 2>&1 | head -1', timeout=30)
        bbsplit_ver = v_out.strip()
        await log(f"  {bbsplit_ver}")
        await ssh_exec(client, f'echo "BBSplit: {bbsplit_ver}" > "{decontam_dir}/logs/software_versions.txt"')
        await log("")

        ls_out, _, _ = await ssh_exec(client, f'ls -1 "{decontam_dir}/input/"*_R1*.fastq.gz 2>/dev/null || ls -1 "{decontam_dir}/input/"*_1*.fastq.gz 2>/dev/null')
        r1_files = [os.path.basename(f.strip()) for f in ls_out.strip().split("\n") if f.strip()]
        if not r1_files:
            await log("✗ No R1 files found", "bbsplit", "error")
            await set_status("bbsplit", "error"); return

        await log(f">>> Decontaminating {len(r1_files)} samples...")
        await log(f"  Genomes: {', '.join(g['name'] for g in all_genomes)}")
        await log(f"  minid={req.minid}, threads={req.bbsplit_threads}, pairedonly=t")
        await log("")

        decontam_script = generate_bbsplit_script(req, bbsplit_sh, ref_string, all_genomes, decontam_dir, trimming_output, bbsplit_ver)
        await ssh_exec(client, f"cat > \"{decontam_dir}/scripts/run_bbsplit.sh\" << 'METAQC_EOF'\n{decontam_script}\nMETAQC_EOF")
        await ssh_exec(client, f'chmod +x "{decontam_dir}/scripts/run_bbsplit.sh"')

        dsuffix = req.decontam_suffix
        tsuffix = req.trimmed_suffix
        all_logs = []
        for r1 in r1_files:
            if "_R1_" in r1:
                r2 = r1.replace("_R1_", "_R2_")
            elif "_R1." in r1:
                r2 = r1.replace("_R1.", "_R2.")
            elif f"_1{tsuffix}" in r1:
                r2 = r1.replace(f"_1{tsuffix}", f"_2{tsuffix}")
            else:
                await log(f"  ⚠ Can\'t determine R2 for {r1}, skipping")
                continue

            base = r1.replace(".fastq.gz", "")
            out1 = f"{base}{dsuffix}_R1.fastq.gz"
            out2 = out1.replace(f"{dsuffix}_R1", f"{dsuffix}_R2")
            sample = r1.split("_R1")[0].split(f"_1{tsuffix}")[0]

            await log(f"  >>> Processing: {sample}")

            cmd_parts = [
                f'bash "{bbsplit_sh}"',
                f'in1="{decontam_dir}/input/{r1}" in2="{decontam_dir}/input/{r2}"',
                f'basename="{decontam_dir}/output/contaminant_reads/{sample}_%.fastq.gz"' if req.keep_contaminant_reads else "",
                f'outu1="{decontam_dir}/output/clean_reads/{out1}" outu2="{decontam_dir}/output/clean_reads/{out2}"',
                ref_string,
                f"minid={req.minid / 100:.2f}",
                f"threads={req.bbsplit_threads}",
                "pairedonly=t",
                "2>&1",
            ]
            cmd = " ".join(p for p in cmd_parts if p)
            await log(f"  $ bbsplit.sh in1={r1} in2={r2} outu1={out1} outu2={out2} ... minid=0.{req.minid}")

            ch = await loop.run_in_executor(None, client.get_transport().open_session)
            ch.settimeout(3600)
            await loop.run_in_executor(None, ch.exec_command, cmd)
            exit_code, lines = await stream_channel_async(ch, websocket, "bbsplit")
            await loop.run_in_executor(None, ch.close)
            all_logs.extend(lines)

            if exit_code != 0:
                await log(f"  ✗ BBSplit failed for {sample} (exit {exit_code})", "bbsplit", "error")
                await set_status("bbsplit", "error"); return
            await log(f"  ✓ {sample} decontaminated", "bbsplit", "success")
            await log("")

        log_text = "\n".join(all_logs)
        await ssh_exec(client, f"cat > \"{decontam_dir}/logs/bbsplit.log\" << 'METAQC_EOF'\n{log_text}\nMETAQC_EOF")
        ver_clean = bbsplit_ver.split()[-1] if bbsplit_ver else "unknown"
        await ssh_exec(client, f'cp "{decontam_dir}/scripts/run_bbsplit.sh" "{decontam_dir}/scripts/run_bbsplit_v{ver_clean}.sh" 2>/dev/null')
        await log(f"✓ All {len(r1_files)} samples decontaminated", "bbsplit", "success")
        if req.keep_contaminant_reads:
            await log(f"✓ Contaminant reads saved", "bbsplit")
        await log(f"✓ Script archived: run_bbsplit_v{ver_clean}.sh", "bbsplit", "success")
        await set_status("bbsplit", "success")

        # ════════ POST-DECONTAM FASTQC ════════
        await asyncio.sleep(0.5)
        await set_status("decontam_fastqc", "running")

        await log(f">>> Running FastQC on decontaminated reads ({req.fastqc_threads} threads)...", "decontam_fastqc")
        run = wrap_cmd(activate, f'{fqc_cmd} --threads {req.fastqc_threads} --outdir "{decontam_dir}/output/fastqc_reports" "{decontam_dir}/output/clean_reads"/*.fastq.gz 2>&1')
        await log(f"$ {fqc_cmd} --threads {req.fastqc_threads} --outdir .../fastqc_reports/ .../clean_reads/*.fastq.gz", "decontam_fastqc")

        ch = await loop.run_in_executor(None, client.get_transport().open_session)
        await loop.run_in_executor(None, ch.exec_command, run)
        exit_code, log_lines = await stream_channel_async(ch, websocket, "decontam_fastqc")
        await loop.run_in_executor(None, ch.close)

        fqc_log = "\n".join(log_lines)
        await ssh_exec(client, f"cat > \"{decontam_dir}/logs/post_decontam_fastqc.log\" << 'METAQC_EOF'\n{fqc_log}\nMETAQC_EOF")
        if exit_code != 0:
            await log(f"✗ FastQC failed (exit {exit_code})", "decontam_fastqc", "error")
            await set_status("decontam_fastqc", "error"); return
        await log("✓ Post-decontam FastQC complete", "decontam_fastqc", "success")
        await set_status("decontam_fastqc", "success")

        # ════════ POST-DECONTAM MULTIQC ════════
        await asyncio.sleep(0.3)
        await set_status("decontam_multiqc", "running")

        dmqc_name = req.decontam_multiqc_name
        await log(">>> Running MultiQC on post-decontam reports...", "decontam_multiqc")
        run = wrap_cmd(activate, f'{mqc_cmd} "{decontam_dir}/output/fastqc_reports" --outdir "{decontam_dir}/output/multiqc_report" --filename "{dmqc_name}" --force 2>&1')
        await log(f"$ {mqc_cmd} ... --filename {dmqc_name} --force", "decontam_multiqc")

        ch = await loop.run_in_executor(None, client.get_transport().open_session)
        await loop.run_in_executor(None, ch.exec_command, run)
        exit_code, log_lines = await stream_channel_async(ch, websocket, "decontam_multiqc")
        await loop.run_in_executor(None, ch.close)

        mqc_log = "\n".join(log_lines)
        await ssh_exec(client, f"cat > \"{decontam_dir}/logs/post_decontam_multiqc.log\" << 'METAQC_EOF'\n{mqc_log}\nMETAQC_EOF")
        if exit_code != 0:
            await log(f"✗ MultiQC failed (exit {exit_code})", "decontam_multiqc", "error")
            await set_status("decontam_multiqc", "error"); return
        await log("✓ Post-decontam MultiQC complete", "decontam_multiqc", "success")
        await log(f"✓ Report: {decontam_dir}/output/multiqc_report/{dmqc_name}.html", "decontam_multiqc", "success")
        await log("")
        await log("SUCCESS Decontamination complete!", "decontam_multiqc", "success")
        await set_status("decontam_multiqc", "success")

    except WebSocketDisconnect:
        logger.info("WS disconnected (decontamination)")
    except Exception as e:
        logger.error(f"Decontamination error: {e}", exc_info=True)
        try:
            await websocket.send_json({"type": "log", "stage": "bbsplit", "message": f"ERROR {e}", "level": "error"})
            await websocket.send_json({"type": "status", "stage": "bbsplit", "status": "error"})
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


def generate_bbsplit_script(req, bbsplit_sh, ref_string, genomes, decontam_dir, trimming_output, version):
    dsuffix = req.decontam_suffix
    keep_contam = "true" if req.keep_contaminant_reads else "false"
    genome_list = ", ".join(g["name"] for g in genomes)
    script = f"""#!/usr/bin/env bash
# BBSplit Contaminant Removal Script - Generated by MetaQC Pipeline
# Version: {version}
# Genomes: {genome_list}
# Parameters: minid={req.minid}, threads={req.bbsplit_threads}, pairedonly=t
set -euo pipefail

BBSPLIT="{bbsplit_sh}"
TRIMMED="{trimming_output}"
DECONTAM="{decontam_dir}"
KEEP_CONTAM={keep_contam}
DSUFFIX="{dsuffix}"
"""
    script += """
mkdir -p "$DECONTAM"/{input,output/clean_reads,output/fastqc_reports,output/multiqc_report,logs,scripts}
[ "$KEEP_CONTAM" = "true" ] && mkdir -p "$DECONTAM/output/contaminant_reads"

for f in "$TRIMMED"/*.fastq.gz; do
  [ -e "$f" ] && ln -sf "$f" "$DECONTAM/input/$(basename "$f")"
done

for R1 in "$DECONTAM/input/"*_R1*.fastq.gz "$DECONTAM/input/"*_1*.fastq.gz; do
  [ -e "$R1" ] || continue
  BASENAME=$(basename "$R1")

  if [[ "$BASENAME" == *"_R1_"* ]]; then
    R2=$(echo "$R1" | sed 's/_R1_/_R2_/')
    BASE=$(echo "$BASENAME" | sed 's/.fastq.gz//')
    OUT1="${BASE}${DSUFFIX}_R1.fastq.gz"
    OUT2=$(echo "$OUT1" | sed "s/${DSUFFIX}_R1/${DSUFFIX}_R2/")
  elif [[ "$BASENAME" == *"_R1."* ]]; then
    R2=$(echo "$R1" | sed 's/_R1\\./_R2./')
    BASE=$(echo "$BASENAME" | sed 's/.fastq.gz//')
    OUT1="${BASE}${DSUFFIX}_R1.fastq.gz"
    OUT2=$(echo "$OUT1" | sed "s/${DSUFFIX}_R1/${DSUFFIX}_R2/")
  else
    continue
  fi

  SAMPLE=$(echo "$BASENAME" | sed 's/_R1.*//')
  echo "Processing: $BASENAME -> $OUT1, $OUT2"

  CONTAM_ARG=""
  [ "$KEEP_CONTAM" = "true" ] && CONTAM_ARG="basename=$DECONTAM/output/contaminant_reads/${SAMPLE}_%.fastq.gz"

  bash "$BBSPLIT" \\
    in1="$R1" in2="$R2" \\
    outu1="$DECONTAM/output/clean_reads/$OUT1" outu2="$DECONTAM/output/clean_reads/$OUT2" \\
    $CONTAM_ARG \\
"""
    script += f"    {ref_string} \\\\\n"
    script += f"    minid={req.minid / 100:.2f} \\\\\n"
    script += f"    threads={req.bbsplit_threads} \\\\\n"
    script += """    pairedonly=t \\
    2>&1 | tee -a "$DECONTAM/logs/bbsplit.log"
done

echo "BBSplit decontamination complete"
"""
    return script
