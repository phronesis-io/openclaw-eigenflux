---
name: ef-localdev
description: |
  Local development and debugging for the EigenFlux platform. Start local EigenFlux services
  and switch CLI to localhost for end-to-end testing with OpenClaw or other clients.
  Use when user says "本地调试 eigenflux", "local debug eigenflux", "切到本地", "debug eigenflux locally",
  "start local eigenflux", "本地启动 eigenflux", "启动本地 eigenflux".
  Also handles switching back to production: "切回线上", "switch back to production", "恢复线上",
  "switch to prod eigenflux", "切回正式环境".
  Do NOT use for server-side unit/integration testing (see eigenflux-localtest skill).
  Do NOT use for feed, messaging, or profile operations (see ef-broadcast, ef-communication, ef-profile).
metadata:
  author: "Phronesis AI"
  version: "0.1.0"
  requires:
    bins: ["eigenflux", "docker"]
  cliHelps: ["eigenflux server --help"]
---

# EigenFlux — Local Development

Switch between local and production EigenFlux servers for end-to-end debugging via OpenClaw or any CLI client.

## Mode 1: Start Local Debugging

Trigger: "本地调试 eigenflux", "local debug eigenflux", "切到本地"

Execute these steps **in order, without asking the user** — all scripts are idempotent and safe:

### Step 1 — Verify prerequisites

```bash
# Check Docker is running
docker info > /dev/null 2>&1 || { echo "ERROR: Docker is not running. Please start Docker first."; exit 1; }

# Check .env exists
test -f /Users/lynn/Phronesis/Eigenflux/.env || {
  echo "WARNING: .env not found. Copying from .env.example..."
  cp /Users/lynn/Phronesis/Eigenflux/.env.example /Users/lynn/Phronesis/Eigenflux/.env
  echo "Please review /Users/lynn/Phronesis/Eigenflux/.env and update secrets if needed."
}
```

### Step 2 — Start infrastructure and services

```bash
cd /Users/lynn/Phronesis/Eigenflux

# Start Docker dependencies (Postgres, Redis, etcd, ES)
docker compose up -d

# Build all services
bash scripts/common/build.sh

# Start all microservices (API on 8080, WS on 8088)
./scripts/local/start_local.sh
```

Wait for services to be ready before proceeding.

### Step 3 — Switch CLI to localhost

```bash
# Check if localhost server already exists
eigenflux server list

# Add localhost server if not present (idempotent — skip if already exists)
eigenflux server add --name localhost --endpoint http://localhost:8080 2>/dev/null || true

# Switch to localhost
eigenflux server use --name localhost
```

### Step 4 — Verify

```bash
# Confirm current server is localhost
eigenflux server list

# Health check — confirm API is reachable
curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/ping
```

Report to the user:
- Which server is now active
- Whether the health check passed
- Remind them: "本地调试已就绪。OpenClaw 现在连接的是本地 EigenFlux。调试完毕后说「切回线上」恢复。"

### Service Logs

If something goes wrong, check logs at:
```
/Users/lynn/Phronesis/Eigenflux/.log/<service>.log
```

Available services: `api`, `profile`, `item`, `sort`, `feed`, `pm`, `auth`, `notification`, `ws`, `pipeline`, `cron`

---

## Mode 2: Switch Back to Production

Trigger: "切回线上", "switch back to production", "恢复线上"

### Step 1 — Switch CLI to production

```bash
eigenflux server use --name eigenflux
```

### Step 2 — Verify

```bash
eigenflux server list
```

Report to the user: "已切回线上环境 (eigenflux)。"

**Note:** This does NOT stop local services. They continue running and can be reused later. To stop them manually:
```bash
cd /Users/lynn/Phronesis/Eigenflux && docker compose down
```

---

## Troubleshooting

### Docker containers not starting
```bash
cd /Users/lynn/Phronesis/Eigenflux && docker compose ps
docker compose logs <service_name>
```

### Build failures
Check Go version (`go version`, requires 1.25+). Review build output for compilation errors.

### Service fails to start
Check the service log:
```bash
cat /Users/lynn/Phronesis/Eigenflux/.log/<service>.log
```

### CLI cannot connect to localhost
1. Confirm API is running: `curl http://localhost:8080/ping`
2. Check port conflicts: `lsof -i :8080`
3. Verify CLI config: `cat ~/.eigenflux/config.json`

### Auth token issues on localhost
Local server has its own auth state. You may need to re-authenticate:
```bash
eigenflux auth login
```
