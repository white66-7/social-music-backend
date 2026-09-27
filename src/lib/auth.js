import jwt from 'jsonwebtoken';
import { getDatabase } from './mongodb.js';

// 保留原有的兜底密钥，这样已经发出去的 30 天 token 不会因为本次重构而全部失效
export const DEFAULT_JWT_SECRET = 'white667-social-music-secure-jwt-key';

function secret(env) {
  return env.JWT_SECRET || DEFAULT_JWT_SECRET;
}

export function signToken(env, user) {
  return jwt.sign(
    { qq: String(user.qq), username: user.username },
    secret(env),
    { expiresIn: '30d' }
  );
}

/**
 * 从 Authorization 头或 ?token= 查询参数里解析并校验 JWT。
 * 查询参数是为了兼容 WebSocket —— 浏览器无法给 WS 握手设置自定义头。
 */
export function readClaims(env, request, url) {
  const header = request.headers.get('Authorization') || '';
  let token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token && url) token = url.searchParams.get('token') || '';
  if (!token) return null;

  try {
    const claims = jwt.verify(token, secret(env));
    return claims?.qq ? claims : null;
  } catch {
    return null;
  }
}

/**
 * 读取最新的用户档案。
 * JWT 里的 username 是签发那一刻的快照，用户改过昵称后就是脏数据，
 * 所以展示用的昵称/头像一律以数据库为准，读不到才降级用 JWT 声明。
 */
export async function loadProfile(env, claims) {
  const qq = String(claims.qq);
  const fallback = {
    qq,
    username: claims.username || `网友_${qq.slice(-4)}`,
    avatarUrl: `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640`
  };

  try {
    const db = await getDatabase(env);
    const user = await db.collection('users').findOne(
      { qq },
      { projection: { username: 1, avatarUrl: 1 } }
    );
    if (user) {
      return {
        qq,
        username: user.username || fallback.username,
        avatarUrl: user.avatarUrl || fallback.avatarUrl
      };
    }
  } catch (e) {
    console.warn('[Auth] 读取用户档案失败，降级使用 JWT 声明:', e.message);
  }
  return fallback;
}

/**
 * Hono 中间件：要求已登录，并把解析出的 claims 挂到上下文。
 */
export function requireAuth() {
  return async (c, next) => {
    const claims = readClaims(c.env, c.req.raw, new URL(c.req.url));
    if (!claims) {
      return c.json({ code: 401, message: '登录状态已失效，请重新登录' }, 401);
    }
    c.set('claims', claims);
    await next();
  };
}
