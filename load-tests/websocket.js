/**
 * Load Test: WebSocket Connection + Event Throughput
 * Covers: WS /ws — connect, subscribe, receive events, disconnect
 *
 * Target: p99 < 200ms for connect + subscribe handshake
 *
 * Run: k6 run load-tests/websocket.js
 */

import ws from "k6/ws";
import { check, sleep } from "k6";
import http from "k6/http";
import { Trend, Counter, Rate } from "k6/metrics";
import { BASE_URL, DEFAULT_OPTIONS, TEST_USER } from "./config.js";

const connectDuration = new Trend("ws_connect_duration", true);
const eventReceiveRate = new Rate("ws_event_received");
const wsErrors = new Counter("ws_errors");

// Derive WS URL from BASE_URL
const WS_BASE = BASE_URL.replace(/^http/, "ws");

export const options = {
  ...DEFAULT_OPTIONS,
  scenarios: {
    websocket: {
      executor: "constant-vus",
      vus: 50,
      duration: "30s",
    },
  },
  thresholds: {
    ws_connect_duration: ["p(99)<200"],
    ws_errors: ["count<10"],
    http_req_failed: ["rate<0.01"],
  },
};

export function setup() {
  const loginRes = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email: TEST_USER.email, password: TEST_USER.password }),
    { headers: { "Content-Type": "application/json" } },
  );

  if (loginRes.status !== 200) {
    throw new Error(`Setup login failed: ${loginRes.status}`);
  }

  const { accessToken, user } = JSON.parse(loginRes.body);
  // Get companyId from the JWT (decode middle part)
  const payload = JSON.parse(atob(accessToken.split(".")[1]));
  return { accessToken, companyId: payload.company_id };
}

export default function ({ accessToken, companyId }) {
  const startTime = Date.now();

  const res = ws.connect(
    `${WS_BASE}/ws`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    function (socket) {
      connectDuration.add(Date.now() - startTime);

      socket.on("open", () => {
        check(socket, { "ws connected": () => true });
      });

      socket.on("message", (data) => {
        let msg;
        try {
          msg = JSON.parse(data);
        } catch {
          wsErrors.add(1);
          return;
        }

        if (msg.type === "welcome") {
          // Subscribe to company channel after welcome
          socket.send(
            JSON.stringify({ type: "subscribe", channel: `company:${companyId}` }),
          );
        } else if (msg.type === "subscribed") {
          check(msg, {
            "subscribed to company channel": (m) => m.channel === `company:${companyId}`,
          });
          eventReceiveRate.add(1);
        } else if (msg.type === "event") {
          eventReceiveRate.add(1);
        }
      });

      socket.on("error", (e) => {
        wsErrors.add(1);
      });

      // Hold connection open for a realistic duration
      sleep(2);

      socket.close();
    },
  );

  check(res, { "ws status 101": (r) => r && r.status === 101 });
}
