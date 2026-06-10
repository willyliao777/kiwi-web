import { Redis } from "@upstash/redis";

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

interface ApiKey {
  active: boolean;
}

export async function validateApiKey(key: string): Promise<boolean> {
  // Check registered keys in Redis
  const raw = await redis.hget("kiwi:apikeys", key);
  if (raw) {
    const meta: ApiKey = typeof raw === "string" ? JSON.parse(raw) : (raw as ApiKey);
    if (meta.active) return true;
  }
  // Fallback: env var keys (existing single key + demo key)
  return key === process.env.KIWI_API_KEY || key === process.env.KIWI_DEMO_KEY;
}
