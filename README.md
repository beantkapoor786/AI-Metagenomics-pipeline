# MetaQC Pipeline

A web-based GUI for metagenomics quality control workflows on HPC clusters.  
Connects via SSH, runs FastQC + MultiQC, and streams logs in real-time.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│   Browser        │────▶│  Frontend (React) │────▶│  Nginx      │
│   localhost:3000 │     │  Port 3000        │     │  Proxy      │
└─────────────────┘     └──────────────────┘     └──────┬──────┘
                                                         │
                                              /api/* ──▶ │ ◀── /ws/*
                                                         │
                                                  ┌──────▼──────┐
                                                  │  Backend     │
                                                  │  FastAPI     │──── SSH ────▶ HPC
                                                  │  Port 8000   │   (paramiko)
                                                  └─────────────┘
```

- **Frontend**: React app served by Nginx, proxies `/api/*` and `/ws/*` to backend
- **Backend**: FastAPI + paramiko for SSH, WebSocket for real-time log streaming
- **HPC**: Your cluster, accessed via direct SSH connection

## Quick Start

### Prerequisites
- Docker & Docker Compose installed
- Network access to your HPC cluster from the machine running Docker

### 1. Clone / copy the project

```bash
cd metaqc-pipeline
```

### 2. Build and start

```bash
docker compose up --build
```

### 3. Open the GUI

Navigate to **http://localhost:3000**

### 4. Connect to your HPC

Enter your HPC hostname, port (default 22), username, and password or SSH key path.

## SSH Key Authentication

If using SSH keys, uncomment the volume mount in `docker-compose.yml`:

```yaml
volumes:
  - ~/.ssh:/root/.ssh:ro
```

Then provide the key path as `/root/.ssh/id_rsa` (or your key filename) in the GUI.

## Development (without Docker)

### Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### Frontend

```bash
cd frontend
npm install
REACT_APP_API_URL=http://localhost:8000 npm start
```

The frontend dev server runs on port 3000 with `REACT_APP_API_URL` pointing to the backend.

## API Endpoints

### REST

| Method | Endpoint             | Description                          |
|--------|----------------------|--------------------------------------|
| GET    | `/api/health`        | Health check                         |
| POST   | `/api/ssh/connect`   | Establish SSH connection             |
| POST   | `/api/ssh/disconnect`| Close SSH session                    |
| POST   | `/api/scan-directory`| List .fastq.gz files via SSH         |

### WebSocket

| Endpoint             | Description                              |
|----------------------|------------------------------------------|
| `/ws/install-tools`  | Install/verify FastQC & MultiQC          |
| `/ws/run-pipeline`   | Run full QC pipeline with live streaming |

## Pipeline Output Structure

```
project/
├── raw_data/                    ← your FASTQ files (untouched)
├── analyses/
│   └── 1_QC/
│       ├── input/               ← symlinks to raw_data
│       ├── output/
│       │   ├── fastqc_reports/  ← FastQC HTML + ZIP per sample
│       │   └── multiqc_report/  ← MultiQC aggregated report
│       ├── logs/                ← fastqc.log, multiqc.log, software_versions.txt
│       └── scripts/             ← Versioned bash scripts for reproducibility
```

## Supported Tool Managers

- **Conda / Mamba**: Creates or uses existing environments
- **Pixi**: Initializes or uses existing pixi projects
- **System PATH**: Verifies tools are already accessible

## Security Notes

- SSH credentials are held in-memory only (never persisted to disk)
- Session IDs are random UUIDs
- Directory paths are validated against injection characters
- In production, restrict CORS origins in `backend/main.py`
