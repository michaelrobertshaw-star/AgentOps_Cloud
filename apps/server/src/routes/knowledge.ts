/**
 * Knowledge Management Routes
 *
 * POST   /api/agents/:agentId/knowledge        — ingest text into RAG store
 * GET    /api/agents/:agentId/knowledge        — list knowledge metadata
 * DELETE /api/agents/:agentId/knowledge        — clear all knowledge for agent
 */

import { Router } from "express";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { agents, connectors, agentConnectors } from "@agentops/db";
import { authenticate } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import { validate } from "../middleware/validate.js";
import { getDb } from "../lib/db.js";
import { NotFoundError } from "../lib/errors.js";
import { ingestText, listAgentKnowledge, deleteAgentKnowledge } from "../services/ragService.js";

const ingestSchema = z.object({
  text: z.string().min(10, "Text must be at least 10 characters").max(500_000),
  sourceName: z.string().max(200).optional().default("manual"),
});

export function knowledgeRoutes() {
  const router = Router({ mergeParams: true });

  // POST /api/agents/:agentId/knowledge
  router.post(
    "/",
    authenticate(),
    requirePermission("agent:manage"),
    validate(ingestSchema),
    async (req, res, next) => {
      const agentId = req.params.agentId as string;
      const companyId = req.companyId!;
      const db = getDb();

      try {
        const agent = await db.query.agents.findFirst({
          where: and(eq(agents.id, agentId), eq(agents.companyId, companyId)),
        });
        if (!agent) throw new NotFoundError("Agent");

        const { text, sourceName } = req.body as z.infer<typeof ingestSchema>;
        const result = await ingestText(agentId, companyId, text, {
          source_name: sourceName,
        });

        res.status(201).json({
          chunksCreated: result.chunksCreated,
          message: `Ingested ${result.chunksCreated} chunks`,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/agents/:agentId/knowledge/pdf — ingest PDF document
  router.post(
    "/pdf",
    authenticate(),
    requirePermission("agent:manage"),
    async (req, res, next) => {
      const agentId = req.params.agentId as string;
      const companyId = req.companyId!;
      const db = getDb();

      try {
        const agent = await db.query.agents.findFirst({
          where: and(eq(agents.id, agentId), eq(agents.companyId, companyId)),
        });
        if (!agent) throw new NotFoundError("Agent");

        // Read raw body as buffer
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        }
        const pdfBuffer = Buffer.concat(chunks);

        if (pdfBuffer.length === 0) {
          return res.status(400).json({ error: "No PDF data received" });
        }

        const fileName = (req.headers["x-filename"] as string) || "upload.pdf";
        const { ingestPdfForAgent } = await import("../services/dataSourceService.js");
        const result = await ingestPdfForAgent(agentId, companyId, pdfBuffer, fileName);

        res.status(201).json({
          chunksCreated: result.chunksCreated,
          textLength: result.text.length,
          message: `Ingested PDF "${fileName}": ${result.chunksCreated} chunks from ${result.text.length} chars`,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/agents/:agentId/knowledge
  router.get(
    "/",
    authenticate(),
    requirePermission("agent:view"),
    async (req, res, next) => {
      const agentId = req.params.agentId as string;
      const companyId = req.companyId!;
      const db = getDb();

      try {
        const agent = await db.query.agents.findFirst({
          where: and(eq(agents.id, agentId), eq(agents.companyId, companyId)),
        });
        if (!agent) throw new NotFoundError("Agent");

        const chunks = await listAgentKnowledge(agentId, companyId);
        res.json(chunks);
      } catch (err) {
        next(err);
      }
    },
  );

  // DELETE /api/agents/:agentId/knowledge
  router.delete(
    "/",
    authenticate(),
    requirePermission("agent:manage"),
    async (req, res, next) => {
      const agentId = req.params.agentId as string;
      const companyId = req.companyId!;
      const db = getDb();

      try {
        const agent = await db.query.agents.findFirst({
          where: and(eq(agents.id, agentId), eq(agents.companyId, companyId)),
        });
        if (!agent) throw new NotFoundError("Agent");

        const deleted = await deleteAgentKnowledge(agentId, companyId);
        res.json({ deleted, message: `Cleared ${deleted} knowledge chunks` });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/agents/:agentId/knowledge/query — execute read-only query against postgres_db connector
  router.post(
    "/query",
    authenticate(),
    requirePermission("agent:manage"),
    async (req, res, next) => {
      const agentId = req.params.agentId as string;
      const companyId = req.companyId!;
      const db = getDb();

      try {
        const agent = await db.query.agents.findFirst({
          where: and(eq(agents.id, agentId), eq(agents.companyId, companyId)),
        });
        if (!agent) throw new NotFoundError("Agent");

        const { query, connectorId, ingestResult } = req.body as {
          query: string;
          connectorId: string;
          ingestResult?: boolean;
        };

        if (!query || !connectorId) {
          return res.status(400).json({ error: "query and connectorId are required" });
        }

        // Load the connector and verify it belongs to this company + is postgres_db type
        const { loadAgentConnectorSecrets } = await import("./connectors.js");
        const connectorData = await loadAgentConnectorSecrets(agentId, companyId);
        const pgConn = connectorData.find(
          (c) => c.connector.id === connectorId && c.connector.type === "postgres_db",
        );

        if (!pgConn) {
          return res.status(400).json({ error: "No matching postgres_db connector found for this agent" });
        }

        const connectionString = pgConn.secrets.connection_string;
        if (!connectionString) {
          return res.status(400).json({ error: "Connector is missing connection_string secret" });
        }

        const { executePostgresQuery, formatQueryResultAsContext } = await import(
          "../services/dataSourceService.js"
        );

        const result = await executePostgresQuery(connectionString, query);

        // Optionally ingest the result as knowledge
        if (ingestResult && result.rowCount > 0) {
          const contextText = formatQueryResultAsContext(
            result,
            (pgConn.connector.config as Record<string, string>).database_name ?? "external-db",
          );
          await ingestText(agentId, companyId, contextText, {
            source_name: "postgres_query",
            source_type: "database",
            query,
          });
        }

        res.json({
          rows: result.rows,
          rowCount: result.rowCount,
          fields: result.fields,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
