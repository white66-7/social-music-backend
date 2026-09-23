import { Redis } from '@upstash/redis';

const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

if (!redisUrl || !redisToken) {
  console.warn('[Redis] 未配置 Redis 环境变量，请检查 .env 配置！');
}

export const redis = new Redis({
  url: redisUrl,
  token: redisToken,
});

export const REDIS_ROOM_KEY = 'music:active_room';