import { Hono } from 'hono';
import { cors } from 'hono/cors';
import bcrypt from 'bcryptjs';

import {
  findUser,
  listUsers,
  insertUser,
  touchUserLogin,
  syncUserProfile,
  setUsername,
  upsertRoomLog,
  endActiveRoomLogs,
  listRoomLogs,
  toPublicUser,
  qqAvatarUrl,
  defaultNickname
} from './lib/db.js';
import {
  getRedis,
  getLoginFailCount,
  recordLoginFailure,
  clearLoginFailures,
  LOGIN_FAIL_LIMIT
} from './lib/redis.js';
import { signToken, readClaims, loadProfile, requireAuth } from './lib/auth.js';
import { getHubStub } from './room-hub.js';

const app = new Hono();

// 1. 全局 CORS 配置
const corsMiddleware = cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowHeaders: [
    'X-CSRF-Token',
    'X-Requested-With',
    'Accept',
    'Accept-Version',
    'Content-Length',
    'Content-MD5',
    'Content-Type',
    'Date',
    'X-Api-Version',
    'Authorization'
  ],
  credentials: true,
});

// WebSocket 握手返回的是 101，往它上面写 CORS 头会因响应头不可变而抛错，
// 所以升级请求一律绕过 CORS 中间件 —— 握手本来也不受同源策略约束。
app.use('*', async (c, next) => {
  if ((c.req.header('Upgrade') || '').toLowerCase() === 'websocket') {
    return next();
  }
  return corsMiddleware(c, next);
});

app.get('/api/health', (c) => c.json({ code: 0, message: 'ok', time: Date.now() }, 200));

// ----------------------------------------------------
// 辅助
//
// 注意：房间历史一律在 RoomHub 校验通过之后才写，
// 否则任何人拿别人正在放歌的 roomId 反复调 start 就能改写那条历史。
// ----------------------------------------------------

/**
 * 从 JWT 声明推导展示用的用户信息，不查库。
 *
 * 头像直接由 QQ 号推导：本应用的头像始终来自 QQ，用户无法在应用内改，
 * 所以这跟查一次库一样准，却省掉一次查询。
 */
function profileFromClaims(claims) {
  const qq = String(claims.qq);
  return {
    qq,
    username: claims.username || defaultNickname(qq),
    avatarUrl: qqAvatarUrl(qq)
  };
}

/**
 * 房主超时被 DO 回收时，DO 没有回调 Worker 的通道，那条历史会一直挂在 active。
 * 所以在「服务端确认没有房间」时顺手收尾一次，并节流避免每个请求都写库。
 */
let lastStaleSweepAt = 0;
const STALE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

async function sweepStaleRoomLogs(env) {
  const now = Date.now();
  if (now - lastStaleSweepAt < STALE_SWEEP_INTERVAL_MS) return;
  lastStaleSweepAt = now;

  try {
    await endActiveRoomLogs(env, 'timeout');
  } catch (e) {
    console.warn('[Room Log] 清理陈旧记录失败:', e.message);
  }
}

/** 房间历史是旁路数据，写失败绝不能影响放歌本身 */
async function safeRoomLog(label, work) {
  try {
    await work();
  } catch (e) {
    console.warn(`[Room Log] ${label}失败（不影响主流程）:`, e.message);
  }
}

/**
 * 把副作用挪出响应路径。
 *
 * 房间历史是旁路数据，没有任何理由让「开启房间」这种实时操作去等它 ——
 * 跨境链路上一次 D1 写往返就是几百毫秒到几秒，用户是直接能感觉到的。
 *
 * executionCtx 只在真正的 Worker 请求里存在；本地单测直接调 handler 时会抛，
 * 那时退回 await，行为与改动前一致。
 */
function background(c, work) {
  let ctx = null;
  try {
    ctx = c.executionCtx;
  } catch (e) {
    ctx = null;
  }

  if (ctx) {
    ctx.waitUntil(work());
    return;
  }
  return work();
}

// ----------------------------------------------------
// 路由：/api/auth/login
// ----------------------------------------------------
app.post('/api/auth/login', async (c) => {
  const env = c.env;
  const redis = getRedis(env);

  try {
    const { qq, username, pin } = await c.req.json().catch(() => ({}));
    const cleanQq = String(qq || username || '').trim();
    const cleanPin = String(pin || '').trim();

    if (!cleanQq || !/^[1-9][0-9]{4,11}$/.test(cleanQq)) {
      return c.json({ code: 400, message: '请输入合法的 QQ 号码' }, 400);
    }
    if (!cleanPin || cleanPin.length !== 4) {
      return c.json({ code: 400, message: '请输入 4 位专属口令' }, 400);
    }

    const failCount = await getLoginFailCount(redis, cleanQq);
    if (failCount >= LOGIN_FAIL_LIMIT) {
      return c.json({ code: 429, message: '口令错误次数过多，请 10 分钟后再试' }, 429);
    }

    const existingUser = await findUser(env, cleanQq);

    if (existingUser) {
      const storedPin = typeof existingUser.pin === 'string' ? existingUser.pin : '';

      // 这里以前有一条「首次绑定」旁路：storedPin 为空就无条件放行，
      // 于是任何知道 QQ 号的人都能拿任意 4 位口令把这个账号认领走
      //（响应里还会直接下发 30 天有效的 JWT，并把口令改成攻击者的）。
      // 已核对生产库不存在无口令档案，因此直接删掉该旁路。
      if (storedPin.length === 0) {
        console.warn(`[Login] 账号 ${cleanQq} 没有口令，已拒绝登录（需人工重置）`);
      }

      // 非 bcrypt 的历史明文口令仍允许登录一次，成功后就地升级成哈希
      const isMatch = storedPin.length > 0 && (storedPin.startsWith('$2')
        ? await bcrypt.compare(cleanPin, storedPin)
        : storedPin === cleanPin);

      if (!isMatch) {
        await recordLoginFailure(redis, cleanQq);
        return c.json({ code: 403, message: '口令错误' }, 403);
      }

      await clearLoginFailures(redis, cleanQq);

      const now = Date.now();
      // 明文口令在这一刻就地升级成 bcrypt；已是哈希的就不重复计算
      const newPinHash = storedPin.startsWith('$2') ? null : await bcrypt.hash(cleanPin, 10);
      await touchUserLogin(env, cleanQq, { pin: newPinHash, lastActiveAt: now });

      const token = signToken(env, existingUser);

      return c.json({
        code: 0,
        message: '登录成功',
        token,
        user: { ...toPublicUser(existingUser), lastActiveAt: now }
      }, 200);
    }

    const now = Date.now();
    const nickname = defaultNickname(cleanQq);
    const avatarUrl = qqAvatarUrl(cleanQq);

    await insertUser(env, {
      qq: cleanQq,
      username: nickname,
      avatarUrl,
      pin: await bcrypt.hash(cleanPin, 10),
      createdAt: now
    });
    await clearLoginFailures(redis, cleanQq);

    const token = signToken(env, { qq: cleanQq, username: nickname });

    return c.json({
      code: 0,
      message: '首次认证并绑定成功',
      token,
      user: { qq: cleanQq, username: nickname, avatarUrl, createdAt: now, lastActiveAt: now }
    }, 200);

  } catch (error) {
    console.error('[Login Error]', error);
    return c.json({ code: 500, message: `服务器处理异常: ${error.message}` }, 500);
  }
});

// ----------------------------------------------------
// 路由：/api/user/me
// ----------------------------------------------------
app.get('/api/user/me', requireAuth(), async (c) => {
  const profile = await loadProfile(c.env, c.get('claims'));
  return c.json({ code: 0, data: profile }, 200);
});

// ----------------------------------------------------
// 路由：/api/user/list —— 全部注册成员（在线状态来自 RoomHub 的实时连接）
//
// 这是「花名册」而不是「房间成员」：名单稳定，只有 isOnline / isHosting
// 两个角标会随实时连接变化。
// ----------------------------------------------------
app.get('/api/user/list', requireAuth(), async (c) => {
  try {
    const [users, presence] = await Promise.all([
      listUsers(c.env),
      getHubStub(c.env)
        .fetch('https://room-hub/members')
        .then(r => r.json())
        .catch(() => null)
    ]);

    const online = new Set((presence?.members || []).map(m => m.qq));
    const hostQq = (presence?.members || []).find(m => m.isHosting)?.qq || null;

    const data = users.map(u => {
      const qq = String(u.qq);
      return {
        qq,
        username: u.username || defaultNickname(qq),
        avatarUrl: u.avatar_url || qqAvatarUrl(qq),
        isOnline: online.has(qq),
        isHosting: Boolean(hostQq && hostQq === qq),
        lastActiveAt: u.last_active_at || 0
      };
    });

    return c.json({ code: 0, total: data.length, data }, 200);
  } catch (error) {
    console.error('[User List Error]', error);
    return c.json({ code: 500, message: '获取成员列表失败' }, 500);
  }
});

// ----------------------------------------------------
// 路由：/api/user/sync
// ----------------------------------------------------
app.post('/api/user/sync', requireAuth(), async (c) => {
  try {
    const claims = c.get('claims');
    const { username, avatarUrl } = await c.req.json().catch(() => ({}));

    // qq 一律取自 token，请求体里传什么都不作数。
    // 刻意不做 upsert：以前会凭空造出一个没有 pin 的档案，
    // 而登录又曾把「没有 pin」当首次绑定放行，等于谁都能凭 QQ 号认领账号。
    const hit = await syncUserProfile(c.env, String(claims.qq), { username, avatarUrl });

    if (!hit) {
      return c.json({ code: 404, message: '用户档案不存在，请先使用 QQ 号登录' }, 404);
    }

    return c.json({ code: 0, message: '用户档案同步成功' }, 200);
  } catch (error) {
    console.error('[User Sync Error]', error);
    return c.json({ code: 500, message: '服务器内部错误' }, 500);
  }
});

// ----------------------------------------------------
// 路由：/api/user/update-name
// ----------------------------------------------------
app.post('/api/user/update-name', requireAuth(), async (c) => {
  try {
    const qq = String(c.get('claims').qq);
    const { newUsername } = await c.req.json().catch(() => ({}));
    const cleanName = String(newUsername || '').trim();

    if (!cleanName) {
      return c.json({ code: 400, message: '昵称不能为空' }, 400);
    }
    if (cleanName.length > 12) {
      return c.json({ code: 400, message: '昵称最多 12 个字' }, 400);
    }

    await setUsername(c.env, qq, cleanName);

    return c.json({
      code: 0,
      message: '昵称更新成功',
      username: cleanName,
      data: { qq, username: cleanName, avatarUrl: qqAvatarUrl(qq) }
    }, 200);
  } catch (err) {
    console.error('[Update Name Error]', err);
    return c.json({ code: 500, message: `服务器异常: ${err.message}` }, 500);
  }
});

// ----------------------------------------------------
// 路由：/api/room/history
// ----------------------------------------------------
app.get('/api/room/history', requireAuth(), async (c) => {
  try {
    const limit = Math.min(parseInt(c.req.query('limit')) || 10, 30);
    const rows = await listRoomLogs(c.env, limit);

    const data = rows.map(r => ({
      roomId: r.room_id,
      publisher: r.publisher,
      inviter: r.inviter,
      hostAvatarUrl: r.host_avatar_url,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      status: r.status
    }));

    return c.json({ code: 0, data }, 200);
  } catch (error) {
    console.error('[Get History Error]', error);
    return c.json({ code: 500, message: '查询历史失败' }, 500);
  }
});

// ====================================================
// 房间实时层：全部经 RoomHub Durable Object
// ====================================================

// ----------------------------------------------------
// 路由：/api/room/state —— 一次性快照（WS 建连前的兜底）
// ----------------------------------------------------
app.get('/api/room/state', requireAuth(), async (c) => {
  try {
    // 只取 DO 里那份权威状态。这个接口客户端每次启动/回前台都会调，
    // 不该顺带做任何多余的事。用户档案由客户端另行调 /api/user/me。
    const res = await getHubStub(c.env).fetch('https://room-hub/state');
    const snapshot = await res.json();

    // 权威状态说没有房间，但历史里还有 active —— 那是房主被超时回收了。
    // 这是旁路收尾，不该让客户端的首屏快照等它。
    if (!snapshot.room) {
      background(c, () => sweepStaleRoomLogs(c.env));
    }

    return c.json({ code: 0, ...snapshot }, 200);
  } catch (error) {
    console.error('[Room State Error]', error);
    return c.json({ code: 500, message: '获取房间状态失败' }, 500);
  }
});

// ----------------------------------------------------
// 路由：/api/room/ws —— 成员端实时长连接
// ----------------------------------------------------
app.get('/api/room/ws', async (c) => {
  const claims = readClaims(c.env, c.req.raw, new URL(c.req.url));
  if (!claims) {
    return c.json({ code: 401, message: '登录状态已失效，请重新登录' }, 401);
  }
  if ((c.req.header('Upgrade') || '').toLowerCase() !== 'websocket') {
    return c.json({ code: 426, message: '需要 WebSocket 升级' }, 426);
  }

  // 直接把原始请求转发给 DO，才能保住 Upgrade 握手。
  // 身份由 DO 自己再校验一次 token（纵深防御），所以这里不需要额外带头。
  return getHubStub(c.env).fetch(c.req.raw);
});

// ----------------------------------------------------
// 路由：/api/room/host/start —— 开播（同一房间重复调用即断线重连）
// ----------------------------------------------------
app.post('/api/room/host/start', requireAuth(), async (c) => {
  try {
    const claims = c.get('claims');
    const { roomId, inviter, secret, deepLink, serverUrl } = await c.req.json().catch(() => ({}));

    const cleanRoomId = String(roomId || '').trim();
    if (!cleanRoomId || !deepLink) {
      return c.json({ code: 400, message: '缺少房间链接或房间号' }, 400);
    }
    if (!String(secret || '').trim()) {
      return c.json({ code: 400, message: '未解析到房间密钥' }, 400);
    }

    // 身份全在 JWT 里，这里不需要查库 —— 开房是实时操作，不该等任何数据库往返。
    const user = profileFromClaims(claims);

    const res = await getHubStub(c.env).fetch('https://room-hub/host/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user,
        roomId: cleanRoomId,
        inviter,
        secret,
        deepLink,
        serverUrl
      })
    });

    const data = await res.json();

    // 只有 RoomHub 确认房间归我（没被 409 挡下）才记历史。
    // 历史是旁路数据，写失败也不影响开播，而且不该挡住开播的响应。
    if (res.ok) {
      background(c, () => safeRoomLog('写入', () => upsertRoomLog(c.env, {
        roomId: cleanRoomId,
        publisher: user.username,
        inviter: inviter || user.username,
        hostAvatarUrl: user.avatarUrl,
        deepLink
      })));
    }

    return c.json(data, res.status);
  } catch (error) {
    console.error('[Host Start Error]', error);
    return c.json({ code: 500, message: `开播失败: ${error.message}` }, 500);
  }
});

// ----------------------------------------------------
// 路由：/api/room/host/state —— 房主上报播放状态 / 保活
// ----------------------------------------------------
app.post('/api/room/host/state', requireAuth(), async (c) => {
  try {
    const claims = c.get('claims');
    const { playback } = await c.req.json().catch(() => ({}));

    const res = await getHubStub(c.env).fetch('https://room-hub/host/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: { qq: String(claims.qq) }, playback })
    });

    const data = await res.json();
    return c.json(data, res.status);
  } catch (error) {
    console.error('[Host State Error]', error);
    return c.json({ code: 500, message: '状态上报失败' }, 500);
  }
});

// ----------------------------------------------------
// 路由：/api/room/host/stop —— 房主主动关房
// ----------------------------------------------------
app.post('/api/room/host/stop', requireAuth(), async (c) => {
  try {
    const claims = c.get('claims');

    const res = await getHubStub(c.env).fetch('https://room-hub/host/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: { qq: String(claims.qq) } })
    });

    const data = await res.json();

    if (res.ok) {
      background(c, () => safeRoomLog('归档', () => endActiveRoomLogs(c.env, 'manual')));
    }

    return c.json(data, res.status);
  } catch (error) {
    console.error('[Host Stop Error]', error);
    return c.json({ code: 500, message: '关房失败' }, 500);
  }
});

export { RoomHub } from './room-hub.js';

export default app;
