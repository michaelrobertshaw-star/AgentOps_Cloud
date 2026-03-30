# Security Review — AgentOps Cloud v2

**Date:** 2026-03-30
**Reviewer:** QA Engineer
**Scope:** M4.10 Security Review + Dependency Audit
**Status:** Partial — pending ONE-30 (Next.js dashboard) and ONE-37 (Prod Deploy) completion for full sign-off

---

## OWASP Top 10 Checklist

| # | Category | Status | Notes |
|---|----------|--------|-------|
| A01 | Broken Access Control | ⚠️ Medium | See Finding #2 — RBAC "any-dept" fallback |
| A02 | Cryptographic Failures | ✅ Pass | bcrypt with configurable rounds, JWTs via `jsonwebtoken` |
| A03 | Injection | ✅ Pass | All queries use Drizzle ORM parameterized calls — no raw SQL interpolation |
| A04 | Insecure Design | ✅ Pass | Company-scoped resource isolation enforced at DB layer |
| A05 | Security Misconfiguration | ⚠️ Medium | Missing security headers (helmet not installed) — see Finding #3 |
| A06 | Vulnerable & Outdated Components | ✅ Pass | Zero critical/high CVEs. 2 moderate (see Dependency Audit) |
| A07 | Auth & Session Failures | ⚠️ Medium | WebSocket accepts token via URL query param — see Finding #1 |
| A08 | Software & Data Integrity | ✅ Pass | Webhook payloads use HMAC-SHA256 signature |
| A09 | Security Logging Failures | ✅ Pass | Audit middleware logs all state changes; no tokens/passwords in logs |
| A10 | SSRF | ✅ Pass | No server-side URL fetching from user input (webhook URLs are admin-only) |

---

## Findings

### Finding #1 — Medium: WebSocket Token Accepted via URL Query Parameter

**File:** `apps/server/src/services/wsService.ts:94`
**Severity:** Medium
**OWASP:** A07 — Identification and Authentication Failures

**Description:**
The WebSocket service accepts authentication tokens via the `?token=` URL query parameter as a fallback to the `Authorization` header:

```ts
token = parsedUrl.searchParams.get("token") ?? undefined;
```

Tokens in URLs are logged by:
- Web server access logs
- Reverse proxy logs (nginx, Caddy, AWS ALB)
- Browser history (if a browser-based client is used)
- Referrer headers on any subsequent requests

**Acceptance criteria violation:** "confirm no tokens in URLs"

**Recommendation:**
Remove query-param token support. Require `Authorization: Bearer <token>` header only. WS clients can send custom headers in the initial HTTP upgrade handshake.

**Owner:** CTO
**Priority:** Medium — remediate before M4 done

---

### Finding #2 — Medium: RBAC Fallback Allows Cross-Department Resource Access

**File:** `apps/server/src/middleware/rbac.ts:52-60`
**Severity:** Medium
**OWASP:** A01 — Broken Access Control

**Description:**
When no `departmentId` context is present in a request, the RBAC middleware grants access if the user has the required permission in **any** department:

```ts
// If no department context but user has department-level permissions,
// allow if they have the permission in ANY department
if (!departmentId && department_roles) {
  for (const deptRole of Object.values(department_roles)) {
    ...
  }
}
```

This means a user with `workspace:view` in Department A can call `GET /api/workspaces/:id` and access workspaces in Department B (within the same company). Company isolation is preserved (DB queries include `eq(workspaces.companyId, req.companyId!)`), but intra-company department isolation is not enforced for workspace/incident/file reads.

**Recommendation:**
Require explicit department context for all cross-department resource reads, OR enforce department ownership at the DB query layer (verify `workspace.departmentId` matches a department the requesting user is a member of).

**Owner:** CTO
**Priority:** Medium — track in backlog; remediate before GA

---

### Finding #3 — Low: Missing HTTP Security Headers (No Helmet)

**File:** `apps/server/src/app.ts`
**Severity:** Low (API-only server; dashboard headers addressed in ONE-30)
**OWASP:** A05 — Security Misconfiguration

**Description:**
The Express server does not set standard security headers. `helmet` is not installed or configured:
- No `X-Content-Type-Options: nosniff`
- No `X-Frame-Options`
- No `Referrer-Policy`
- No `Strict-Transport-Security` (HSTS)
- No `Content-Security-Policy` (CSP review pending ONE-30 dashboard)

**Recommendation:**
Add `helmet` to the Express app. For the API, a permissive CSP is fine; for the Next.js dashboard (ONE-30), a strict CSP should be configured.

**Owner:** CTO (API server), Junior Dev (dashboard)
**Priority:** Low — add before production deployment (ONE-37)

---

## Dependency Audit

**Command run:** `pnpm audit` (2026-03-30)

| Severity | Count | Details |
|----------|-------|---------|
| Critical | 0 | — |
| High | 0 | — |
| Moderate | 2 | esbuild ≤ 0.24.2 via `drizzle-kit` dev dep |
| Low | 0 | — |

**Verdict:** ✅ Meets acceptance criteria (zero critical/high vulnerabilities)

**Moderate finding detail:**
`esbuild` ≤ 0.24.2 is pulled in transitively through `drizzle-kit@0.30.6` (a **dev dependency** only, not in the production bundle). The vulnerability (GHSA-67mh-4wv8-2f99) allows a development server to accept cross-origin requests — not exploitable in production. **Justification: accepted as dev-only, no production impact.**

---

## SQL Injection Review

**Verdict:** ✅ Pass

All database queries in `apps/server/src/routes/` and `apps/server/src/services/` use Drizzle ORM parameterized methods:
- `.insert()`, `.update()`, `.delete()`, `.select()` with `.where(eq(...))`
- No `db.execute()` with string interpolation found
- No raw SQL template literals with user input

---

## Auth Header Review

**Verdict:** ✅ Pass (with Finding #1 caveat for WebSocket)

- REST API: tokens accepted via `Authorization: Bearer <token>` header only — no tokens in URLs ✅
- Agent check-in: API key via `X-Agent-Key` header — no tokens in URLs ✅
- WebSocket: tokens accepted via query param OR header — **see Finding #1** ⚠️
- Password hashing: bcrypt with configurable rounds (env `BCRYPT_ROUNDS`) ✅
- Timing-safe password comparison via `bcrypt.compare()` ✅
- No sensitive data (passwords, tokens) observed in `console.log`/`console.error` statements ✅
- Audit logs record `ipAddress` and `userAgent` but do NOT include auth tokens or request bodies ✅

---

## Pending Reviews (Blocked on Other M4 Tasks)

| Item | Blocker | Notes |
|------|---------|-------|
| XSS review — dashboard template output sanitization | ONE-30 (Next.js app not yet built) | Requires Next.js dashboard |
| CSP header configuration on dashboard | ONE-30 | Will review once dashboard scaffolded |
| Production header/config review (HSTS, CORS settings) | ONE-37 (Prod Deploy not done) | Will review staging config once deployed |
| Full pen test checklist (auth bypass, IDOR, priv escalation in staging) | ONE-37 | Requires live environment |

---

## Summary

- **Critical findings:** 0
- **High findings:** 0
- **Medium findings:** 2 (Finding #1 WS token in URL, Finding #2 RBAC cross-dept fallback)
- **Low findings:** 1 (Finding #3 missing security headers)
- **Dependency vulnerabilities:** 2 moderate (dev-only, accepted with justification)

**Recommended actions before M4 done:**
1. CTO: Remove WebSocket query-param token auth (Finding #1)
2. CTO: Add `helmet` to the Express app (Finding #3)
3. CTO: Assess RBAC cross-department fallback (Finding #2) — fix or accept with explicit docs

**Not blocking M4 done for QA sign-off** — medium/low findings are tracked here and assigned to CTO for remediation. Final sign-off pending completion of dashboard (ONE-30) and prod deploy (ONE-37) reviews.
