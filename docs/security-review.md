# Security Review — AgentOps Cloud v2

**Date:** 2026-03-30
**Reviewer:** QA Engineer
**Scope:** M4.10 Security Review + Dependency Audit
**Status:** Complete — all M4 work reviewed; findings documented; CTO remediation items listed

---

## OWASP Top 10 Checklist

| # | Category | Status | Notes |
|---|----------|--------|-------|
| A01 | Broken Access Control | ⚠️ Medium | Finding #2 (RBAC any-dept fallback) + Finding #4 (open redirect) |
| A02 | Cryptographic Failures | ✅ Pass | bcrypt, JWTs via `jsonwebtoken`, httpOnly cookies, HTTPS enforced |
| A03 | Injection | ✅ Pass | All queries use Drizzle ORM parameterized calls; dashboard auto-escapes via React JSX |
| A04 | Insecure Design | ✅ Pass | Company-scoped resource isolation enforced at DB layer |
| A05 | Security Misconfiguration | ⚠️ Low | Missing security headers across API, dashboard, and ingress |
| A06 | Vulnerable & Outdated Components | ✅ Pass | Zero critical/high CVEs; 2 moderate dev-only (accepted) |
| A07 | Auth & Session Failures | ⚠️ Medium | WS accepts token via URL query param (Finding #1) |
| A08 | Software & Data Integrity | ✅ Pass | Webhook payloads use HMAC-SHA256 signature |
| A09 | Security Logging Failures | ✅ Pass | Audit middleware logs state changes; no tokens/passwords in logs |
| A10 | SSRF | ✅ Pass | No server-side URL fetching from user input |

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

Tokens in URLs are exposed in web server access logs, reverse proxy logs (nginx, ALB), browser history, and referrer headers.

**Acceptance criteria violation:** "confirm no tokens in URLs"

**Recommendation:**
Remove query-param token support. Require `Authorization: Bearer <token>` header only. WS clients can send custom headers in the HTTP upgrade handshake.

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

A user with `workspace:view` in Department A can call `GET /api/workspaces/:id` to access workspaces in Department B (within same company). Company isolation is preserved at the DB layer, but intra-company department isolation is not enforced for workspace/incident/file reads.

**Recommendation:**
Require explicit department context for all cross-department resource reads, OR enforce department ownership at the DB query layer.

**Owner:** CTO
**Priority:** Medium — track in backlog; remediate before GA

---

### Finding #3 — Low: Missing HTTP Security Headers

**Files:** `apps/server/src/app.ts`, `apps/web/src/middleware.ts`, `apps/web/next.config.mjs`, `k8s/ingress.yaml`
**Severity:** Low
**OWASP:** A05 — Security Misconfiguration

**Description:**
Security headers are not set across the stack:
- **API server** (`app.ts`): `helmet` not installed. No `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Strict-Transport-Security`, or `Content-Security-Policy`.
- **Next.js dashboard** (`middleware.ts`, `next.config.mjs`): No CSP header; no `headers()` function in `next.config.mjs`.
- **k8s Ingress** (`ingress.yaml`): No `nginx.ingress.kubernetes.io/add-headers` annotation for HSTS or security header injection.

**Positive notes:** TLS redirect is enforced at the ingress level (`ssl-redirect: "true"`) ✅. Cookies are `httpOnly` and `secure` in production ✅.

**Recommendation:**
- API: Add `helmet` middleware
- Dashboard: Add CSP via `next.config.mjs` headers or middleware
- Ingress: Add HSTS, X-Frame-Options, X-Content-Type-Options annotations

**Owner:** CTO (API + ingress), Junior Dev (dashboard)
**Priority:** Low — add before production go-live

---

### Finding #4 — Medium: Open Redirect in Login Flow

**File:** `apps/web/src/app/(auth)/login/actions.ts:35`
**Severity:** Medium
**OWASP:** A01 — Broken Access Control

**Description:**
The login Server Action redirects to an unvalidated `from` parameter after successful authentication:

```ts
const from = (formData.get("from") as string) || "/";
// ... after successful login:
redirect(from);
```

The `from` value originates from the `?from=` URL query parameter and is passed as a hidden form field without validation. An attacker can craft:

```
https://agentops.example.com/login?from=https://phishing.example.com/fake-login
```

After a successful login, the user is redirected to the external phishing URL.

**Recommendation:**
Validate `from` is a relative URL before using it:
```ts
const isRelative = from.startsWith("/") && !from.startsWith("//");
const safeFrom = isRelative ? from : "/";
redirect(safeFrom);
```

**Owner:** Junior Dev
**Priority:** Medium — remediate before M4 done

---

## XSS Review (Dashboard)

**Verdict:** ✅ Pass

- All dashboard templates use React JSX, which auto-escapes string values at render time
- No `dangerouslySetInnerHTML` usage found in any dashboard component
- Task output and error fields rendered via `JSON.stringify()` inside `<pre>` tags — React escapes the string value ✅
- Server error messages rendered as plain text, not HTML ✅
- No `eval()` or `Function()` usage ✅

---

## Auth Header / Token Storage Review (Dashboard)

**Verdict:** ✅ Pass (with Finding #4 caveat)

- JWT tokens stored in `httpOnly` cookies (not `localStorage`) — prevents XSS-based token theft ✅
- `secure: true` on cookies in production ✅
- `sameSite: "lax"` — protects against most CSRF ✅
- Cookies cleared on logout ✅
- Post-login redirect uses unvalidated `from` param — **see Finding #4** ⚠️

---

## Deployment / Production Config Review

**Verdict:** Partial pass — TLS enforced, security headers absent

- HTTPS enforced at k8s ingress with TLS termination and force-ssl-redirect ✅
- Internal service communication on private `backend` network (docker-compose.prod.yml) ✅
- Database credentials in k8s Secret (not ConfigMap) ✅
- Redis password required in production ✅
- MinIO credentials required in production ✅
- No security headers at ingress level — **see Finding #3** ⚠️
- Ingress `configuration-snippet` only handles WebSocket upgrade, not security headers ⚠️

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
`esbuild` ≤ 0.24.2 pulled through `drizzle-kit@0.30.6` (**dev dependency only**). Vulnerability (GHSA-67mh-4wv8-2f99) enables dev server cross-origin requests — not exploitable in production.
**Accepted with justification: dev-only, no production impact.**

---

## SQL Injection Review

**Verdict:** ✅ Pass

All database queries use Drizzle ORM parameterized methods (`.insert()`, `.update()`, `.delete()`, `.select()` with `.where(eq(...))`). No `db.execute()` with string interpolation. No raw SQL template literals with user input.

---

## Build Integrity

During this review, three TypeScript build errors were identified and fixed (introduced by MFA/audit-archive feature work):

1. `auth.ts:64` — `loginResult.refreshToken` accessed without narrowing MFA union type (fixed: added `mfaRequired` guard)
2. `audit.ts` — `checkCompany()` helper param type incompatible with Express `Request` (fixed: changed to `Request` type)
3. `apiKeyRotation.test.ts` — stale import of `issueAgentRunToken`/`verifyAgentRunToken` from `authService` (moved to `agentAuthService` in ONE-34)

All 299 tests passing after fixes.

---

## Pen Test Checklist (Static Review)

| Test | Result | Notes |
|------|--------|-------|
| Auth bypass (unauthenticated resource access) | ✅ Pass | All routes require `authenticate()` middleware |
| IDOR (cross-company resource access) | ✅ Pass | DB queries enforce `companyId` on all resources |
| IDOR (cross-dept within company) | ⚠️ Medium | See Finding #2 — RBAC any-dept fallback |
| Privilege escalation (role upgrade) | ✅ Pass | Roles come from JWT — server-signed, not user-modifiable |
| Privilege escalation (dept role → company admin) | ✅ Pass | Role permission tables are static constants |
| Open redirect | ⚠️ Medium | See Finding #4 — login `from` param not validated |
| Session fixation | ✅ Pass | Tokens issued fresh on each login; no session IDs |
| Token replay after logout | ✅ Pass | Refresh tokens invalidated on logout via DB |
| Brute force | ✅ Pass | Rate limiting middleware on all routes |

*Note: Live pen testing (actual exploit attempts against staging) requires a running environment, which is not yet deployed.*

---

## Summary

- **Critical findings:** 0
- **High findings:** 0
- **Medium findings:** 3 (Finding #1 WS token URL, Finding #2 RBAC cross-dept, Finding #4 open redirect)
- **Low findings:** 1 (Finding #3 missing security headers)
- **Dependency vulnerabilities:** 2 moderate (dev-only, accepted)

### Remediation Owners Before M4 Done

| Finding | Owner | Priority |
|---------|-------|----------|
| #1 — WS token in URL | CTO | Medium |
| #4 — Open redirect in login | Junior Dev | Medium |

### Track in Backlog

| Finding | Owner | Priority |
|---------|-------|----------|
| #2 — RBAC cross-dept fallback | CTO | Medium |
| #3 — Missing security headers (all layers) | CTO + Junior Dev | Low |

**QA sign-off status:** Pending CTO remediation of Finding #1 (WS token URL) and Junior Dev fix for Finding #4 (open redirect) before this can be marked done.
