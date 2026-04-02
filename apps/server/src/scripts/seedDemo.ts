/**
 * Demo Seed Script
 *
 * Creates 2 demo tenants with agents, runs, incidents, and audit logs.
 * Idempotent — safe to run multiple times.
 *
 * Run with: pnpm seed:demo
 */

import "dotenv/config";
import bcrypt from "bcrypt";
import { createDatabase } from "@agentops/db";
import {
  companies,
  users,
  agents,
  agentRuns,
  incidents,
  auditLogs,
  departments,
  skills,
} from "@agentops/db";
import { eq, and } from "drizzle-orm";
import crypto from "node:crypto";

const db = createDatabase(process.env.DATABASE_URL);

const DEMO_PASSWORD = "Demo1234!";
const BCRYPT_ROUNDS = 10;

const TENANTS = [
  {
    name: "acme-corp",
    displayName: "Acme Corp",
    adminEmail: "admin@acme.com",
    viewerEmail: "viewer@acme.com",
    brandColor: "#1E40AF",
  },
  {
    name: "novatech",
    displayName: "NovaTech",
    adminEmail: "admin@novatech.com",
    viewerEmail: "viewer@novatech.com",
    brandColor: "#059669",
  },
];

async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, BCRYPT_ROUNDS);
}

function fakeHash(): string {
  return crypto.createHash("sha256").update(Math.random().toString()).digest("hex");
}

async function getOrCreateCompany(tenant: typeof TENANTS[0]) {
  const existing = await db.query.companies.findFirst({
    where: eq(companies.name, tenant.name),
  });
  if (existing) {
    console.log(`  [exists] Company: ${tenant.displayName}`);
    return existing;
  }

  const [company] = await db
    .insert(companies)
    .values({
      name: tenant.name,
      displayName: tenant.displayName,
      status: "active",
      settings: {
        branding: {
          primaryColor: tenant.brandColor,
          companyName: tenant.displayName,
        },
      },
    })
    .returning();

  console.log(`  [created] Company: ${tenant.displayName} (${company.id})`);
  return company;
}

async function getOrCreateUser(
  companyId: string,
  email: string,
  name: string,
  role: "customer_admin" | "customer_user",
) {
  const existing = await db.query.users.findFirst({
    where: and(eq(users.companyId, companyId), eq(users.email, email)),
  });
  if (existing) {
    console.log(`  [exists] User: ${email}`);
    return existing;
  }

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const [user] = await db
    .insert(users)
    .values({
      companyId,
      email,
      name,
      role,
      status: "active",
      passwordHash,
    })
    .returning();

  console.log(`  [created] User: ${email} (${role})`);
  return user;
}

async function getOrCreateDepartment(companyId: string, name: string) {
  const existing = await db.query.departments.findFirst({
    where: and(eq(departments.companyId, companyId), eq(departments.name, name)),
  });
  if (existing) return existing;

  const [dept] = await db
    .insert(departments)
    .values({
      companyId,
      name,
      description: `${name} department`,
      status: "active",
      settings: {},
    })
    .returning();

  console.log(`  [created] Department: ${name}`);
  return dept;
}

async function getOrCreateSkill(companyId: string, name: string, description: string, instructions: string) {
  const existing = await db.query.skills.findFirst({
    where: and(eq(skills.companyId, companyId), eq(skills.name, name)),
  });
  if (existing) return existing;

  const [skill] = await db
    .insert(skills)
    .values({
      companyId,
      name,
      description,
      content: {
        instructions,
        persona: `You are a professional ${name} agent.`,
        constraints: ["Always verify information before acting", "Log all actions"],
      },
    })
    .returning();

  console.log(`  [created] Skill: ${name}`);
  return skill;
}

async function getOrCreateAgent(
  companyId: string,
  departmentId: string,
  name: string,
  type: string,
  status: "active" | "paused",
) {
  const existing = await db.query.agents.findFirst({
    where: and(eq(agents.companyId, companyId), eq(agents.name, name)),
  });
  if (existing) return existing;

  const [agent] = await db
    .insert(agents)
    .values({
      companyId,
      departmentId,
      name,
      type,
      status,
      description: `Demo ${type} agent for ${name}`,
      version: "1.0.0",
    })
    .returning();

  console.log(`  [created] Agent: ${name} (${status})`);
  return agent;
}

async function seedAgentRuns(companyId: string, agentId: string) {
  const existing = await db.query.agentRuns.findMany({
    where: and(eq(agentRuns.companyId, companyId), eq(agentRuns.agentId, agentId)),
  });
  if (existing.length >= 3) {
    console.log(`  [exists] Agent runs for ${agentId}`);
    return;
  }

  const SAMPLE_RUNS = [
    {
      input: "Process the morning dispatch queue and assign all pending jobs",
      output: "Processed 12 jobs successfully. Assigned 8 to Team A, 4 to Team B. 1 escalated as high priority. Average response time: 3.2 minutes.",
      durationMs: 4500,
      tokensInput: 450,
      tokensOutput: 280,
    },
    {
      input: "Review overnight bookings and confirm availability",
      output: "Reviewed 47 bookings. 44 confirmed, 2 rescheduled due to conflicts, 1 cancelled by customer. All customers notified via email.",
      durationMs: 6200,
      tokensInput: 620,
      tokensOutput: 310,
    },
    {
      input: "Generate daily QA report for processed tickets",
      output: "QA Report - Date: 2026-03-30\n\nTotal tickets reviewed: 156\nPass rate: 94.2%\nFailed: 9 tickets (5.8%)\n\nTop issues:\n1. Missing customer signature (4 cases)\n2. Incorrect priority assignment (3 cases)\n3. Incomplete location details (2 cases)\n\nRecommendation: Update intake form to require signature field.",
      durationMs: 8100,
      tokensInput: 890,
      tokensOutput: 520,
    },
  ];

  for (const run of SAMPLE_RUNS) {
    const costUsd = (run.tokensInput / 1_000_000) * 3.0 + (run.tokensOutput / 1_000_000) * 15.0;
    await db.insert(agentRuns).values({
      companyId,
      agentId,
      status: "completed",
      input: { text: run.input },
      output: run.output,
      model: "claude-sonnet-4-6",
      tokensInput: run.tokensInput,
      tokensOutput: run.tokensOutput,
      costUsd: String(costUsd.toFixed(6)),
      durationMs: run.durationMs,
      startedAt: new Date(Date.now() - 86400000), // yesterday
      completedAt: new Date(Date.now() - 86400000 + run.durationMs),
    });
  }
  console.log(`  [created] 3 agent runs for ${agentId}`);
}

async function seedIncident(companyId: string, departmentId: string) {
  const existing = await db.query.incidents.findMany({
    where: and(
      eq(incidents.companyId, companyId),
      eq(incidents.status, "open"),
    ),
  });
  if (existing.length > 0) {
    console.log(`  [exists] Open incident for company`);
    return;
  }

  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.floor(1000 + Math.random() * 9000);

  await db.insert(incidents).values({
    companyId,
    departmentId,
    title: "Agent response latency spike detected",
    description: "Dispatch agent average response time increased from 3s to 45s at 14:32 UTC. Root cause under investigation. 3 jobs delayed.",
    severity: "high",
    status: "open",
    incidentId: `INC-${ymd}-${rand}`,
    attachmentsRef: [],
  });
  console.log(`  [created] Open incident`);
}

async function seedAuditLogs(companyId: string, actorId: string, agentId: string) {
  const existing = await db.query.auditLogs.findMany({
    where: eq(auditLogs.companyId, companyId),
  });
  if (existing.length >= 10) {
    console.log(`  [exists] Audit logs for company`);
    return;
  }

  const AUDIT_ENTRIES = [
    { action: "user.login", resourceType: "user", riskLevel: "low" as const },
    { action: "agent.created", resourceType: "agent", riskLevel: "low" as const },
    { action: "skill.created", resourceType: "skill", riskLevel: "low" as const },
    { action: "agent.deployed", resourceType: "agent", riskLevel: "medium" as const },
    { action: "agent.run.started", resourceType: "agent_run", riskLevel: "low" as const },
    { action: "agent.run.completed", resourceType: "agent_run", riskLevel: "low" as const },
    { action: "agent.run.started", resourceType: "agent_run", riskLevel: "low" as const },
    { action: "agent.run.completed", resourceType: "agent_run", riskLevel: "low" as const },
    { action: "incident.created", resourceType: "incident", riskLevel: "medium" as const },
    { action: "agent.stopped", resourceType: "agent", riskLevel: "medium" as const },
  ];

  let prevHash = "0".repeat(64);
  for (const entry of AUDIT_ENTRIES) {
    const entryData = JSON.stringify({ ...entry, companyId, timestamp: new Date().toISOString() });
    const entryHash = crypto.createHash("sha256").update(prevHash + entryData).digest("hex");

    await db.insert(auditLogs).values({
      companyId,
      actorType: "user",
      actorId,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: agentId,
      outcome: "success",
      riskLevel: entry.riskLevel,
      context: { demo: true },
      entryHash,
      prevHash,
    });

    prevHash = entryHash;
  }
  console.log(`  [created] 10 audit log entries`);
}

async function seedTenant(tenant: typeof TENANTS[0]) {
  console.log(`\nSeeding tenant: ${tenant.displayName}`);

  const company = await getOrCreateCompany(tenant);
  const adminUser = await getOrCreateUser(
    company.id,
    tenant.adminEmail,
    `${tenant.displayName} Admin`,
    "customer_admin",
  );
  await getOrCreateUser(
    company.id,
    tenant.viewerEmail,
    `${tenant.displayName} Viewer`,
    "customer_user",
  );

  const dept = await getOrCreateDepartment(company.id, "Operations");

  const dispatchSkill = await getOrCreateSkill(
    company.id,
    "dispatch-coordination",
    "Dispatch coordination and job routing",
    "Extract job type, location, and priority from incoming requests. Confirm bookings and route to appropriate teams. Always verify all required information before dispatching.",
  );

  // 1 active agent, 1 paused agent
  const activeAgent = await getOrCreateAgent(
    company.id,
    dept.id,
    `${tenant.displayName} Dispatch Agent`,
    "dispatch",
    "active",
  );

  await getOrCreateAgent(
    company.id,
    dept.id,
    `${tenant.displayName} Backup Agent`,
    "dispatch",
    "paused",
  );

  await seedAgentRuns(company.id, activeAgent.id);
  await seedIncident(company.id, dept.id);
  await seedAuditLogs(company.id, adminUser.id, activeAgent.id);
}

async function main() {
  console.log("Starting demo seed...");

  for (const tenant of TENANTS) {
    await seedTenant(tenant);
  }

  console.log("\nDemo seed complete.");
  console.log("\nLogin credentials:");
  for (const t of TENANTS) {
    console.log(`  ${t.adminEmail} / ${DEMO_PASSWORD}  (admin)`);
    console.log(`  ${t.viewerEmail} / ${DEMO_PASSWORD}  (viewer)`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
