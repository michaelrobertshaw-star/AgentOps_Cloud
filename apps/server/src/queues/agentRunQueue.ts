import { Queue } from "bullmq";
import { getRedisConnection } from "../lib/redis.js";

export interface AgentRunJobData {
  agentId: string;
  companyId: string;
  input: string;
  runId: string;
  model: string;
  systemPrompt: string;
  apiKey: string;
  ragEnabled?: boolean;
  ragPrompt?: string;
  ragTimeoutMs?: number;
  preferredModel?: string;
  routingPolicy?: string;
  // Multi-model provider support (Phase 3)
  providerType?: "anthropic" | "aws_bedrock" | "gcp_vertex";
  providerConfig?: Record<string, string>;
}

export const agentRunQueue = new Queue<AgentRunJobData>("agent-runs", {
  connection: getRedisConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});
