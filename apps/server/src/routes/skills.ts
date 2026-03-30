/**
 * M6.2 — Skill File Builder
 *
 * CRUD for skill definitions (YAML-based persona/instructions/tools/constraints).
 * Skills are assigned to agents via agent_skills junction table.
 */

import { Router } from "express";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { skills, agentSkills, agents } from "@agentops/db";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { validate } from "../middleware/validate.js";
import { getDb } from "../lib/db.js";
import { NotFoundError } from "../lib/errors.js";

// ================================================================
// Validation schemas
// ================================================================

const createSkillSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(1000).optional(),
  content: z.record(z.unknown()).optional().default({}),
});

const updateSkillSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(1000).optional(),
  content: z.record(z.unknown()).optional(),
});

// ================================================================
// Skill routes: /api/skills
// ================================================================

export function skillRoutes() {
  const router = Router();

  // GET /api/skills — list skills for the authenticated company
  router.get("/", authenticate(), requirePermission("agent:view"), async (req, res, next) => {
    try {
      const db = getDb();
      const rows = await db.query.skills.findMany({
        where: eq(skills.companyId, req.companyId!),
        orderBy: (s, { asc }) => [asc(s.name)],
      });
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/skills — create a skill
  router.post(
    "/",
    authenticate(),
    requirePermission("agent:manage"),
    validate(createSkillSchema),
    async (req, res, next) => {
      try {
        const db = getDb();
        const { name, description, content } = req.body as z.infer<typeof createSkillSchema>;

        const [skill] = await db
          .insert(skills)
          .values({
            companyId: req.companyId!,
            name,
            description,
            content: content ?? {},
          })
          .returning();

        res.status(201).json(skill);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/skills/:id — get a skill with its assigned agents
  router.get("/:id", authenticate(), requirePermission("agent:view"), async (req, res, next) => {
    try {
      const db = getDb();
      const skill = await db.query.skills.findFirst({
        where: and(
          eq(skills.id, req.params.id as string),
          eq(skills.companyId, req.companyId!),
        ),
      });
      if (!skill) throw new NotFoundError("Skill");

      // Include assigned agents
      const assignments = await db.query.agentSkills.findMany({
        where: eq(agentSkills.skillId, skill.id),
        with: { agent: true },
      });

      res.json({
        ...skill,
        assignedAgents: assignments.map((a) => ({
          id: a.agent.id,
          name: a.agent.name,
          status: a.agent.status,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/skills/:id — update a skill (increments version)
  router.put(
    "/:id",
    authenticate(),
    requirePermission("agent:manage"),
    validate(updateSkillSchema),
    async (req, res, next) => {
      try {
        const db = getDb();
        const id = req.params.id as string;
        const existing = await db.query.skills.findFirst({
          where: and(
            eq(skills.id, id),
            eq(skills.companyId, req.companyId!),
          ),
        });
        if (!existing) throw new NotFoundError("Skill");

        const { name, description, content } = req.body as z.infer<typeof updateSkillSchema>;

        const [updated] = await db
          .update(skills)
          .set({
            ...(name !== undefined && { name }),
            ...(description !== undefined && { description }),
            ...(content !== undefined && { content }),
            version: existing.version + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(skills.id, id), eq(skills.companyId, req.companyId!)))
          .returning();

        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  // DELETE /api/skills/:id — delete a skill
  router.delete(
    "/:id",
    authenticate(),
    requirePermission("agent:manage"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const id = req.params.id as string;
        const existing = await db.query.skills.findFirst({
          where: and(
            eq(skills.id, id),
            eq(skills.companyId, req.companyId!),
          ),
        });
        if (!existing) throw new NotFoundError("Skill");

        await db
          .delete(skills)
          .where(and(eq(skills.id, id), eq(skills.companyId, req.companyId!)));

        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

// ================================================================
// Agent skill routes: /api/agents/:agentId/skills
// ================================================================

export function agentSkillRoutes() {
  const router = Router({ mergeParams: true });

  // GET /api/agents/:agentId/skills — list skills for an agent
  router.get(
    "/",
    authenticate(),
    requirePermission("agent:view"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const agentId = req.params.agentId as string;

        const agent = await db.query.agents.findFirst({
          where: and(eq(agents.id, agentId), eq(agents.companyId, req.companyId!)),
        });
        if (!agent) throw new NotFoundError("Agent");

        const rows = await db.query.agentSkills.findMany({
          where: eq(agentSkills.agentId, agentId),
          with: { skill: true },
        });

        res.json(rows.map((r) => r.skill));
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/agents/:agentId/skills — assign skill to agent
  router.post(
    "/",
    authenticate(),
    requirePermission("agent:manage"),
    validate(z.object({ skillId: z.string().uuid() })),
    async (req, res, next) => {
      try {
        const db = getDb();
        const agentId = req.params.agentId as string;

        const agent = await db.query.agents.findFirst({
          where: and(eq(agents.id, agentId), eq(agents.companyId, req.companyId!)),
        });
        if (!agent) throw new NotFoundError("Agent");

        const skill = await db.query.skills.findFirst({
          where: and(
            eq(skills.id, req.body.skillId),
            eq(skills.companyId, req.companyId!),
          ),
        });
        if (!skill) throw new NotFoundError("Skill");

        const [link] = await db
          .insert(agentSkills)
          .values({ companyId: req.companyId!, agentId, skillId: req.body.skillId })
          .onConflictDoNothing()
          .returning();

        res.status(201).json(link ?? { message: "Already assigned" });
      } catch (err) {
        next(err);
      }
    },
  );

  // DELETE /api/agents/:agentId/skills/:skillId — remove skill from agent
  router.delete(
    "/:skillId",
    authenticate(),
    requirePermission("agent:manage"),
    async (req, res, next) => {
      try {
        const db = getDb();
        const agentId = req.params.agentId as string;
        const skillId = req.params.skillId as string;

        const agent = await db.query.agents.findFirst({
          where: and(eq(agents.id, agentId), eq(agents.companyId, req.companyId!)),
        });
        if (!agent) throw new NotFoundError("Agent");

        await db
          .delete(agentSkills)
          .where(
            and(
              eq(agentSkills.agentId, agentId),
              eq(agentSkills.skillId, skillId),
            ),
          );

        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
