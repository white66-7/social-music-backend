import { Redis } from '@upstash/redis';

/**
 * 每次调用都新建一个 Upstash 客户端。
 *
 * 这里以前做的是模块级单例。Upstash 走的是 REST（内部就是 fetch），本身不持有
 * 长连接，所以它不像 MongoClient 那样会踩到「跨请求复用 I/O 上下文」的坑；
 * 但构造这个对象的成本接近于零，索性也一并去掉缓存，免得日后有人照抄这个
 * 模式去缓存真正持连接的东西。
 */
export function getRedis(env) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error('[Redis] 未配置 UPSTASH_REDIS_REST_URL 或 UPSTASH_REDIS_REST_TOKEN');
  }
  return new Redis({ url, token });
}

// ============================================================
// 登录失败限流
//
// 房间状态本身已经整体搬进 RoomHub Durable Object（它才是权威状态源），
// 这里只保留 Redis 擅长的、天然跨实例共享的限流计数器。
// ============================================================

const LOGIN_FAIL_PREFIX = 'login:fail:';
const LOGIN_FAIL_WINDOW_SECONDS = 600;
export const LOGIN_FAIL_LIMIT = 5;

export async function getLoginFailCount(redis, qq) {
  try {
    const raw = await redis.get(LOGIN_FAIL_PREFIX + qq);
    return raw ? parseInt(raw, 10) || 0 : 0;
  } catch (e) {
    console.warn('[Redis] 读取登录失败计数失败，按未超限处理:', e.message);
    return 0;
  }
}

export async function recordLoginFailure(redis, qq) {
  try {
    await redis.incr(LOGIN_FAIL_PREFIX + qq);
    await redis.expire(LOGIN_FAIL_PREFIX + qq, LOGIN_FAIL_WINDOW_SECONDS);
  } catch (e) {
    console.warn('[Redis] 写入登录失败计数失败:', e.message);
  }
}

export async function clearLoginFailures(redis, qq) {
  try {
    await redis.del(LOGIN_FAIL_PREFIX + qq);
  } catch (e) {
    console.warn('[Redis] 清除登录失败计数失败:', e.message);
  }
}

export { LOGIN_FAIL_WINDOW_SECONDS };
