import Redis from "ioredis";
import { getEnv } from "../config/env.js";

let _redis: Redis | undefined;

/**
 * Shared Redis connection used by BullMQ and other services.
 * BullMQ requires a connection object (not the client directly),
 * so we export the config separately.
 */
export function getRedisConnection(): { host: string; port: number } {
  const url = new URL(getEnv().REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
  };
}

export function getRedis(): Redis {
  if (!_redis) {
    const conn = getRedisConnection();
    _redis = new Redis({
      host: conn.host,
      port: conn.port,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: null, // required by BullMQ
    });

    _redis.on("error", (err: Error) => {
      console.error("[redis] connection error:", err.message);
    });
  }
  return _redis;
}

// Export a connection-config object for BullMQ (avoids sharing ioredis instance)
export const redis = {
  get connection() {
    return getRedisConnection();
  },
};
