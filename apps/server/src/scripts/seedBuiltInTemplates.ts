/**
 * Seed Built-in Agent Templates + Orchestration Skills
 *
 * Run with: pnpm --filter @agentops/server tsx src/scripts/seedBuiltInTemplates.ts
 *
 * Idempotent — safe to run multiple times.
 * Creates 4 built-in templates and 3 orchestration skills for the demo company.
 */

import "dotenv/config";
import { createDatabase, agentTemplates, skills, companies } from "@agentops/db";
import { eq } from "drizzle-orm";

const ORCHESTRATION_SKILLS = [
  {
    name: "simple-loop",
    description: "Direct answer orchestration — answer the question in one step.",
    content: {
      instructions: "Answer the user's question directly and clearly. Be concise and accurate.",
      layer: "orchestration",
      orchestration_type: "simple",
    },
  },
  {
    name: "rag-loop",
    description: "RAG orchestration — use retrieved knowledge to answer questions.",
    content: {
      instructions: `You will be given relevant knowledge context below your system prompt.
Use that context to answer the user's question.
- Prioritise information from the provided context
- If context contains relevant data, cite specific facts
- If context doesn't cover the question, say so clearly and use your general knowledge
- Keep answers accurate and grounded`,
      layer: "orchestration",
      orchestration_type: "rag",
    },
  },
  {
    name: "review-loop",
    description: "Review-loop orchestration — draft, verify, then deliver final answer.",
    content: {
      instructions: `Follow this process for every response:
Step 1 — DRAFT: Write an initial answer to the user's question.
Step 2 — REVIEW: Check your draft for accuracy, completeness, and clarity.
Step 3 — DELIVER: Output your final, reviewed answer.

Format your response as:
[Final Answer]
<your reviewed answer here>`,
      layer: "orchestration",
      orchestration_type: "review",
    },
  },
];

const BUILT_IN_TEMPLATES = [
  {
    slug: "simple-assistant",
    name: "Simple Assistant",
    description: "A direct, no-frills AI assistant. No data retrieval — just ask questions and get answers.",
    tier: "simple",
    layerConfig: {
      infrastructure: "claude_api",
      model: "",
      data: [],
      orchestration: ["simple-loop"],
      application: "worker",
    },
    defaultAgentConfig: {
      type: "worker",
      routing_policy: null,
      rag_enabled: false,
      capabilities: ["text-generation", "question-answering"],
      description: "A direct AI assistant that answers questions using its trained knowledge.",
    },
  },
  {
    slug: "rag-analyst",
    name: "RAG Analyst",
    description: "Knowledge-grounded analyst. Attach your documents and data — answers are drawn from your content.",
    tier: "rag",
    layerConfig: {
      infrastructure: "claude_api",
      model: "",
      data: ["vector_db"],
      orchestration: ["rag-loop"],
      application: "worker",
    },
    defaultAgentConfig: {
      type: "worker",
      routing_policy: "accuracy_first",
      rag_enabled: true,
      capabilities: ["text-generation", "retrieval-augmented-generation", "document-analysis"],
      description: "An analyst that answers questions using your uploaded knowledge base. Add documents via the Knowledge tab.",
    },
  },
  {
    slug: "autonomous-agent",
    name: "Autonomous Agent",
    description: "Full-stack agent with self-review loop. Drafts, checks, and delivers high-quality responses.",
    tier: "autonomous",
    layerConfig: {
      infrastructure: "claude_api",
      model: "",
      data: ["vector_db"],
      orchestration: ["rag-loop", "review-loop"],
      application: "worker",
    },
    defaultAgentConfig: {
      type: "worker",
      routing_policy: null,
      rag_enabled: true,
      capabilities: ["text-generation", "retrieval-augmented-generation", "self-review", "multi-step-reasoning"],
      description: "An autonomous agent that uses your knowledge base and reviews its own answers before delivering them.",
    },
  },
  {
    slug: "enterprise-ops",
    name: "Enterprise Operations",
    description: "Cost-optimised enterprise agent with full RAG, review loop, and audit trail.",
    tier: "enterprise",
    layerConfig: {
      infrastructure: "claude_api",
      model: "",
      data: ["vector_db"],
      orchestration: ["rag-loop", "review-loop"],
      application: "worker",
    },
    defaultAgentConfig: {
      type: "worker",
      routing_policy: "cost_sensitive",
      rag_enabled: true,
      capabilities: ["text-generation", "retrieval-augmented-generation", "self-review", "cost-optimised"],
      description: "A cost-optimised enterprise agent with full RAG retrieval and output review. Ideal for high-volume operations.",
    },
  },
];

async function main() {
  const db = createDatabase(process.env.DATABASE_URL);

  // Get all companies to seed orchestration skills for each
  const allCompanies = await db.select({ id: companies.id, name: companies.name }).from(companies);
  console.log(`Found ${allCompanies.length} companies`);

  // Seed orchestration skills for each company
  for (const company of allCompanies) {
    console.log(`\nSeeding orchestration skills for company: ${company.name} (${company.id})`);
    for (const skill of ORCHESTRATION_SKILLS) {
      const existing = await db.query.skills.findFirst({
        where: eq(skills.name, skill.name),
      });
      if (!existing || existing.companyId !== company.id) {
        await db
          .insert(skills)
          .values({
            companyId: company.id,
            name: skill.name,
            description: skill.description,
            content: skill.content,
          })
          .onConflictDoNothing();
        console.log(`  Created skill: ${skill.name}`);
      } else {
        console.log(`  Skill exists: ${skill.name}`);
      }
    }
  }

  // Seed built-in templates (company_id = NULL = visible to all)
  console.log("\nSeeding built-in templates...");
  for (const template of BUILT_IN_TEMPLATES) {
    await db
      .insert(agentTemplates)
      .values({
        companyId: null,
        slug: template.slug,
        name: template.name,
        description: template.description,
        tier: template.tier as "simple" | "rag" | "autonomous" | "enterprise",
        layerConfig: template.layerConfig,
        defaultAgentConfig: template.defaultAgentConfig,
        isBuiltIn: true,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: [agentTemplates.slug],
        set: {
          name: template.name,
          description: template.description,
          tier: template.tier as "simple" | "rag" | "autonomous" | "enterprise",
          layerConfig: template.layerConfig,
          defaultAgentConfig: template.defaultAgentConfig,
          updatedAt: new Date(),
        },
      });
    console.log(`  Upserted template: ${template.slug}`);
  }

  console.log("\nSeed complete.");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
