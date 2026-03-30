/**
 * Load Test: Agent Checkin + Task Assignment Loop
 * Covers: POST /api/agent/checkin, POST /api/agent/heartbeat, GET /api/tasks
 *
 * Target: p99 < 200ms at 100 RPS
 *
 * Run: k6 run load-tests/agent-checkin.js
 * Requires: K6_AGENT_KEY env var (ak_<hex> format)
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Counter } from "k6/metrics";
import { BASE_URL, DEFAULT_OPTIONS } from "./config.js";

const checkinDuration = new Trend("checkin_duration", true);
const heartbeatDuration = new Trend("heartbeat_duration", true);
const taskPollDuration = new Trend("task_poll_duration", true);
const checkinErrors = new Counter("checkin_errors");

export const options = {
  ...DEFAULT_OPTIONS,
  scenarios: {
    agent_checkin: {
      executor: "constant-arrival-rate",
      rate: 100,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 50,
      maxVUs: 150,
    },
  },
};

export default function () {
  const agentKey = __ENV.K6_AGENT_KEY;
  if (!agentKey) {
    checkinErrors.add(1);
    console.error("K6_AGENT_KEY not set — skipping agent checkin iteration");
    return;
  }

  const checkinHeaders = {
    "Content-Type": "application/json",
    "X-Agent-Key": agentKey,
  };

  // Step 1: Agent checkin (exchange API key for run token)
  const checkinRes = http.post(
    `${BASE_URL}/api/agent/checkin`,
    null,
    { headers: checkinHeaders, tags: { type: "checkin" } },
  );

  checkinDuration.add(checkinRes.timings.duration);

  const checkinOk = check(checkinRes, {
    "checkin status 200": (r) => r.status === 200,
    "checkin returns runToken": (r) => JSON.parse(r.body).runToken !== undefined,
    "checkin returns agent info": (r) => JSON.parse(r.body).agent !== undefined,
  });

  if (!checkinOk) {
    checkinErrors.add(1);
    return;
  }

  const { runToken } = JSON.parse(checkinRes.body);
  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${runToken}`,
  };

  sleep(0.1);

  // Step 2: Send heartbeat
  const heartbeatRes = http.post(
    `${BASE_URL}/api/agent/heartbeat`,
    JSON.stringify({}),
    { headers: authHeaders, tags: { type: "heartbeat" } },
  );

  heartbeatDuration.add(heartbeatRes.timings.duration);

  check(heartbeatRes, {
    "heartbeat status 200": (r) => r.status === 200,
    "heartbeat ok=true": (r) => JSON.parse(r.body).ok === true,
  });

  sleep(0.1);

  // Step 3: Poll for assigned tasks (simulates agent task loop)
  const taskRes = http.get(
    `${BASE_URL}/api/tasks?status=todo&limit=10`,
    { headers: authHeaders, tags: { type: "task_poll" } },
  );

  taskPollDuration.add(taskRes.timings.duration);

  check(taskRes, {
    "task poll status 200 or 403": (r) => r.status === 200 || r.status === 403,
  });
}
