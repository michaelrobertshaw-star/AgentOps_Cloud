/**
 * Shared configuration for AgentOps load tests.
 * Override BASE_URL via K6_BASE_URL env var for different environments.
 */

export const BASE_URL = __ENV.K6_BASE_URL || "http://localhost:4000";

export const THRESHOLDS = {
  // p99 < 200ms at 100 RPS for API endpoints
  http_req_duration: ["p(99)<200"],
  // File upload allowed up to 500ms
  "http_req_duration{type:upload}": ["p(99)<500"],
  // No more than 1% errors
  http_req_failed: ["rate<0.01"],
};

export const DEFAULT_OPTIONS = {
  thresholds: THRESHOLDS,
  summaryTrendStats: ["min", "med", "avg", "p(90)", "p(95)", "p(99)", "max"],
};

/**
 * Shared test user credentials.
 * These must exist in the target environment before running load tests.
 * Use the seed script (load-tests/seed.sh) to set them up.
 */
export const TEST_USER = {
  email: __ENV.K6_TEST_EMAIL || "loadtest@agentops.example.com",
  password: __ENV.K6_TEST_PASSWORD || "LoadTestPassword123!",
};

export const TEST_COMPANY_NAME = __ENV.K6_TEST_COMPANY || "loadtest-co";
