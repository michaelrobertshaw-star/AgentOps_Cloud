/**
 * Load Test: Auth Flow
 * Covers: POST /api/auth/login, POST /api/auth/refresh, POST /api/auth/logout
 *
 * Target: p99 < 200ms at 100 RPS
 *
 * Run: k6 run load-tests/auth-flow.js
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Counter } from "k6/metrics";
import { BASE_URL, DEFAULT_OPTIONS, TEST_USER } from "./config.js";

const loginDuration = new Trend("login_duration", true);
const refreshDuration = new Trend("refresh_duration", true);
const loginErrors = new Counter("login_errors");

export const options = {
  ...DEFAULT_OPTIONS,
  scenarios: {
    auth_flow: {
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
  const headers = { "Content-Type": "application/json" };

  // Step 1: Login
  const loginRes = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email: TEST_USER.email, password: TEST_USER.password }),
    { headers, tags: { type: "auth" } },
  );

  loginDuration.add(loginRes.timings.duration);

  const loginOk = check(loginRes, {
    "login status 200": (r) => r.status === 200,
    "login returns accessToken": (r) => JSON.parse(r.body).accessToken !== undefined,
    "login returns refreshToken": (r) => JSON.parse(r.body).refreshToken !== undefined,
  });

  if (!loginOk) {
    loginErrors.add(1);
    return;
  }

  const { accessToken, refreshToken } = JSON.parse(loginRes.body);

  sleep(0.1);

  // Step 2: Token refresh
  const refreshRes = http.post(
    `${BASE_URL}/api/auth/refresh`,
    JSON.stringify({ refreshToken }),
    { headers, tags: { type: "auth" } },
  );

  refreshDuration.add(refreshRes.timings.duration);

  check(refreshRes, {
    "refresh status 200": (r) => r.status === 200,
    "refresh returns new accessToken": (r) => JSON.parse(r.body).accessToken !== undefined,
  });

  sleep(0.1);

  // Step 3: Logout
  const logoutRes = http.post(
    `${BASE_URL}/api/auth/logout`,
    JSON.stringify({ refreshToken }),
    {
      headers: {
        ...headers,
        Authorization: `Bearer ${accessToken}`,
      },
      tags: { type: "auth" },
    },
  );

  check(logoutRes, {
    "logout status 200": (r) => r.status === 200,
  });
}
