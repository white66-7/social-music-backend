import { Redis } from '@upstash/redis';

export const REDIS_ROOM_KEY = 'music:active_room';
export const ROOM_LEASE_SECONDS = 60;

export function getRedis(env) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error('[Redis] 未配置 UPSTASH_REDIS_REST_URL 或 UPSTASH_REDIS_REST_TOKEN');
  }
  return new Redis({ url, token });
}

export async function renewRoom(redis, payload, ttlSeconds = ROOM_LEASE_SECONDS) {
  await redis.set(REDIS_ROOM_KEY, JSON.stringify(payload), { ex: ttlSeconds });
}

export async function updateRoomMeta(redis, payload) {
  await redis.set(REDIS_ROOM_KEY, JSON.stringify(payload), { keepTtl: true });
}

export async function loadRoom(redis) {
  const raw = await redis.get(REDIS_ROOM_KEY);
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    console.warn('[Redis] 房间数据解析失败:', err.message);
    return null;
  }
}