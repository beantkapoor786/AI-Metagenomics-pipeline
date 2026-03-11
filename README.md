# Introduction

Ever been told to “just do a quality check” on a bunch of Illumina short reads? Sounds quick and simple—until you sit down to actually run it and suddenly you’re knee-deep in path errors, missing installations, and wondering what exactly you’re supposed to install. Conda? Pixi? Something else entirely?

If you’ve ever been there—and especially if you don’t have much command-line experience but still want to generate a clean, interactive quality report through a GUI—then you’re in the right place.

# What info do you need to have to run this GUI?

- Your HPC details (Hostname or IP address, username, password/SSH private key path.
- HPC should have one of these package managers installed - Conda, mamba, Pixi.
- If you use Conda, provide the conda environment name where softwares are installed. Same for mamba.
- If you use Pixi, provide Pixi package PATH.
- If you use one of these package managers, GUI will ask if you have softwares installed. If not, it will install them for you.
- If above mentioned package managers are not installed, softwares should have been manually installed and be in PATH.
- After setting up the softwares, you need to provide the absolute PATH to fastq files (PATH to the folder). Once you press "Scan Directory" button, it should show the exact names of the your fastq files. If names don't match, something is wrong with the PATH.
- HIGHLY RECOMMENDED - Please make a backup of the raw data before running it using GUI. You wouldn't want to trust AI pipeline with the only copy of the data. Even, we don't.
- Provide number of threads you want to use with FastQC command. Default is 8.
- Provide the name of the MultiQC report you want to use. Default is `multiqc_report`.
- Finally, you are at "Review & Run" step. This is the penultimate step before running quality check. Read all the details carefully. If everything looks good, proceed further. If not, you can always go back and change the parameters.
- To look for your output files, we provide the directory structure at the Review step and once the analyses is finised. It might look something like this.

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

If using SSH keys, provide the private key path as `/root/.ssh/id_rsa` (or your key filename) in the GUI.

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

 # Tasks

- [ ] what about 2FA?
- [x] Fix "Backend Connection" on by defualt on GUI
- [ ] add bbduk adapter trimming and quality filtering step
- [ ] add bbduk contaminant DNA removal step
- [ ] add bbduk error correction step
