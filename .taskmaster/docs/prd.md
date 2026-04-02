# PRD: AgentOps Cloud — Demo-Ready Release

**Author:** Engineering Team
**Date:** 2026-03-30
**Status:** Approved
**Version:** 1.0
**Taskmaster Optimized:** Yes

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Problem Statement](#problem-statement)
3. [Goals & Success Metrics](#goals--success-metrics)
4. [User Stories](#user-stories)
5. [Functional Requirements](#functional-requirements)
6. [Non-Functional Requirements](#non-functional-requirements)
7. [Technical Considerations](#technical-considerations)
8. [Implementation Roadmap](#implementation-roadmap)
9. [Out of Scope](#out-of-scope)
10. [Open Questions & Risks](#open-questions--risks)
11. [Validation Checkpoints](#validation-checkpoints)
12. [Appendix: Task Breakdown Hints](#appendix-task-breakdown-hints)

---

## Executive Summary

AgentOps Cloud is a multi-tenant enterprise SaaS platform for creating, deploying, and governing AI worker agents per customer. A technical audit has identified 16 critical gaps across security, skill building, agent execution, and demo completeness that prevent the platform from being confidently demonstrated to prospects. This PRD defines the work required to close all 16 gaps and produce a stable, convincing demo that showcases: multi-tenancy, live agent execution, customer dashboard isolation, issue reporting, and the full admin control plane.

---

## Problem Statement

### Current Situation
AgentOps Cloud has strong architectural foundations — database-level row-level security, AES-256-GCM credential encryption, hashed API keys, and an Anthropic Claude API execution pipeline. However, a structured audit against the product spec revealed three categories of blockers preventing a production-quality demo:

1. **Security gaps** — RBAC has a department-level fallback that can allow cross-department access, auth endpoints have no rate limiting, and IP allowlisting is unimplemented.
2. **Skill YAML builder is broken for users** — no schema validation, raw js-yaml parser errors surfaced directly to the UI, no required-field enforcement, no helpful UI hints.
3. **Execution layer is incomplete** — no persistent job queue (server restart kills in-flight runs), no workflow orchestration, skills are text-only with no executable structure.
4. **Demo flows are disconnected** — agent templates are empty, customer dashboard branding is static, stop-agent is unwired, issue reporting has no working attachment upload, and there is no end-to-end demo path.

### User Impact
- **Internal demo team** cannot reliably walk prospects through the platform without hitting errors or dead ends.
- **Customer dashboard** shows no tenant-scoped branding, making multi-tenancy invisible.
- **Skill builders** (operations engineers) get cryptic YAML errors with no guidance on how to fix them.
- **Prospects** cannot see a live agent run completing a task end-to-end.

### Business Impact
- Platform cannot be demoed to enterprise prospects.
- Every demo failure erodes confidence in the product's readiness.
- Without a persistent job queue, any infrastructure blip during a live demo kills the agent run mid-stream.

### Why Solve This Now?
Demo readiness is blocking sales pipeline progression. All fixes are contained within the existing codebase — no architectural rethink required. The platform is 70–85% complete; this PRD closes the remaining gap.

---

## Goals & Success Metrics

### Goal 1: Zero demo-blocking errors
- **Metric:** Number of uncaught errors during a full demo walkthrough
- **Baseline:** 5+ errors across skill builder, agent run, customer dashboard
- **Target:** 0 errors during a scripted demo run
- **Timeframe:** End of this sprint
- **Measurement:** Internal QA walkthrough checklist pass rate = 100%

### Goal 2: End-to-end agent execution works reliably
- **Metric:** Agent run completion rate (% of runs that complete without server crash loss)
- **Baseline:** ~60% (fire-and-forget, lost on restart)
- **Target:** 99%+ (persistent queue with retry)
- **Timeframe:** End of sprint
- **Measurement:** Run 20 consecutive test agent runs; all complete and persist

### Goal 3: Skill YAML builder has zero confusing errors
- **Metric:** User can create a valid skill from the UI without external documentation
- **Baseline:** Raw js-yaml errors; no schema hints
- **Target:** Friendly validation messages + live schema hints for all required fields
- **Timeframe:** End of sprint
- **Measurement:** A non-technical user can create a skill in under 3 minutes

### Goal 4: Customer dashboard demonstrates real tenant isolation
- **Metric:** Tenant-branded dashboard loads correct branding, zero cross-tenant data visible
- **Baseline:** Static branding, no switcher
- **Target:** Each demo customer login shows their brand color, logo, and only their agents
- **Timeframe:** End of sprint
- **Measurement:** Log in as 3 different customer users — each sees only their tenant

### Goal 5: Security hardening passes internal review
- **Metric:** Internal security checklist (RBAC gap, auth rate limiting, IP allowlist)
- **Baseline:** 3 open gaps
- **Target:** 0 open gaps
- **Timeframe:** End of sprint
- **Measurement:** Code review sign-off from lead engineer

---

## User Stories

### Story 1: Skill Builder Creates a Valid Skill Without Errors

**As an** operations engineer building a new agent skill,
**I want to** see clear field hints and friendly validation messages in the skill YAML editor,
**So that I can** create a valid, working skill without guessing the schema or reading raw parser errors.

**Acceptance Criteria:**
- [ ] Editor shows inline template with persona, instructions, tools, and constraints fields pre-populated with placeholder text
- [ ] Saving with missing `instructions` field shows: "instructions is required — add a description of what this agent should do"
- [ ] YAML indentation error shows: "Line 5: indentation error — YAML uses 2 spaces, not tabs"
- [ ] Valid skill saves successfully and appears in the Skills Catalog
- [ ] Skill is immediately assignable to an agent after creation

**Task Breakdown Hint:**
- Task: Add Zod schema for skill content (2h)
- Task: Map js-yaml errors to friendly messages (3h)
- Task: Update UI template with required field placeholders and hints (2h)
- Task: Add server-side validation returning structured errors (2h)

**Dependencies:** None

---

### Story 2: Admin Creates Customer, Creates Agent, Runs Agent

**As an** internal operations admin,
**I want to** create a customer tenant, assign a pre-built agent template, and trigger a live agent run,
**So that I can** demonstrate the full platform lifecycle to a prospect in under 10 minutes.

**Acceptance Criteria:**
- [ ] Admin can create a new customer with name, branding color, and logo in under 3 steps
- [ ] At least 3 agent templates available: Dispatch Agent, Booking Agent, QA Agent
- [ ] Admin can assign a template to the new customer with 2 clicks
- [ ] Admin can trigger an agent run from the agent detail page
- [ ] Run status updates in real-time (streaming or polling)
- [ ] Run output is persisted and visible after page refresh
- [ ] Run survives a server restart (persistent queue)

**Task Breakdown Hint:**
- Task: Build 3 demo agent templates with skills and prompts (4h)
- Task: Wire agent run trigger button in admin UI (2h)
- Task: Implement BullMQ persistent job queue for agent runs (6h)
- Task: Add run status polling/SSE to admin agent detail page (3h)

**Dependencies:** Skill builder fixed (Story 1)

---

### Story 3: Customer Logs In and Sees Their Tenant Dashboard

**As a** customer user logging into my company's AgentOps dashboard,
**I want to** see my company branding, my agents only, and no data from other customers,
**So that I can** feel confident the platform is secure and purpose-built for my organization.

**Acceptance Criteria:**
- [ ] Login redirects to tenant-scoped dashboard showing customer's primary brand color
- [ ] Customer logo displayed in sidebar/header
- [ ] Agent list shows only agents with matching tenant_id
- [ ] No admin-only sections or cross-tenant data visible
- [ ] "My Agents" count matches actual provisioned agents for that tenant
- [ ] Switching browser session to another customer login shows completely different branding and agents

**Task Breakdown Hint:**
- Task: Wire tenant branding (color, logo) into customer dashboard on login (3h)
- Task: Verify all customer dashboard API routes enforce tenant scoping (2h)
- Task: Add tenant switcher to admin dashboard for demo purposes (2h)

**Dependencies:** Customer creation flow working

---

### Story 4: Customer Stops an Agent

**As a** customer admin,
**I want to** stop a running agent from my dashboard with one click,
**So that I can** immediately halt an agent that is behaving unexpectedly without calling support.

**Acceptance Criteria:**
- [ ] Stop button visible on agent detail page for users with stop permission
- [ ] Clicking stop shows confirmation dialog with reason field
- [ ] Confirmation triggers API call that marks agent run as cancelled
- [ ] Agent status updates to "Stopped" within 3 seconds
- [ ] Stop action is logged in audit trail with actor, reason, and timestamp
- [ ] Internal ops team receives in-app notification of stop event

**Task Breakdown Hint:**
- Task: Wire stop-agent button to POST /api/agents/:id/stop (2h)
- Task: Implement stop logic in job queue (cancel BullMQ job) (3h)
- Task: Add audit log entry for stop actions (1h)
- Task: Add in-app notification to ops team on stop (2h)

**Dependencies:** BullMQ queue (Story 2)

---

### Story 5: Customer Reports an Issue with Attachments

**As a** customer user,
**I want to** submit an issue report with a screenshot and description directly from my dashboard,
**So that I can** communicate problems to the internal team quickly with full context.

**Acceptance Criteria:**
- [ ] Issue report form accessible from any agent detail page
- [ ] Form includes: agent selector, issue type, severity, description, expected vs actual behavior
- [ ] File upload accepts: PNG, JPG, MP4, WebM, HAR (max 50MB)
- [ ] Upload uses signed S3/MinIO URLs (no direct exposure of bucket credentials)
- [ ] Submitted issue appears in customer's "My Issues" list within 5 seconds
- [ ] Internal ops team sees new issue in Requests Queue with attachments visible
- [ ] Issue has auto-generated incident ID

**Task Breakdown Hint:**
- Task: Implement signed URL upload endpoint for attachments (3h)
- Task: Wire file upload to issue report form (3h)
- Task: Ensure issue appears in both customer and admin views (2h)
- Task: Generate and display incident ID (1h)

**Dependencies:** None (can run in parallel)

---

### Story 6: Admin Views Audit Log

**As a** platform super admin,
**I want to** view a searchable audit log of all actions taken across the platform,
**So that I can** demonstrate compliance controls to enterprise prospects.

**Acceptance Criteria:**
- [ ] Audit log page visible in admin dashboard under Compliance section
- [ ] Shows: actor, action, object type, object ID, tenant, IP, timestamp
- [ ] Filterable by: tenant, actor, action type, date range
- [ ] Entries are immutable (no edit/delete UI)
- [ ] At least 10 demo audit events seeded for the demo tenant

**Task Breakdown Hint:**
- Task: Build audit log UI page with filter controls (4h)
- Task: Connect to existing audit_logs table via API (2h)
- Task: Seed demo audit events for demo tenant (1h)

**Dependencies:** None

---

## Functional Requirements

### Must Have (P0) — Demo Blockers

#### REQ-001: Skill YAML Schema Validation
**Description:** The skill content editor must validate YAML against a defined schema (persona, instructions, tools, constraints) and return friendly, actionable error messages instead of raw js-yaml exceptions.

**Acceptance Criteria:**
- [ ] Zod schema defined for skill content with required `instructions` field
- [ ] Missing required fields return: `"Field 'instructions' is required"`
- [ ] YAML syntax errors return human-readable messages mapping line numbers
- [ ] Schema enforced on both client and server

**Technical Specification:**
```typescript
// Zod schema for skill content
const skillContentSchema = z.object({
  persona: z.string().optional(),
  instructions: z.string().min(10, "instructions must be at least 10 characters"),
  tools: z.array(z.object({
    name: z.string(),
    description: z.string()
  })).optional(),
  constraints: z.array(z.string()).optional(),
  examples: z.array(z.string()).optional(),
});

// Friendly YAML error mapper
function friendlyYamlError(e: Error): string {
  const match = e.message.match(/at line (\d+)/);
  const line = match ? ` (line ${match[1]})` : '';
  if (e.message.includes('bad indentation')) return `Indentation error${line} — use 2 spaces, not tabs`;
  if (e.message.includes('duplicated mapping key')) return `Duplicate key${line} — each field name must be unique`;
  return `YAML syntax error${line}: ${e.message.split('\n')[0]}`;
}
```

**Task Breakdown:**
- Add Zod schema for skill content: Small (2h)
- Add friendly YAML error mapper in NewSkillClient.tsx: Small (2h)
- Update server validation in skills.ts to use schema: Small (2h)
- Update UI editor template with field hints: Small (2h)

**Dependencies:** None

---

#### REQ-002: Persistent Job Queue for Agent Runs
**Description:** Agent runs must be processed via BullMQ (Redis-backed) so that in-flight jobs survive server restarts and failed jobs are retried automatically.

**Acceptance Criteria:**
- [ ] BullMQ queue created: `agent-runs`
- [ ] `POST /api/agents/:id/run` enqueues job and returns `{ runId, status: "queued" }`
- [ ] Worker process picks up job and executes Claude API call
- [ ] On worker crash/restart, job is retried up to 3 times
- [ ] Dead-letter queue captures jobs that fail all retries
- [ ] Run status transitions: queued → running → completed/failed
- [ ] All status transitions written to `agent_runs` table

**Technical Specification:**
```typescript
// Queue setup
import { Queue, Worker } from 'bullmq';

const agentRunQueue = new Queue('agent-runs', { connection: redis });

// Enqueue
await agentRunQueue.add('run', { agentId, companyId, input, runId }, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: 100,
  removeOnFail: 500,
});

// Worker
const worker = new Worker('agent-runs', async (job) => {
  const { agentId, companyId, input, runId } = job.data;
  await executeAgentRun(agentId, companyId, input, runId);
}, { connection: redis });
```

**Task Breakdown:**
- Install and configure BullMQ: Small (2h)
- Refactor agentRuns.ts to enqueue instead of fire-and-forget: Medium (4h)
- Create agent-run worker process: Medium (4h)
- Add dead-letter queue handling: Small (2h)
- Update run status polling endpoint: Small (2h)

**Dependencies:** Redis (already in stack)

---

#### REQ-003: RBAC Department-Level Isolation Fix
**Description:** The RBAC middleware fallback must not allow cross-department resource access when departmentId is absent from the route context. All resource-level routes must explicitly scope queries to the requesting user's department.

**Acceptance Criteria:**
- [ ] Routes that return department-scoped resources include departmentId in DB query
- [ ] RBAC middleware fallback removed or guarded with explicit department check
- [ ] Test: user in Department A cannot list resources from Department B

**Task Breakdown:**
- Audit all resource routes for missing departmentId scoping: Small (2h)
- Add department filter to affected queries: Medium (3h)
- Remove unsafe RBAC fallback or add explicit guard: Small (2h)
- Add integration test for cross-department isolation: Small (2h)

**Dependencies:** None

---

#### REQ-004: Auth Endpoint Rate Limiting
**Description:** Login, MFA verification, and password reset endpoints must be rate-limited to prevent brute-force attacks.

**Acceptance Criteria:**
- [ ] POST /api/auth/login: max 10 requests per IP per minute
- [ ] POST /api/auth/verify-mfa: max 5 requests per IP per minute
- [ ] POST /api/auth/forgot-password: max 3 requests per IP per 15 minutes
- [ ] Rate limit exceeded returns 429 with `Retry-After` header

**Technical Specification:**
```typescript
const authRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  message: { error: 'Too many login attempts. Please try again in 1 minute.' }
});
app.use('/api/auth/login', authRateLimit);
```

**Task Breakdown:**
- Apply rate limiting middleware to auth routes: Small (2h)
- Add test for rate limit enforcement: Small (1h)

**Dependencies:** None

---

#### REQ-005: Three Demo Agent Templates
**Description:** The Agent Templates Library must contain at least 3 fully configured, runnable templates that can be assigned to a customer and produce visible output during a demo.

**Acceptance Criteria:**
- [ ] Templates: Dispatch Agent, Booking Agent, QA Agent
- [ ] Each template has: name, description, at least 1 skill, default system prompt, sample input
- [ ] Templates visible in admin "Agent Templates Library"
- [ ] Assigning template to new agent pre-fills skills and prompt
- [ ] Each template produces visible output when run with sample input

**Task Breakdown:**
- Write skill YAML for Dispatch, Booking, QA agents: Small (3h)
- Seed templates into DB via migration/seed script: Small (2h)
- Wire template selection into agent creation wizard: Medium (3h)
- Test each template produces output with sample input: Small (2h)

**Dependencies:** REQ-001 (skill YAML working)

---

#### REQ-006: Tenant Branding on Customer Dashboard
**Description:** Customer dashboard must load and apply the tenant's branding (primary color, logo) on login, making multi-tenancy visually obvious during a demo.

**Acceptance Criteria:**
- [ ] Customer login loads tenant branding config from API
- [ ] Primary brand color applied to sidebar, header, and accent elements
- [ ] Tenant logo displayed in header
- [ ] Different customer logins show visually distinct dashboards
- [ ] Branding config editable by admin in Customer Management

**Technical Specification:**
```typescript
// On customer login, load branding
const { data: branding } = await api.get(`/api/tenant/branding`);
document.documentElement.style.setProperty('--brand-primary', branding.primaryColor);
```

**Task Breakdown:**
- Create GET /api/tenant/branding endpoint (tenant-scoped): Small (2h)
- Apply CSS custom properties from branding config on dashboard load: Small (3h)
- Display logo in customer dashboard header: Small (2h)
- Seed 2-3 demo tenants with distinct branding: Small (1h)

**Dependencies:** None

---

#### REQ-007: Stop-Agent End-to-End
**Description:** The stop-agent flow must be fully wired: UI button → API → job queue cancellation → status update → audit log → ops notification.

**Acceptance Criteria:**
- [ ] Stop button on customer agent detail page
- [ ] Confirmation dialog with required reason field
- [ ] API cancels active BullMQ job
- [ ] Agent status updated to "stopped" in DB
- [ ] Audit log entry created
- [ ] In-app notification sent to ops team

**Task Breakdown:**
- Add stop button and confirmation dialog to customer agent detail: Small (2h)
- Implement POST /api/agents/:id/stop endpoint: Small (2h)
- Cancel BullMQ job in worker: Small (2h)
- Write audit log entry on stop: Small (1h)
- Send in-app notification to ops: Small (2h)

**Dependencies:** REQ-002 (BullMQ queue)

---

#### REQ-008: Issue Report Attachment Upload
**Description:** The issue report form must support file attachment uploads via signed S3/MinIO URLs so customers can submit screenshots and recordings without exposing storage credentials.

**Acceptance Criteria:**
- [ ] GET /api/uploads/signed-url returns pre-signed PUT URL for S3/MinIO
- [ ] Client uploads file directly to S3/MinIO using signed URL
- [ ] Issue report saves attachment refs (not raw URLs) in DB
- [ ] Attachments visible in admin Requests Queue
- [ ] Max file size 50MB; accepted types: PNG, JPG, MP4, WebM

**Technical Specification:**
```typescript
// Signed URL endpoint
app.get('/api/uploads/signed-url', authenticate, async (req, res) => {
  const { filename, contentType } = req.query;
  const key = `${req.companyId}/${req.user.id}/${Date.now()}-${filename}`;
  const url = await s3.getSignedUploadUrl(key, contentType, 3600);
  res.json({ url, key });
});
```

**Task Breakdown:**
- Implement signed URL endpoint: Small (2h)
- Wire drag-and-drop upload to signed URL in issue report form: Medium (4h)
- Save attachment keys in issue_reports table: Small (1h)
- Display attachments in admin issue view: Small (2h)

**Dependencies:** S3/MinIO already configured

---

#### REQ-009: Audit Log UI
**Description:** Admin dashboard must have a working Audit Log page showing all platform actions with filter controls.

**Acceptance Criteria:**
- [ ] Audit log accessible from admin sidebar under "Compliance"
- [ ] Shows columns: timestamp, actor, action, object type, object ID, tenant, IP
- [ ] Filterable by tenant, action type, date range
- [ ] Paginated (50 per page)
- [ ] Demo tenant seeded with at least 10 realistic events

**Task Breakdown:**
- Build audit log page with filter UI: Medium (4h)
- GET /api/audit-logs endpoint with filters: Small (2h)
- Seed demo audit events: Small (1h)

**Dependencies:** None

---

#### REQ-010: End-to-End Demo Script & Seed Data
**Description:** A seeded demo environment must exist with 2 customers, 3 agents, sample runs, and sample issues so the demo can be walked through reliably without manual setup.

**Acceptance Criteria:**
- [ ] Seed script creates: 2 demo tenants (Acme Corp, NovaTech) with distinct branding
- [ ] Each tenant has: 1 customer admin user + 1 viewer user
- [ ] Each tenant has: 2 pre-configured agents (1 active, 1 paused)
- [ ] 3 completed agent runs with sample output text
- [ ] 1 open issue report with attachment
- [ ] 1 pending new agent request
- [ ] 10 audit log events
- [ ] Seed idempotent (safe to re-run)

**Task Breakdown:**
- Write seed script for demo data: Medium (4h)
- Add seed command to package.json: Small (30m)
- Verify seed produces expected demo walkthrough: Small (1h)

**Dependencies:** All above REQs complete

---

### Should Have (P1) — Demo Polish

#### REQ-011: New Agent Request Form Functional
**Description:** The "Request New Agent" form on the customer dashboard must submit to the DB and appear in the admin Requests Queue.

**Acceptance Criteria:**
- [ ] Form fields: business purpose, desired workflow, target systems, priority, file upload
- [ ] Submission saves to `agent_requests` table with tenant_id
- [ ] Appears in admin Requests Queue within 5 seconds
- [ ] Customer sees submitted request in "My Requests" with status "New"

**Task Breakdown:**
- Wire request form submission to POST /api/agent-requests: Small (2h)
- Verify admin Requests Queue pulls from same table: Small (1h)
- Display request status in customer My Requests: Small (2h)

---

#### REQ-012: Live Run Output Streaming in Admin UI
**Description:** When an admin triggers an agent run, output should stream in real-time in the UI rather than requiring a page refresh.

**Acceptance Criteria:**
- [ ] Agent run output panel shows streaming text as Claude generates it
- [ ] SSE or polling updates run status in UI
- [ ] "Running..." indicator shown during execution
- [ ] Completed output persists after stream ends

**Task Breakdown:**
- Wire SSE stream endpoint to admin agent run panel: Medium (4h)
- Add loading/streaming state indicators: Small (2h)

---

### Nice to Have (P2) — Post-Demo

#### REQ-013: IP Allowlisting
**Description:** Add optional IP allowlist per tenant so only specified IPs can access the customer dashboard.

**Task Breakdown:**
- Add ip_allowlist field to tenant settings: Small (2h)
- Middleware to check request IP against allowlist: Small (2h)
- UI to manage allowlist entries: Small (3h)

---

## Non-Functional Requirements

### Performance
- Dashboard load: < 2 seconds for customer and admin views
- Agent run trigger to first token: < 5 seconds
- Issue submission (excluding upload): < 3 seconds
- Audit log page load with filters: < 2 seconds

### Security
- All credential secrets remain AES-256-GCM encrypted
- Auth endpoints rate-limited (REQ-004)
- All API routes enforce tenant_id scoping
- Signed URLs for all file uploads/downloads
- Audit log immutable via append-only + hash chain

### Reliability
- Agent runs survive server restart via BullMQ (REQ-002)
- Failed runs retry up to 3 times with exponential backoff
- Dead-letter queue for permanently failed runs

### Demo Stability
- Seed script produces consistent demo environment on every run
- No unhandled exceptions during scripted demo walkthrough
- All demo flows completable by non-technical presenter

---

## Technical Considerations

### System Architecture

**Current execution model (broken for demo):**
```
HTTP Request → agentRuns.ts → fire-and-forget async → Claude API
                                    ↓ (lost on restart)
```

**Target execution model:**
```
HTTP Request → agentRuns.ts → BullMQ enqueue → return runId
                                    ↓
                Worker Process → Claude API → update DB → SSE notify
```

**BullMQ integration:**
```typescript
// apps/server/src/queues/agentRunQueue.ts
export const agentRunQueue = new Queue('agent-runs', { connection: redis });

// apps/server/src/workers/agentRunWorker.ts
export const agentRunWorker = new Worker('agent-runs', async (job) => {
  const { agentId, companyId, input, runId } = job.data;
  await db.update(agentRuns).set({ status: 'running' }).where(eq(agentRuns.id, runId));
  const output = await executeClaudeRun(agentId, companyId, input);
  await db.update(agentRuns).set({ status: 'completed', output }).where(eq(agentRuns.id, runId));
}, { connection: redis, concurrency: 5 });
```

### Skill YAML Schema

```yaml
# Valid skill template
persona: "You are a professional dispatch coordinator..."
instructions: |
  Your job is to process incoming dispatch requests.
  For each request:
  1. Extract the job type, location, and priority
  2. Check availability using the dispatch tool
  3. Confirm booking and return confirmation number
tools:
  - name: dispatch_lookup
    description: Look up available dispatch slots
constraints:
  - Never book more than 3 jobs per hour
  - Always confirm with customer before finalizing
```

### Demo Tenant Seed Data

```
Tenant 1: Acme Corp
  - Brand: #1E40AF (blue), logo: acme-logo.png
  - Users: admin@acme.com, viewer@acme.com
  - Agents: "Acme Dispatch Agent" (active), "Acme QA Agent" (paused)
  - Runs: 3 completed with sample dispatch outputs
  - Issues: 1 open issue with screenshot attachment

Tenant 2: NovaTech
  - Brand: #059669 (green), logo: novatech-logo.png
  - Users: admin@novatech.com, viewer@novatech.com
  - Agents: "NovaTech Booking Agent" (active), "NovaTech Data Agent" (draft)
  - Runs: 2 completed with sample booking confirmations
  - Requests: 1 pending new agent request
```

---

## Implementation Roadmap

### Phase 1: Fix Broken Core (Days 1–2)
**Goal:** Skill builder works, security gaps closed, job queue in place

- [ ] Task 1.1: Add Zod schema + friendly error mapping to skill builder (4h)
- [ ] Task 1.2: Fix RBAC department isolation gap (4h)
- [ ] Task 1.3: Add rate limiting to auth endpoints (2h)
- [ ] Task 1.4: Install BullMQ, create agent-run queue and worker (8h)

**Validation Checkpoint:** Create a skill without errors; trigger an agent run that survives server restart

---

### Phase 2: Wire Demo Flows (Days 3–4)
**Goal:** All demo user journeys completable end-to-end

- [ ] Task 2.1: Build and seed 3 agent templates (5h)
- [ ] Task 2.2: Wire tenant branding to customer dashboard (5h)
- [ ] Task 2.3: Wire stop-agent end-to-end (6h)
- [ ] Task 2.4: Implement attachment upload with signed URLs (6h)
- [ ] Task 2.5: Build audit log UI page (5h)

**Validation Checkpoint:** Full admin demo flow: create customer → create agent → run agent → customer views output → customer stops agent → customer reports issue

---

### Phase 3: Seed & Stabilize (Day 5)
**Goal:** Demo environment is seeded and stable

- [ ] Task 3.1: Write idempotent demo seed script (4h)
- [ ] Task 3.2: Wire new agent request form (3h)
- [ ] Task 3.3: Add run output streaming to admin UI (4h)
- [ ] Task 3.4: QA full demo walkthrough, fix any blockers (4h)

**Validation Checkpoint:** Non-technical team member completes full demo walkthrough without errors

---

### Phase 4: Polish (Day 6 — buffer)
**Goal:** Demo looks polished and professional

- [ ] Task 4.1: Loading states and empty states for all views (3h)
- [ ] Task 4.2: Error boundary components for graceful UI failures (2h)
- [ ] Task 4.3: Mobile-responsive check on customer dashboard (2h)
- [ ] Task 4.4: Final QA pass with scripted demo checklist (2h)

**Validation Checkpoint:** All 16 audit gaps closed; internal sign-off

---

## Out of Scope

1. **SSO / SAML** — post-demo phase
2. **Approval workflows for agent publish** — post-demo
3. **Usage metering / billing** — post-demo
4. **Self-service customer agent builder** — explicitly non-goal for v1
5. **Mobile app** — web only
6. **Advanced analytics / run replay** — Phase 3 roadmap item

---

## Open Questions & Risks

### Open Questions

**Q1: BullMQ worker — same process or separate?**
- Options: (A) Same Express process with worker co-located, (B) Separate worker container
- Recommendation: A for demo simplicity; B for production
- Decision needed before Task 1.4

**Q2: S3 or MinIO for attachment storage in demo?**
- MinIO already in docker-compose; S3 for production
- Recommendation: Use MinIO for demo, abstract behind storage service
- Decision needed before Task 2.4

**Q3: Should demo seed script be CLI or run automatically on startup?**
- Recommendation: CLI command `npm run seed:demo` — safer, idempotent
- Decision needed before Task 3.1

---

### Risks & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| BullMQ integration touches core execution path — regression risk | Medium | High | Feature flag to fall back to existing fire-and-forget |
| Demo seed script creates data conflicts with existing dev data | Medium | Medium | Seed uses identifiable demo emails; script checks before insert |
| Tenant branding CSS changes break existing customer UI | Low | Medium | Apply branding via CSS custom properties only; no structural changes |
| Claude API key missing in demo env | Low | Critical | Add pre-demo checklist: verify ANTHROPIC_API_KEY is set and valid |

---

## Validation Checkpoints

### Checkpoint 1: Phase 1 Complete
- [ ] Create a skill with invalid YAML → see friendly error message, not raw exception
- [ ] Create a valid skill → it saves and appears in Skills Catalog
- [ ] Trigger agent run → run survives Express server restart → output present in DB
- [ ] RBAC test: user in Dept A cannot access Dept B resources
- [ ] Auth rate limit test: 11th login attempt in 60s returns 429

### Checkpoint 2: Phase 2 Complete
- [ ] Admin creates customer "Demo Corp" with blue branding
- [ ] Assigns Dispatch Agent template → agent visible in admin
- [ ] Triggers agent run → real-time output visible → run completes
- [ ] Logs in as Demo Corp customer → sees blue branding, only their agents
- [ ] Customer stops agent → status changes to Stopped → audit log entry present
- [ ] Customer submits issue with screenshot → appears in admin Requests Queue

### Checkpoint 3: Phase 3 Complete
- [ ] `npm run seed:demo` creates Acme Corp and NovaTech tenants with all fixtures
- [ ] Non-technical team member walks scripted demo in < 10 minutes without errors
- [ ] 0 unhandled exceptions in browser console during full walkthrough

### Checkpoint 4: Final Sign-off
- [ ] All 16 audit gaps from technical audit are closed
- [ ] Internal QA checklist: 100% pass rate
- [ ] Demo recorded end-to-end for async review

---

## Appendix: Task Breakdown Hints

### Summary of All Tasks

**Phase 1 — Fix Core (18h)**
1. Zod schema + YAML error mapper in skill builder (4h)
2. RBAC department isolation fix (4h)
3. Auth endpoint rate limiting (2h)
4. BullMQ queue + worker for agent runs (8h)

**Phase 2 — Wire Flows (27h)**
5. 3 demo agent templates + seed (5h)
6. Tenant branding on customer dashboard (5h)
7. Stop-agent end-to-end wiring (6h)
8. Issue report attachment upload via signed URLs (6h)
9. Audit log UI page (5h)

**Phase 3 — Seed & Stabilize (15h)**
10. Demo seed script (4h)
11. New agent request form wiring (3h)
12. Run output streaming in admin UI (4h)
13. QA demo walkthrough (4h)

**Phase 4 — Polish (9h)**
14. Loading + empty states (3h)
15. Error boundaries (2h)
16. Responsive check (2h)
17. Final QA (2h)

**Total: ~69 hours (~1.5 weeks for 1 full-stack developer)**

### Critical Path
1.4 (BullMQ) → 2.3 (stop-agent) → 3.1 (seed) → 3.4 (QA)

### Parallelizable
- Task 1.1 (skill builder) || Task 1.2 (RBAC) || Task 1.3 (rate limiting)
- Task 2.1 (templates) || Task 2.2 (branding) || Task 2.4 (attachments) || Task 2.5 (audit log)
- Task 3.2 (request form) || Task 3.3 (streaming)

---

*This PRD is optimized for TaskMaster AI task generation. All requirements include task breakdown hints, complexity estimates, and dependency mapping.*
