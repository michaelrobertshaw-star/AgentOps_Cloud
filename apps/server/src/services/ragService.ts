/**
 * RAG Service — embedding, ingestion, and retrieval for knowledge-augmented agents.
 *
 * Embedding priority:
 *   1. OpenAI text-embedding-3-small (if OPENAI_API_KEY set)
 *   2. Full-text search fallback (always available via tsvector)
 *
 * Retrieval returns top-K relevant text chunks for prompt injection.
 */

import { eq, and, sql } from "drizzle-orm";
import { getDb } from "../lib/db.js";
import { knowledgeChunks } from "@agentops/db";

const CHUNK_SIZE = 400;       // ~512 tokens at ~1.3 chars/token
const CHUNK_OVERLAP = 80;     // ~50 tokens overlap
const DEFAULT_TOP_K = 3;
const EMBED_MAX_RETRIES = 2;

// ── Text chunking ────────────────────────────────────────────────────────────

function chunkText(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let i = 0;
  while (i < words.length) {
    chunks.push(words.slice(i, i + size).join(" "));
    i += size - overlap;
  }
  return chunks.filter((c) => c.trim().length > 0);
}

// ── Embedding with retry ─────────────────────────────────────────────────────

async function embedTextOnce(text: string, apiKey: string): Promise<number[] | null> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text.slice(0, 8000),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Embedding API ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return data.data[0]?.embedding ?? null;
}

async function embedText(text: string): Promise<number[] | null> {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    console.log("[ragService] embed: no OPENAI_API_KEY, skipping vector embedding");
    return null;
  }

  for (let attempt = 1; attempt <= EMBED_MAX_RETRIES; attempt++) {
    try {
      const result = await embedTextOnce(text, openaiKey);
      if (attempt > 1) {
        console.log(`[ragService] embed: succeeded on retry ${attempt}`);
      }
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[ragService] embed: attempt ${attempt}/${EMBED_MAX_RETRIES} failed: ${msg}`);
      if (attempt < EMBED_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 500 * attempt)); // backoff
      }
    }
  }

  console.error(`[ragService] embed: all ${EMBED_MAX_RETRIES} attempts failed, proceeding without embedding`);
  return null;
}

// ── Cosine similarity (for in-memory fallback) ────────────────────────────────

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function ingestText(
  agentId: string,
  companyId: string,
  text: string,
  metadata: Record<string, unknown> = {},
): Promise<{ chunksCreated: number }> {
  const db = getDb();
  const chunks = chunkText(text);
  let created = 0;
  let embedded = 0;

  console.log(`[ragService] ingest: starting for agent=${agentId}, textLen=${text.length}, chunks=${chunks.length}`);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const embedding = await embedText(chunk);

    await db.insert(knowledgeChunks).values({
      agentId,
      companyId,
      content: chunk,
      embedding: embedding ? embedding : null,
      metadata: {
        ...metadata,
        chunk_index: i,
        total_chunks: chunks.length,
      },
    });
    created++;
    if (embedding) embedded++;
  }

  console.log(`[ragService] ingest: completed for agent=${agentId}, created=${created}, embedded=${embedded}`);
  return { chunksCreated: created };
}

export async function retrieveContext(
  agentId: string,
  companyId: string,
  query: string,
  topK = DEFAULT_TOP_K,
): Promise<string[]> {
  const db = getDb();
  const startMs = Date.now();

  console.log(`[ragService] retrieve: agent=${agentId}, query="${query.slice(0, 80)}...", topK=${topK}`);

  // Try vector similarity first
  const queryEmbedding = await embedText(query);
  const embedMs = Date.now() - startMs;

  if (queryEmbedding) {
    console.log(`[ragService] retrieve: embedding generated in ${embedMs}ms, trying vector search`);
    try {
      const result = await db.execute(sql`
        SELECT content, embedding
        FROM knowledge_chunks
        WHERE agent_id = ${agentId}
          AND company_id = ${companyId}
          AND embedding IS NOT NULL
        LIMIT 50
      `);
      const rows: Array<{ content: string; embedding: unknown }> = Array.isArray(result)
            ? result
            : (result as unknown as { rows: Array<{ content: string; embedding: unknown }> }).rows ?? [];

      if (rows.length > 0) {
        const scored = rows
          .map((row) => {
            const emb = Array.isArray(row.embedding) ? (row.embedding as number[]) : null;
            const score = emb ? cosineSim(queryEmbedding, emb) : 0;
            return { content: row.content as string, score };
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, topK);

        if (scored.length > 0) {
          const totalMs = Date.now() - startMs;
          const totalChars = scored.reduce((s, c) => s + c.content.length, 0);
          console.log(`[ragService] retrieve: vector matched ${scored.length} chunks (${totalChars} chars) in ${totalMs}ms, scores=[${scored.map((s) => s.score.toFixed(3)).join(", ")}]`);
          return scored.map((s) => s.content);
        }
      }
      console.log("[ragService] retrieve: no vector matches found, falling back to FTS");
    } catch (err) {
      console.warn("[ragService] retrieve: vector search failed, falling back to FTS:", err);
    }
  } else {
    console.log(`[ragService] retrieve: no embedding available (${embedMs}ms), using FTS`);
  }

  // Full-text search fallback — use OR matching (any term matches) instead of AND
  // plainto_tsquery requires ALL terms to match, which fails for natural-language queries.
  // We split the query into individual words and join with OR (|) for partial matching.
  try {
    const queryWords = query.replace(/[^\w\s]/g, "").split(/\s+/).filter((w) => w.length > 2);
    const orQuery = queryWords.join(" | ");

    const ftsResult = await db.execute(sql`
      SELECT content,
             ts_rank(search_vector, to_tsquery('english', ${orQuery})) AS rank
      FROM knowledge_chunks
      WHERE agent_id = ${agentId}
        AND company_id = ${companyId}
        AND search_vector @@ to_tsquery('english', ${orQuery})
      ORDER BY rank DESC
      LIMIT ${topK}
    `);
    // Drizzle db.execute() may return rows directly (array) or as { rows: [...] }
    const ftsRows: Array<{ content: string }> = Array.isArray(ftsResult)
      ? ftsResult
      : (ftsResult as unknown as { rows: Array<{ content: string }> }).rows ?? [];

    if (ftsRows.length > 0) {
      const totalMs = Date.now() - startMs;
      const totalChars = ftsRows.reduce((s, r) => s + r.content.length, 0);
      console.log(`[ragService] retrieve: FTS matched ${ftsRows.length} chunks (${totalChars} chars) in ${totalMs}ms`);
      return ftsRows.map((r) => r.content);
    }
  } catch (err) {
    console.warn("[ragService] retrieve: FTS failed:", err);
  }

  const totalMs = Date.now() - startMs;
  console.log(`[ragService] retrieve: no context found in ${totalMs}ms`);
  return [];
}

export async function deleteAgentKnowledge(agentId: string, companyId: string): Promise<number> {
  const db = getDb();
  const result = await db
    .delete(knowledgeChunks)
    .where(and(eq(knowledgeChunks.agentId, agentId), eq(knowledgeChunks.companyId, companyId)));
  const count = (result as unknown as { rowCount: number }).rowCount ?? 0;
  console.log(`[ragService] deleteKnowledge: agent=${agentId}, deleted=${count}`);
  return count;
}

export async function listAgentKnowledge(
  agentId: string,
  companyId: string,
): Promise<Array<{ id: string; metadata: Record<string, unknown>; createdAt: Date }>> {
  const db = getDb();
  const rows = await db
    .select({
      id: knowledgeChunks.id,
      metadata: knowledgeChunks.metadata,
      createdAt: knowledgeChunks.createdAt,
    })
    .from(knowledgeChunks)
    .where(and(eq(knowledgeChunks.agentId, agentId), eq(knowledgeChunks.companyId, companyId)))
    .orderBy(knowledgeChunks.createdAt);
  return rows as Array<{ id: string; metadata: Record<string, unknown>; createdAt: Date }>;
}
