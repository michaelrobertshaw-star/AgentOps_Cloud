# AgentOps Load Tests

k6-based load tests for the AgentOps API server.

## Prerequisites

- [k6](https://k6.io/docs/getting-started/installation/) installed
- Running AgentOps server (staging or local)
- Test credentials configured (see Setup below)

## Setup

1. Start the server (local):
   ```sh
   docker compose up -d
   pnpm --filter @agentops/db migrate
   pnpm --filter @agentops/server dev
   ```

2. Create a load test user (one-time):
   ```sh
   curl -s -X POST http://localhost:4000/api/auth/register \
     -H 'Content-Type: application/json' \
     -d '{"companyName":"loadtest-co","companyDisplayName":"LoadTest Co","email":"loadtest@agentops.example.com","name":"Load Test User","password":"LoadTestPassword123!"}'
   ```

3. For agent-checkin tests, create a test agent and export its API key as `K6_AGENT_KEY`.
4. For file-upload tests, create a department + workspace and export the workspace ID as `K6_WORKSPACE_ID`.

## Running Tests

```sh
# Auth flow (login, refresh, logout)
k6 run load-tests/auth-flow.js

# Agent checkin + heartbeat loop
K6_AGENT_KEY=ak_<hex> k6 run load-tests/agent-checkin.js

# File upload / download (10MB)
K6_WORKSPACE_ID=<uuid> k6 run load-tests/file-upload.js

# WebSocket connection + event throughput
k6 run load-tests/websocket.js

# Against staging
K6_BASE_URL=https://staging.agentops.example.com k6 run load-tests/auth-flow.js
```

## Thresholds

| Metric | Target |
|--------|--------|
| API p99 latency | < 200ms at 100 RPS |
| File upload p99 | < 500ms |
| Error rate | < 1% |
| WS connect p99 | < 200ms |

## Results

Results are written to `load-tests/results/YYYY-MM-DD.md` after each test run.
See that file for baseline measurements and flagged regressions.
