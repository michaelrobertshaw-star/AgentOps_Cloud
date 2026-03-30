import { createDatabase, type Database } from "@agentops/db";
import { getEnv } from "../config/env.js";

let _db: Database | undefined;

export function getDb(): Database {
  if (!_db) {
    _db = createDatabase(getEnv().DATABASE_URL);
  }
  return _db;
}
