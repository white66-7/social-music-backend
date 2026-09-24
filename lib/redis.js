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

// 房主客户端每 5 秒心跳一次，60 秒的租约窗口可以容忍连续丢 11 次心跳，
// 移动网络抖动再也不会把正在放歌的房间判死。
export const ROOM_LEASE_SECONDS = 60;

/**
 * 重新签发租约：开播和心跳续期都走这里。
 */
export async function renewRoom(payload, ttlSeconds = ROOM_LEASE_SECONDS) {
  await redis.set(REDIS_ROOM_KEY, JSON.stringify(payload), { ex: ttlSeconds });
}

/**
 * 只更新房间的元数据（例如 lastProbedAt），保留剩余租约不动。
 *
 * 这里刻意只暴露这一个写法：之前 status.js 里手写过 { keepttl: true }，
 * 而 @upstash/redis 只认 keepTtl（见 node_modules/@upstash/redis 里的
 * `"keepTtl" in opts`），未知字段被静默忽略 → 那条 SET 不带任何 TTL →
 * 反而把房间键的过期时间抹掉变成永不过期的脏数据。
 */
export async function updateRoomMeta(payload) {
  await redis.set(REDIS_ROOM_KEY, JSON.stringify(payload), { keepTtl: true });
}

/**
 * 读取当前房间，不存在或数据损坏时返回 null。
 */
export async function loadRoom() {
  const raw = await redis.get(REDIS_ROOM_KEY);
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    console.warn('[Redis] 房间数据解析失败，按无房间处理:', err.message);
    return null;
  }
}
