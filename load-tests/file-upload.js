/**
 * Load Test: Workspace File Upload (10MB)
 * Covers: POST /api/workspaces/:id/files, GET /api/workspaces/:id/files/:fileId
 *
 * Target: p99 < 500ms for file upload
 *
 * Run: k6 run load-tests/file-upload.js
 * Requires: K6_WORKSPACE_ID env var, K6_ACCESS_TOKEN env var
 *           (or let setup() create them via TEST_USER credentials)
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Counter } from "k6/metrics";
import encoding from "k6/encoding";
import { BASE_URL, DEFAULT_OPTIONS, TEST_USER } from "./config.js";

const uploadDuration = new Trend("file_upload_duration", true);
const downloadDuration = new Trend("file_download_duration", true);
const uploadErrors = new Counter("upload_errors");

export const options = {
  ...DEFAULT_OPTIONS,
  thresholds: {
    // Override threshold for upload: p99 < 500ms
    "http_req_duration{type:upload}": ["p(99)<500"],
    "http_req_duration{type:download}": ["p(99)<200"],
    http_req_failed: ["rate<0.01"],
  },
  scenarios: {
    file_upload: {
      executor: "constant-arrival-rate",
      // Lower rate for uploads (they're heavier)
      rate: 10,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 20,
      maxVUs: 50,
    },
  },
};

// Generate a 10MB buffer filled with random-ish data
function make10MbPayload() {
  // k6 doesn't have Buffer — use ArrayBuffer via encoding
  // Build 10MB as a string of repeated pattern, then encode
  const chunk = "AgentOps-load-test-payload-chunk-";
  const repeats = Math.ceil((10 * 1024 * 1024) / chunk.length);
  return chunk.repeat(repeats).slice(0, 10 * 1024 * 1024);
}

export function setup() {
  // Login to get access token and workspace ID
  const loginRes = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email: TEST_USER.email, password: TEST_USER.password }),
    { headers: { "Content-Type": "application/json" } },
  );

  if (loginRes.status !== 200) {
    throw new Error(`Setup login failed: ${loginRes.status} ${loginRes.body}`);
  }

  const { accessToken } = JSON.parse(loginRes.body);

  // Use env-provided workspace, or fail with a clear message
  const workspaceId = __ENV.K6_WORKSPACE_ID;
  if (!workspaceId) {
    throw new Error(
      "K6_WORKSPACE_ID not set. Create a test workspace and set this env var before running.",
    );
  }

  return { accessToken, workspaceId };
}

export default function ({ accessToken, workspaceId }) {
  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
  };

  // Upload a 10MB test file
  const payload = make10MbPayload();
  const filename = `loadtest-${Date.now()}-${__VU}.txt`;

  const uploadRes = http.post(
    `${BASE_URL}/api/workspaces/${workspaceId}/files`,
    {
      file: http.file(payload, filename, "text/plain"),
    },
    { headers: authHeaders, tags: { type: "upload" } },
  );

  uploadDuration.add(uploadRes.timings.duration);

  const uploadOk = check(uploadRes, {
    "upload status 201": (r) => r.status === 201,
    "upload returns file id": (r) => {
      try {
        return JSON.parse(r.body).id !== undefined;
      } catch {
        return false;
      }
    },
    "upload p99 < 500ms": (r) => r.timings.duration < 500,
  });

  if (!uploadOk) {
    uploadErrors.add(1);
    return;
  }

  const { id: fileId } = JSON.parse(uploadRes.body);

  sleep(0.2);

  // Download to verify round-trip
  const downloadRes = http.get(
    `${BASE_URL}/api/workspaces/${workspaceId}/files/${fileId}`,
    { headers: authHeaders, tags: { type: "download" } },
  );

  downloadDuration.add(downloadRes.timings.duration);

  check(downloadRes, {
    "download status 200": (r) => r.status === 200,
  });
}
