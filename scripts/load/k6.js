/**
 * k6 staging soak (not executed by default; staging target required).
 *
 *   k6 run -e BASE_URL=https://staging.example.com -e TOKEN=... scripts/load/k6.js
 *
 * Thresholds mirror docs/SLO.md: p95 ≤ 400ms for dashboard reads, < 1% errors.
 * Never point BASE_URL at production: staging data only.
 */
import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://127.0.0.1:3100";
const TOKEN = __ENV.TOKEN || "";
const PATHS = (__ENV.PATHS || "/api/health/live,/api/health/ready,/api/v1/leads,/api/v1/calls").split(",");

export const options = {
  scenarios: {
    steady: {
      executor: "ramping-vus",
      startVUs: 5,
      stages: [
        { duration: "1m", target: 25 },
        { duration: "3m", target: 25 },
        { duration: "1m", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{expected_response:true}": ["p(95)<400"],
    checks: ["rate>0.99"],
  },
};

export default function loadScenario() {
  for (const path of PATHS) {
    const res = http.get(`${BASE_URL}${path}`, {
      headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
      tags: { path },
    });
    check(res, { "status is not 5xx": (r) => r.status < 500 });
  }
  sleep(1);
}
