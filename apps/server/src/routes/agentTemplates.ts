/**
 * Agent Templates Routes
 *
 * GET  /api/agent-templates            — list templates (built-ins + company templates)
 * GET  /api/agent-templates/:id        — single template
 * POST /api/agent-templates/:id/instantiate — create agent from template
 * POST /api/agent-templates            — create/upsert template (admin)
 */

import { Router } from "express";
import { z } from "zod";
import { eq, or, isNull, and, sql } from "drizzle-orm";
import { agentTemplates, agents, skills, agentSkills, templateInstalls } from "@agentops/db";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { validate } from "../middleware/validate.js";
import { getDb } from "../lib/db.js";
import { NotFoundError } from "../lib/errors.js";

const instantiateSchema = z.object({
  name: z.string().min(1).max(100),
  departmentId: z.string().uuid().optional(),
  configOverrides: z.record(z.unknown()).optional().default({}),
});

const upsertTemplateSchema = z.object({
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  tier: z.enum(["simple", "rag", "autonomous", "enterprise"]).default("simple"),
  layerConfig: z.object({
    infrastructure: z.string().optional(),
    model: z.string().optional(),
    data: z.array(z.string()).optional().default([]),
    orchestration: z.array(z.string()).optional().default([]),
    application: z.string().optional(),
  }).default({}),
  defaultAgentConfig: z.record(z.unknown()).default({}),
  isBuiltIn: z.boolean().optional().default(false),
});

export function agentTemplateRoutes() {
  const router = Router();

  // GET /api/agent-templates
  router.get("/", authenticate(), requirePermission("agent:view"), async (req, res, next) => {
    const companyId = req.companyId!;
    const db = getDb();
    const tier = req.query.tier as string | undefined;

    try {
      const conditions = [
        or(eq(agentTemplates.companyId, companyId), isNull(agentTemplates.companyId)),
        eq(agentTemplates.isActive, true),
      ];

      const rows = await db.query.agentTemplates.findMany({
        where: and(...conditions),
        orderBy: (t, { asc }) => [asc(t.tier), asc(t.name)],
      });

      const filtered = tier ? rows.filter((t) => t.tier === tier) : rows;
      res.json(filtered);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/agent-templates/generate — AI-generated template from description
  router.post(
    "/generate",
    authenticate(),
    requirePermission("agent:create"),
    async (req, res, next) => {
      try {
        const { description } = req.body as { description?: string };
        if (!description || description.trim().length < 10) {
          return res
            .status(400)
            .json({
              error: {
                code: "VALIDATION_ERROR",
                message: "Description must be at least 10 characters",
              },
            });
        }

        const { generateTemplate } = await import(
          "../services/templateGenerator.js"
        );
        const template = await generateTemplate(description.trim(), req.companyId);

        // Optionally save if requested
        if (req.body.save) {
          const companyId = req.companyId!;
          const db = getDb();
          const slug = template.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/(^-|-$)/g, "");

          const [saved] = await db
            .insert(agentTemplates)
            .values({
              companyId,
              slug: `${slug}-${Date.now()}`,
              name: template.name,
              description: template.description,
              tier: template.tier,
              layerConfig: template.layerConfig,
              defaultAgentConfig: template.defaultAgentConfig,
            })
            .returning();

          return res.status(201).json({ template, saved });
        }

        res.json({ template });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/agent-templates/marketplace — list public templates from all companies
  router.get("/marketplace", authenticate(), requirePermission("agent:view"), async (req, res, next) => {
    const companyId = req.companyId!;
    const db = getDb();
    const tier = req.query.tier as string | undefined;
    const search = req.query.search as string | undefined;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, parseInt(req.query.limit as string) || 20);
    const offset = (page - 1) * limit;

    try {
      const rows = await db
        .select()
        .from(agentTemplates)
        .where(
          and(
            eq(agentTemplates.visibility, "public"),
            sql`${agentTemplates.companyId} != ${companyId}`,
            eq(agentTemplates.isActive, true),
          )
        )
        .orderBy(sql`${agentTemplates.installCount} DESC`)
        .limit(limit)
        .offset(offset);

      let filtered = tier ? rows.filter((t) => t.tier === tier) : rows;

      if (search) {
        const searchLower = search.toLowerCase();
        filtered = filtered.filter((t) =>
          t.name.toLowerCase().includes(searchLower) ||
          (t.description ?? "").toLowerCase().includes(searchLower)
        );
      }

      res.json({ templates: filtered, page, limit });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/agent-templates/:id
  router.get("/:id", authenticate(), requirePermission("agent:view"), async (req, res, next) => {
    const companyId = req.companyId!;
    const db = getDb();

    try {
      const template = await db.query.agentTemplates.findFirst({
        where: and(
          eq(agentTemplates.id, req.params.id as string),
          or(eq(agentTemplates.companyId, companyId), isNull(agentTemplates.companyId)),
        ),
      });
      if (!template) throw new NotFoundError("AgentTemplate");
      res.json(template);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/agent-templates/:id/instantiate
  router.post(
    "/:id/instantiate",
    authenticate(),
    requirePermission("agent:create"),
    validate(instantiateSchema),
    async (req, res, next) => {
      const companyId = req.companyId!;
      const db = getDb();
      const { name, departmentId, configOverrides } = req.body as z.infer<typeof instantiateSchema>;

      try {
        // Load template
        const template = await db.query.agentTemplates.findFirst({
          where: and(
            eq(agentTemplates.id, req.params.id as string),
            or(eq(agentTemplates.companyId, companyId), isNull(agentTemplates.companyId)),
          ),
        });
        if (!template) throw new NotFoundError("AgentTemplate");

        const defaultConfig = (template.defaultAgentConfig as Record<string, unknown>) ?? {};
        const layerConfig = (template.layerConfig as Record<string, unknown>) ?? {};

        // Build agent config
        const agentConfig: Record<string, unknown> = {
          ...defaultConfig,
          ...configOverrides,
          source_template_id: template.id,
          layer_selections: layerConfig,
        };

        // Create agent
        const [agent] = await db
          .insert(agents)
          .values({
            companyId,
            departmentId: departmentId ?? null,
            name,
            type: typeof agentConfig.type === "string" ? agentConfig.type : "worker",
            description: typeof agentConfig.description === "string"
              ? agentConfig.description
              : (template.description ?? null),
            config: agentConfig,
            capabilities: Array.isArray(agentConfig.capabilities)
              ? (agentConfig.capabilities as string[])
              : [],
          })
          .returning();

        // Assign orchestration skills from template.layerConfig.orchestration[]
        const orchestrationSlugs = (layerConfig.orchestration as string[]) ?? [];
        const assignedSkills: string[] = [];
        const warnings: string[] = [];

        for (const skillSlug of orchestrationSlugs) {
          const skill = await db.query.skills.findFirst({
            where: and(
              eq(skills.companyId, companyId),
              eq(skills.name, skillSlug),
            ),
          });

          if (skill) {
            await db.insert(agentSkills).values({
              agentId: agent.id,
              skillId: skill.id,
              companyId,
            }).onConflictDoNothing();
            assignedSkills.push(skill.name);
          } else {
            warnings.push(`Skill "${skillSlug}" not found in company — skipped`);
          }
        }

        // Increment template use_count
        await db
          .update(agentTemplates)
          .set({ useCount: template.useCount + 1, updatedAt: new Date() })
          .where(eq(agentTemplates.id, template.id));

        res.status(201).json({
          agent,
          assignedSkills,
          warnings,
          templateUsed: template.slug,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/agent-templates/:id/publish — publish template to marketplace
  router.post("/:id/publish", authenticate(), requirePermission("agent:manage"), async (req, res, next) => {
    const companyId = req.companyId!;
    const db = getDb();
    const { tags } = req.body as { tags?: string[] };

    try {
      const template = await db.query.agentTemplates.findFirst({
        where: and(
          eq(agentTemplates.id, req.params.id as string),
          eq(agentTemplates.companyId, companyId),
        ),
      });
      if (!template) throw new NotFoundError("AgentTemplate");

      if (!template.name || !template.description) {
        return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Template must have a name and description to publish" } });
      }

      const [updated] = await db
        .update(agentTemplates)
        .set({
          visibility: "public",
          publishedAt: new Date(),
          publishedByCompanyId: companyId,
          tags: tags ?? [],
          updatedAt: new Date(),
        })
        .where(eq(agentTemplates.id, template.id))
        .returning();

      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/agent-templates/:id/unpublish — remove template from marketplace
  router.post("/:id/unpublish", authenticate(), requirePermission("agent:manage"), async (req, res, next) => {
    const companyId = req.companyId!;
    const db = getDb();

    try {
      const template = await db.query.agentTemplates.findFirst({
        where: and(
          eq(agentTemplates.id, req.params.id as string),
          eq(agentTemplates.companyId, companyId),
        ),
      });
      if (!template) throw new NotFoundError("AgentTemplate");

      const [updated] = await db
        .update(agentTemplates)
        .set({
          visibility: "private",
          publishedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(agentTemplates.id, template.id))
        .returning();

      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/agent-templates/:id/install — install a marketplace template
  router.post("/:id/install", authenticate(), requirePermission("agent:create"), async (req, res, next) => {
    const companyId = req.companyId!;
    const userId = req.userId!;
    const db = getDb();

    try {
      const template = await db.query.agentTemplates.findFirst({
        where: and(
          eq(agentTemplates.id, req.params.id as string),
          or(
            eq(agentTemplates.visibility, "public"),
            eq(agentTemplates.visibility, "unlisted"),
          ),
        ),
      });
      if (!template) throw new NotFoundError("AgentTemplate");

      const slug = `${template.slug}-installed-${Date.now()}`;
      const [installed] = await db
        .insert(agentTemplates)
        .values({
          companyId,
          slug,
          name: template.name,
          description: template.description,
          tier: template.tier,
          layerConfig: template.layerConfig,
          defaultAgentConfig: template.defaultAgentConfig,
          isBuiltIn: false,
          tags: template.tags ?? [],
        })
        .returning();

      await db
        .insert(templateInstalls)
        .values({
          companyId,
          templateId: template.id,
          installedByUserId: userId,
        })
        .onConflictDoNothing();

      await db
        .update(agentTemplates)
        .set({
          installCount: (template.installCount ?? 0) + 1,
          updatedAt: new Date(),
        })
        .where(eq(agentTemplates.id, template.id));

      res.status(201).json({ installed, sourceTemplate: template.slug });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/agent-templates (admin only — upsert built-in templates)
  router.post(
    "/",
    authenticate(),
    requirePermission("agent:manage"),
    validate(upsertTemplateSchema),
    async (req, res, next) => {
      const companyId = req.companyId!;
      const db = getDb();
      const body = req.body as z.infer<typeof upsertTemplateSchema>;

      try {
        const [template] = await db
          .insert(agentTemplates)
          .values({
            companyId: body.isBuiltIn ? null : companyId,
            slug: body.slug,
            name: body.name,
            description: body.description ?? null,
            tier: body.tier,
            layerConfig: body.layerConfig,
            defaultAgentConfig: body.defaultAgentConfig,
            isBuiltIn: body.isBuiltIn,
          })
          .onConflictDoUpdate({
            target: [agentTemplates.slug],
            set: {
              name: body.name,
              description: body.description ?? null,
              tier: body.tier,
              layerConfig: body.layerConfig,
              defaultAgentConfig: body.defaultAgentConfig,
              updatedAt: new Date(),
            },
          })
          .returning();

        res.status(201).json(template);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
