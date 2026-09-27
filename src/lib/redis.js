import { Redis } from '@upstash/redis';

export const REDIS_ROOM_KEY = 'music:active_room';
export const ROOM_LEASE_SECONDS = 60;

let cachedRedis = null;

export function getRedis(env) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error('[Redis] 未配置 UPSTASH_REDIS_REST_URL 或 UPSTASH_REDIS_REST_TOKEN');
  }

  // ⚡ 单例模式：避免每次进入接口都重复创建 Redis 实例
  if (!cachedRedis) {
    cachedRedis = new Redis({ url, token });
  }
  return cachedRedis;
}

export async function renewRoom(redis, payload, ttlSeconds = ROOM_LEASE_SECONDS) {
  // @upstash/redis 原生支持直接存入对象，自动处理序列化
  await redis.set(REDIS_ROOM_KEY, payload, { ex: ttlSeconds });
}

export async function updateRoomMeta(redis, payload) {
  await redis.set(REDIS_ROOM_KEY, payload, { keepTtl: true });
}

export async function loadRoom(redis) {
  try {
    const raw = await redis.get(REDIS_ROOM_KEY);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    console.warn('[Redis] 房间数据解析失败:', err.message);
    return null;
  }
}