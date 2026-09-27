import { Hono } from 'hono';
import { cors } from 'hono/cors';
import bcrypt from 'bcryptjs';

import { getDatabase, closeDatabase } from './lib/mongodb.js';
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

// Mongo 连接是按请求创建的（见 lib/mongodb.js 的说明：跨请求复用会让请求永久挂死），
// 所以每个请求结束都必须把它关掉，否则会持续泄漏到 Atlas 的连接。
app.use('*', async (c, next) => {
  try {
    await next();
  } finally {
    await closeDatabase(c);
  }
});

app.get('/api/health', (c) => c.json({ code: 0, message: 'ok', time: Date.now() }, 200));

// ----------------------------------------------------
// 房间历史
//
// 这些操作必须留在 Worker 侧：Durable Object 与本 Worker 跑在同一个 isolate
// 但属于不同的 I/O 上下文，DO 里复用 Worker 建立的 Mongo 连接会直接抛
// "Cannot perform I/O on behalf of a different Durable Object"，或者让请求永久挂住。
//
// 顺序上同样要小心：日志一律在 RoomHub 校验通过之后才写，
// 否则任何人拿别人正在放歌的 roomId 反复调 start 就能改写那条历史。
// ----------------------------------------------------
async function openRoomLog(c, { roomId, publisher, inviter, hostAvatarUrl, deepLink }) {
  const now = new Date();
  try {
    const db = await getDatabase(c);
    await db.collection('room_logs').findOneAndUpdate(
      { roomId },
      {
        $set: {
          publisher,
          inviter,
          hostAvatarUrl,
          deepLink,
          status: 'active',
          startedAt: now,
          endedAt: null,
          endReason: null
        },
        $setOnInsert: { createdAt: now }
      },
      { upsert: true }
    );
  } catch (e) {
    console.warn('[Room Log] 写入失败（不影响开播）:', e.message);
  }
}

/**
 * 收尾当前活动房间的历史记录。
 * 全站同时只允许一个房间，所以不需要 roomId 也能精确定位。
 */
async function endActiveRoomLog(c, reason) {
  try {
    const db = await getDatabase(c);
    await db.collection('room_logs').updateMany(
      { status: 'active' },
      {
        $set: {
          status: 'ended',
          endedAt: new Date(),
          endReason: reason === 'timeout' ? 'timeout' : 'manual'
        }
      }
    );
  } catch (e) {
    console.warn('[Room Log] 归档失败:', e.message);
  }
}

/**
 * 房主超时被 DO 回收时，DO 没有回调 Worker 的通道，那条历史会一直挂在 active。
 * 所以在「服务端确认没有房间」时顺手收尾一次，并节流避免每个请求都写库。
 */
let lastStaleSweepAt = 0;
const STALE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

async function sweepStaleRoomLogs(c) {
  const now = Date.now();
  if (now - lastStaleSweepAt < STALE_SWEEP_INTERVAL_MS) return;
  lastStaleSweepAt = now;
  await endActiveRoomLog(c, 'timeout');
}

// ----------------------------------------------------
// 路由：/api/auth/login
// ----------------------------------------------------
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

    const db = await getDatabase(c);
    const usersCollection = db.collection('users');
    const existingUser = await usersCollection.findOne({ qq: cleanQq });

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

      const updateData = { lastActiveAt: Date.now() };
      if (!storedPin.startsWith('$2')) {
        updateData.pin = await bcrypt.hash(cleanPin, 10);
      }
      await usersCollection.updateOne({ qq: cleanQq }, { $set: updateData });

      const token = signToken(env, existingUser);
      const { pin: _pin, _id, ...safeUser } = existingUser;

      return c.json({
        code: 0,
        message: '登录成功',
        token,
        user: safeUser
      }, 200);
    }

    const defaultNickname = `网友_${cleanQq.slice(-4)}`;
    const newUser = {
      qq: cleanQq,
      username: defaultNickname,
      avatarUrl: `https://q1.qlogo.cn/g?b=qq&nk=${cleanQq}&s=640`,
      pin: await bcrypt.hash(cleanPin, 10),
      createdAt: Date.now(),
      lastActiveAt: Date.now()
    };

    await usersCollection.insertOne(newUser);
    await clearLoginFailures(redis, cleanQq);

    const token = signToken(env, newUser);
    const { pin: _pin, _id, ...safeUser } = newUser;

    return c.json({
      code: 0,
      message: '首次认证并绑定成功',
      token,
      user: safeUser
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
  const profile = await loadProfile(c, c.get('claims'));
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
    const db = await getDatabase(c);

    const usersPromise = db.collection('users')
      .aggregate([
        { $match: { qq: { $type: 'string', $ne: '' } } },
        {
          $addFields: {
            lastActiveAt: {
              $convert: { input: '$lastActiveAt', to: 'long', onError: 0, onNull: 0 }
            }
          }
        },
        { $project: { pin: 0 } },
        { $sort: { lastActiveAt: -1 } }
      ])
      .toArray();

    const presencePromise = getHubStub(c.env)
      .fetch('https://room-hub/members')
      .then(r => r.json())
      .catch(() => null);

    const [users, presence] = await Promise.all([usersPromise, presencePromise]);

    const online = new Set((presence?.members || []).map(m => m.qq));
    const hostQq = (presence?.members || []).find(m => m.isHosting)?.qq || null;

    const data = (users || []).map(u => {
      const qq = String(u.qq);
      return {
        qq,
        username: u.username || `网友_${qq.slice(-4)}`,
        avatarUrl: u.avatarUrl || `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640`,
        isOnline: online.has(qq),
        isHosting: Boolean(hostQq && hostQq === qq),
        lastActiveAt: u.lastActiveAt || 0
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
    const profile = await loadProfile(c, c.get('claims'));
    const { username, avatarUrl } = await c.req.json().catch(() => ({}));

    const db = await getDatabase(c);
    const now = Date.now();

    const updateDoc = {
      $set: { lastActiveAt: now, updatedAt: now },
      $setOnInsert: { createdAt: now, qq: profile.qq }
    };
    if (typeof username === 'string' && username.trim()) {
      updateDoc.$set.username = username.trim();
    }
    if (typeof avatarUrl === 'string' && avatarUrl.trim()) {
      updateDoc.$set.avatarUrl = avatarUrl.trim();
    }

    // qq 一律取自 token，请求体里传什么都不作数。
    // 这里刻意不 upsert：以前会凭空造出一个没有 pin 的用户档案，
    // 而登录逻辑把「没有 pin」当成首次绑定，等于谁都能凭 QQ 号认领这个账号。
    const result = await db.collection('users').findOneAndUpdate(
      { qq: profile.qq },
      updateDoc,
      { returnDocument: 'after' }
    );

    if (!result) {
      return c.json({ code: 404, message: '用户档案不存在，请先使用 QQ 号登录' }, 404);
    }

    return c.json({ code: 0, message: '用户档案同步成功', data: result?.value ?? result }, 200);
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
    const profile = await loadProfile(c, c.get('claims'));
    const { newUsername } = await c.req.json().catch(() => ({}));
    const cleanName = String(newUsername || '').trim();

    if (!cleanName) {
      return c.json({ code: 400, message: '昵称不能为空' }, 400);
    }
    if (cleanName.length > 12) {
      return c.json({ code: 400, message: '昵称最多 12 个字' }, 400);
    }

    const db = await getDatabase(c);
    const now = Date.now();

    await db.collection('users').updateOne(
      { qq: profile.qq },
      { $set: { username: cleanName, lastActiveAt: now, updatedAt: now } },
      { upsert: true }
    );

    return c.json({
      code: 0,
      message: '昵称更新成功',
      username: cleanName,
      data: { qq: profile.qq, username: cleanName, avatarUrl: profile.avatarUrl }
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
    const db = await getDatabase(c);

    const history = await db.collection('room_logs')
      .find({})
      .sort({ startedAt: -1 })
      .limit(limit)
      .project({
        roomId: 1,
        publisher: 1,
        inviter: 1,
        hostAvatarUrl: 1,
        startedAt: 1,
        endedAt: 1,
        status: 1
      })
      .toArray();

    return c.json({ code: 0, data: history }, 200);
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
    const profile = await loadProfile(c, c.get('claims'));
    const res = await getHubStub(c.env).fetch('https://room-hub/state');
    const snapshot = await res.json();

    // 权威状态说没有房间，但历史里还有 active —— 那是房主被超时回收了
    if (!snapshot.room) {
      await sweepStaleRoomLogs(c);
    }

    return c.json({ code: 0, ...snapshot, me: profile }, 200);
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
    const profile = await loadProfile(c, c.get('claims'));
    const { roomId, inviter, secret, deepLink, serverUrl } = await c.req.json().catch(() => ({}));

    const cleanRoomId = String(roomId || '').trim();
    if (!cleanRoomId || !deepLink) {
      return c.json({ code: 400, message: '缺少房间链接或房间号' }, 400);
    }
    if (!String(secret || '').trim()) {
      return c.json({ code: 400, message: '未解析到房间密钥' }, 400);
    }

    const res = await getHubStub(c.env).fetch('https://room-hub/host/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user: profile,
        roomId: cleanRoomId,
        inviter,
        secret,
        deepLink,
        serverUrl
      })
    });

    const data = await res.json();

    // 只有 RoomHub 确认房间归我（没被 409 挡下）才记历史
    if (res.ok) {
      await openRoomLog(c, {
        roomId: cleanRoomId,
        publisher: profile.username,
        inviter: inviter || profile.username,
        hostAvatarUrl: profile.avatarUrl,
        deepLink
      });
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
      await endActiveRoomLog(c, 'manual');
    }

    return c.json(data, res.status);
  } catch (error) {
    console.error('[Host Stop Error]', error);
    return c.json({ code: 500, message: '关房失败' }, 500);
  }
});

export { RoomHub } from './room-hub.js';

export default app;
