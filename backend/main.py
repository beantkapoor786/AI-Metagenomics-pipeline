"""
MetaQC Pipeline — FastAPI Backend
SSH via paramiko, real-time logs via WebSocket.
All blocking SSH calls run in thread pool to avoid blocking async loop.
"""

import asyncio
import functools
import json
import logging
import os
import uuid
from contextlib import asynccontextmanager
from typing import Optional

import paramiko
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("metaqc")

sessions: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
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


# WebSocket: Install Tools

@app.websocket("/ws/install-tools")
async def ws_install_tools(websocket: WebSocket):
    await websocket.accept()
    try:
        data = await websocket.receive_json()
        req = InstallToolsPayload(**data)
        client = get_client(req.session_id)

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
        await log("SUCCESS All QC analyses complete!", "multiqc", "success")
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
