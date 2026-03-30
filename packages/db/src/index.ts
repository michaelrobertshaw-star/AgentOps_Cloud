import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export * from "./schema/index.js";
export { schema };

export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(url?: string) {
  const connectionString = url ?? process.env.DATABASE_URL ?? "postgresql://agentops:agentops@localhost:5432/agentops";
  const sql = postgres(connectionString);
  return drizzle(sql, { schema });
}
