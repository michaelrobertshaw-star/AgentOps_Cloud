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
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | undefined;

export function getEnv(): Env {
  if (!_env) {
    _env = envSchema.parse(process.env);
  }
  return _env;
}
