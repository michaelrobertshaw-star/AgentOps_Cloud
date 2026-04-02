/**
 * Agent Memories Routes — Shared learning system
 *
 * Routes:
 *   GET    /api/memories           — List all memories for company (optional ?category, ?agent_id, ?tag filters)
 *   POST   /api/memories           — Create a memory
 *   PATCH  /api/memories/:id       — Update a memory
 *   DELETE /api/memories/:id       — Delete a memory
 *   POST   /api/memories/:id/upvote — Upvote a memory (mark as helpful)
 *   GET    /api/memories/brain     — Get all memories as context for agent system prompt injection
 */

import { Router } from "express";
import { z } from "zod";
import { sql, type SQL } from "drizzle-orm";
import { authenticate } from "../middleware/auth.js";
import { getDb } from "../lib/db.js";

const router = Router();

const createMemorySchema = z.object({
  agentId: z.string().uuid().optional(),
  category: z.enum(["learning", "error_fix", "tool_tip", "prompt_pattern", "api_quirk", "general"]),
  title: z.string().min(3).max(255),
  content: z.string().min(10),
  source: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const updateMemorySchema = z.object({
  title: z.string().min(3).max(255).optional(),
  content: z.string().min(10).optional(),
  category: z.enum(["learning", "error_fix", "tool_tip", "prompt_pattern", "api_quirk", "general"]).optional(),
  tags: z.array(z.string()).optional(),
});

// GET /api/memories — list memories
router.get("/", authenticate(), async (req, res, next) => {
  try {
    const db = getDb();
    const companyId = req.companyId!;
    const { category, agent_id, tag } = req.query;

    const filters: SQL[] = [sql`m.company_id = ${companyId}`];

    if (category && typeof category === "string") {
      filters.push(sql`m.category = ${category}`);
    }
    if (agent_id && typeof agent_id === "string") {
      filters.push(sql`m.agent_id = ${agent_id}`);
    }
    if (tag && typeof tag === "string") {
      filters.push(sql`${tag} = ANY(m.tags)`);
    }

    const whereClause = sql.join(filters, sql` AND `);

    const result = await db.execute(sql`
      SELECT m.*, a.name as agent_name
      FROM agent_memories m
      LEFT JOIN agents a ON a.id = m.agent_id
      WHERE ${whereClause}
      ORDER BY m.upvotes DESC, m.created_at DESC LIMIT 200
    `);
    const rows = (result as unknown as { rows: unknown[] }).rows ?? result;
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/memories — create memory
router.post("/", authenticate(), async (req, res, next) => {
  try {
    const db = getDb();
    const companyId = req.companyId!;
    const body = createMemorySchema.parse(req.body);

    // Deduplication: reject if exact title already exists for this company
    const existing = await db.execute(sql`
      SELECT id FROM agent_memories
      WHERE company_id = ${companyId} AND LOWER(title) = LOWER(${body.title})
      LIMIT 1
    `);
    const existingRows = (existing as unknown as { rows: unknown[] }).rows ?? existing;
    if (Array.isArray(existingRows) && existingRows.length > 0) {
      return res.status(409).json({ error: "A memory with this title already exists", duplicate: true });
    }

    const result = await db.execute(sql`
      INSERT INTO agent_memories (company_id, agent_id, category, title, content, source, tags)
      VALUES (${companyId}, ${body.agentId ?? null}, ${body.category}, ${body.title}, ${body.content}, ${body.source ?? "manual"}, ${body.tags ?? []})
      RETURNING *
    `);
    const rows = (result as unknown as { rows: unknown[] }).rows ?? result;
    res.status(201).json(rows[0] ?? result);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/memories/:id — update memory
router.patch("/:id", authenticate(), async (req, res, next) => {
  try {
    const db = getDb();
    const companyId = req.companyId!;
    const body = updateMemorySchema.parse(req.body);
    const { id } = req.params;

    const setClauses: SQL[] = [];

    if (body.title) setClauses.push(sql`title = ${body.title}`);
    if (body.content) setClauses.push(sql`content = ${body.content}`);
    if (body.category) setClauses.push(sql`category = ${body.category}`);
    if (body.tags) setClauses.push(sql`tags = ${JSON.stringify(body.tags)}`);
    setClauses.push(sql`updated_at = now()`);

    if (setClauses.length <= 1) return res.status(400).json({ error: "No fields to update" });

    const setFragment = sql.join(setClauses, sql`, `);
    const result = await db.execute(sql`UPDATE agent_memories SET ${setFragment} WHERE id = ${id} AND company_id = ${companyId} RETURNING *`);
    const rows = (result as unknown as { rows: unknown[] }).rows ?? result;
    if (!rows || (Array.isArray(rows) && rows.length === 0)) {
      return res.status(404).json({ error: "Memory not found" });
    }
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/memories/:id
router.delete("/:id", authenticate(), async (req, res, next) => {
  try {
    const db = getDb();
    const companyId = req.companyId!;
    await db.execute(sql`DELETE FROM agent_memories WHERE id = ${req.params.id} AND company_id = ${companyId}`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/memories/:id/upvote
router.post("/:id/upvote", authenticate(), async (req, res, next) => {
  try {
    const db = getDb();
    const companyId = req.companyId!;
    const result = await db.execute(sql`
      UPDATE agent_memories SET upvotes = upvotes + 1, updated_at = now()
      WHERE id = ${req.params.id} AND company_id = ${companyId}
      RETURNING *
    `);
    const rows = (result as unknown as { rows: unknown[] }).rows ?? result;
    res.json(rows[0] ?? { ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/memories/brain — get memories formatted for agent system prompt injection
router.get("/brain", authenticate(), async (req, res, next) => {
  try {
    const db = getDb();
    const companyId = req.companyId!;

    const result = await db.execute(sql`
      SELECT category, title, content, tags, upvotes
      FROM agent_memories
      WHERE company_id = ${companyId}
      ORDER BY upvotes DESC, created_at DESC
      LIMIT 50
    `);
    const rows = (result as unknown as { rows: Array<{ category: string; title: string; content: string; tags: string[]; upvotes: number }> }).rows ?? result;

    // Format as readable text for injection into system prompt
    let brain = "";
    if (Array.isArray(rows) && rows.length > 0) {
      brain = "\n\n## Shared Agent Memory (learnings from all agents)\n";
      for (const m of rows) {
        const tags = Array.isArray(m.tags) && m.tags.length > 0 ? ` [${m.tags.join(", ")}]` : "";
        const votes = m.upvotes > 0 ? ` (${m.upvotes} upvotes)` : "";
        brain += `\n### ${m.title}${tags}${votes}\n${m.content}\n`;
      }
    }

    res.json({ text: brain, count: Array.isArray(rows) ? rows.length : 0 });
  } catch (err) {
    next(err);
  }
});

export default router;
