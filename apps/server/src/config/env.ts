import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z
    .string()
    .default("postgresql://agentops:agentops@localhost:5432/agentops"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  JWT_SECRET: z.string().default("dev-jwt-secret-change-in-production"),
  JWT_ISSUER: z.string().default("agentops.cloud"),
  JWT_AUDIENCE: z.string().default("agentops-api"),
  JWT_ACCESS_TOKEN_TTL: z.coerce.number().default(900), // 15 minutes
  JWT_REFRESH_TOKEN_TTL: z.coerce.number().default(604800), // 7 days
  BCRYPT_ROUNDS: z.coerce.number().default(12),
  // Rate limiting — RPM = requests per minute
  // Default: 6000 RPM per user (100 RPS × 60s), 60000 RPM per company
  RATE_LIMIT_COMPANY_RPM: z.coerce.number().default(60000),
  RATE_LIMIT_USER_RPM: z.coerce.number().default(6000),
  // S3/MinIO configuration
  S3_ENDPOINT: z.string().default("http://localhost:9000"),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string().default("minioadmin"),
  S3_SECRET_KEY: z.string().default("minioadmin"),
  S3_BUCKET: z.string().default("agentops-outputs"),
  S3_WORKSPACE_BUCKET: z.string().default("workspaces"),
  S3_AUDIT_BUCKET: z.string().default("audit-archive"),
  // File upload limits
  MAX_FILE_SIZE_BYTES: z.coerce.number().default(100 * 1024 * 1024), // 100MB
  // MFA
  MFA_ENCRYPTION_KEY: z.string().default("dev-mfa-encryption-key-32-bytes!!"), // 32 bytes for AES-256
  MFA_ISSUER: z.string().default("AgentOps Cloud"),
  // JWT key rotation — optional secondary secret for dual-key verification during rollover
  JWT_SECRET_SECONDARY: z.string().optional(),
  // API key grace period for rotation (hours)
  KEY_ROTATION_GRACE_HOURS: z.coerce.number().default(24),
  // Session management
  SESSION_MAX_CONCURRENT: z.coerce.number().default(5),
  SESSION_IDLE_TIMEOUT_HOURS: z.coerce.number().default(24),
  // Email / SMTP
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: z.coerce.boolean().default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default("AgentOps Cloud <noreply@agentops.cloud>"),
  APP_BASE_URL: z.string().default("http://localhost:3000"),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | undefined;

export function getEnv(): Env {
  if (!_env) {
    _env = envSchema.parse(process.env);
  }
  return _env;
}
