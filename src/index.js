import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ObjectId } from 'mongodb';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

import { getDatabase } from './lib/mongodb.js';
import { getRedis, REDIS_ROOM_KEY, loadRoom, renewRoom } from './lib/redis.js';
import { checkRoomExists, verifyRoomSecret } from './lib/neri.js';

const app = new Hono();

// 1. 全局 CORS 配置
app.use('*', cors({
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
}));

// 辅助函数：安全归档日志（全面隔离，即使出错也不中断响应）
async function archiveRoomLog(env, room, endReason) {
  if (!room?.mongoLogId) return;
  try {
    const db = await getDatabase(env);
    await db.collection('room_logs').updateOne(
      { _id: new ObjectId(room.mongoLogId) },
      { $set: { status: 'ended', endedAt: new Date(), endReason } }
    );
  } catch (e) {
    console.warn('[MongoDB 警告] 归档日志失败:', e.message);
  }
}

// ----------------------------------------------------
// 路由：/api/broadcast (⚡ 极速稳定版，无审核助手，杜绝 500)
// ----------------------------------------------------
app.post('/api/broadcast', async (c) => {
  const env = c.env;
  const redis = getRedis(env);

  try {
    const body = await c.req.json().catch(() => ({}));
    const { action, username, roomId, inviter, publisher, secret, deepLink, serverUrl, resume } = body;

    if (!action) {
      return c.json({ code: 400, message: '缺少 action 参数' }, 400);
    }

    const currentRoom = await loadRoom(redis);

    if (action === 'start') {
      const roomOwner = currentRoom ? (currentRoom.publisher || currentRoom.inviter) : null;
      // 如果当前已有其他人在放歌，且不是当前申请人
      if (currentRoom && roomOwner && roomOwner !== username) {
        return c.json({
          code: 409,
          message: `当前已有其他人在放歌【${currentRoom.inviter || roomOwner}】`
        }, 409);
      }

      if (!deepLink || !roomId) {
        return c.json({ code: 400, message: '缺少房间链接或房间号' }, 400);
      }

      let hostAvatarUrl = '';
      let mongoLogId = null;
      const now = new Date();

      // ⚡ 将 MongoDB 彻底隔离包裹：即使 Mongo 断连、超时，绝不阻断开播！
      try {
        const db = await getDatabase(env);

        if (username) {
          const key = String(username);
          const host = await db.collection('users').findOne(
            { $or: [{ qq: key }, { username: key }] },
            { projection: { avatarUrl: 1 } }
          );
          if (host?.avatarUrl) hostAvatarUrl = host.avatarUrl;
        }

        if (resume) {
          const existing = await db.collection('room_logs').findOne(
            { roomId, publisher: username, status: 'active' },
            { sort: { startedAt: -1 }, projection: { _id: 1 } }
          );
          if (existing) mongoLogId = existing._id.toString();
        }

        if (!mongoLogId) {
          const insertResult = await db.collection('room_logs').insertOne({
            roomId,
            publisher: username,
            inviter: inviter || username,
            hostAvatarUrl,
            deepLink,
            status: 'active',
            startedAt: now,
            endedAt: null,
            endReason: null,
          });
          mongoLogId = insertResult.insertedId.toString();
        }
      } catch (dbErr) {
        console.warn('[MongoDB 警告] 用户查询或写入日志失败（已跳过，保证开播）:', dbErr.message);
      }

      // ⚡ 构建广播载荷：直接采用前端提交的信息，秒级上线
      const newRoomPayload = {
        roomId,
        inviter: inviter || username,
        publisher: username,
        hostAvatarUrl,
        secret: secret || '',
        deepLink,
        serverUrl: serverUrl || '',
        currentSong: body.currentSong || currentRoom?.currentSong || null,
        currentCover: body.currentCover || currentRoom?.currentCover || null,
        durationMs: body.durationMs || currentRoom?.durationMs || 0,
        basePositionMs: body.basePositionMs || currentRoom?.basePositionMs || 0,
        baseTimestampMs: now.getTime(),
        playbackRate: 1,
        isPlaying: true,
        mongoLogId,
        lastProbedAt: now.getTime(),
        lastStateSyncAt: now.getTime(),
        lastHeartbeatAt: now.getTime(),
        updatedAt: Math.floor(now.getTime() / 1000)
      };

      // 写入 Redis 缓存
      await renewRoom(redis, newRoomPayload);

      return c.json({
        code: 0,
        message: '房间开播成功',
        data: newRoomPayload
      }, 200);
    }

    if (action === 'heartbeat') {
      const roomOwner = currentRoom ? (currentRoom.publisher || currentRoom.inviter) : null;
      if (currentRoom && roomOwner === username) {
        const now = Date.now();
        currentRoom.updatedAt = Math.floor(now / 1000);
        currentRoom.lastHeartbeatAt = now;

        // 如果客户端在心跳中顺带携带了正在播放的歌曲，更新至 Redis
        if (body.currentSong !== undefined) {
          currentRoom.currentSong = body.currentSong;
          currentRoom.currentCover = body.currentCover;
          currentRoom.durationMs = body.durationMs || 0;
          currentRoom.basePositionMs = body.basePositionMs || 0;
          currentRoom.baseTimestampMs = now;
          currentRoom.isPlaying = body.isPlaying ?? true;
          currentRoom.playbackRate = body.playbackRate || 1;
        }

        await renewRoom(redis, currentRoom);
        return c.json({ code: 0, message: '续期成功' }, 200);
      }
      return c.json({ code: 404, message: '房间已失效或不是房主' }, 404);
    }

    if (action === 'stop' || action === 'expire') {
      const roomOwner = currentRoom ? (currentRoom.publisher || currentRoom.inviter) : null;
      if (currentRoom && roomOwner === username) {
        await redis.del(REDIS_ROOM_KEY);
        await archiveRoomLog(env, currentRoom, action === 'stop' ? 'manual' : 'timeout');
        return c.json({ code: 0, message: '房间已释放并归档' }, 200);
      }
      return c.json({ code: 0, message: '非房主请求已忽略' }, 200);
    }

    return c.json({ code: 0, message: 'ok' }, 200);
  } catch (error) {
    console.error('[Broadcast API Error]', error);
    return c.json({ code: 500, message: `服务器开播异常: ${error.message}` }, 500);
  }
});

// ----------------------------------------------------
// 路由：/api/room/status (⚡ 纯净只读版，2ms 极速响应)
// ----------------------------------------------------
app.get('/api/room/status', async (c) => {
  const env = c.env;

  try {
    const redis = getRedis(env);
    const currentRoom = await loadRoom(redis);

    if (!currentRoom || !currentRoom.roomId) {
      return c.json({ exists: false }, 200);
    }

    const now = Date.now();
    let estimatedPosition = currentRoom.basePositionMs || 0;
    if (currentRoom.isPlaying && currentRoom.baseTimestampMs) {
      estimatedPosition += (now - currentRoom.baseTimestampMs) * (currentRoom.playbackRate || 1);
    }

    return c.json({
      exists: true,
      inviter: currentRoom.inviter,
      publisher: currentRoom.publisher,
      hostAvatarUrl: currentRoom.hostAvatarUrl,
      deepLink: currentRoom.deepLink,
      roomId: currentRoom.roomId,
      secret: currentRoom.secret || '', // ⚡ 派发密钥供前端 WebSocket 直连
      serverUrl: currentRoom.serverUrl || '',
      currentSong: currentRoom.currentSong || null,
      currentCover: currentRoom.currentCover || null,
      durationMs: currentRoom.durationMs || 0,
      basePositionMs: currentRoom.basePositionMs || 0,
      baseTimestampMs: currentRoom.baseTimestampMs || now,
      playbackRate: currentRoom.playbackRate || 1,
      isPlaying: currentRoom.isPlaying ?? true,
    }, 200);

  } catch (error) {
    console.error('[Room Status API Error]', error);
    return c.json({ exists: false }, 200);
  }
});

// ----------------------------------------------------
// 路由：/api/room/history
// ----------------------------------------------------
app.get('/api/room/history', async (c) => {
  try {
    const limit = Math.min(parseInt(c.req.query('limit')) || 10, 30);
    const db = await getDatabase(c.env);

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

// ----------------------------------------------------
// 路由：/api/auth/login
// ----------------------------------------------------
app.post('/api/auth/login', async (c) => {
  const env = c.env;
  const redis = getRedis(env);
  const jwtSecret = env.JWT_SECRET || 'white667-social-music-secure-jwt-key';

  try {
    const { qq, username, pin } = await c.req.json().catch(() => ({}));
    const rawAccount = qq || username;
    const cleanQq = String(rawAccount || '').trim();
    const cleanPin = String(pin || '').trim();

    if (!cleanQq || !/^[1-9][0-9]{4,11}$/.test(cleanQq)) {
      return c.json({ code: 400, message: '请输入合法的 QQ 号码' }, 400);
    }

    if (!cleanPin || cleanPin.length !== 4) {
      return c.json({ code: 400, message: '请输入 4 位专属口令' }, 400);
    }

    const failRateKey = `login:fail:${cleanQq}`;
    const failCount = await redis.get(failRateKey);
    if (failCount && parseInt(failCount, 10) >= 5) {
      return c.json({ code: 429, message: '口令错误次数过多，请 10 分钟后再试' }, 429);
    }

    const db = await getDatabase(env);
    const usersCollection = db.collection('users');
    const existingUser = await usersCollection.findOne({ qq: cleanQq });

    if (existingUser) {
      const storedPin = typeof existingUser.pin === 'string' ? existingUser.pin : '';
      const isFirstBind = storedPin.length === 0;
      const isMatch = isFirstBind || (storedPin.startsWith('$2')
        ? await bcrypt.compare(cleanPin, storedPin)
        : storedPin === cleanPin);

      if (!isMatch) {
        await redis.incr(failRateKey);
        await redis.expire(failRateKey, 600);
        return c.json({ code: 403, message: '口令错误' }, 403);
      }

      await redis.del(failRateKey);

      const updateData = { lastActiveAt: Date.now() };
      if (isFirstBind || !storedPin.startsWith('$2')) {
        updateData.pin = await bcrypt.hash(cleanPin, 10);
      }

      await usersCollection.updateOne({ qq: cleanQq }, { $set: updateData });

      const token = jwt.sign(
        { qq: existingUser.qq, username: existingUser.username },
        jwtSecret,
        { expiresIn: '30d' }
      );

      const { pin: _, _id, ...safeUser } = existingUser;

      return c.json({
        code: 0,
        message: isFirstBind ? '首次认证并绑定成功' : '登录成功',
        token,
        user: safeUser
      }, 200);
    }

    const shortQq = cleanQq.slice(-4);
    const defaultNickname = `网友_${shortQq}`;
    const avatarUrl = `https://q1.qlogo.cn/g?b=qq&nk=${cleanQq}&s=640`;
    const hashedPin = await bcrypt.hash(cleanPin, 10);

    const newUser = {
      qq: cleanQq,
      username: defaultNickname,
      avatarUrl: avatarUrl,
      pin: hashedPin,
      createdAt: Date.now(),
      lastActiveAt: Date.now()
    };

    await usersCollection.insertOne(newUser);
    await redis.del(failRateKey);

    const token = jwt.sign(
      { qq: newUser.qq, username: newUser.username },
      jwtSecret,
      { expiresIn: '30d' }
    );

    const { pin: _, _id, ...safeUser } = newUser;

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
// 路由：/api/user/list
// ----------------------------------------------------
app.get('/api/user/list', async (c) => {
  const env = c.env;
  const redis = getRedis(env);

  try {
    const dbPromise = getDatabase(env).then(db =>
      db.collection('users')
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
        .toArray()
    );

    const roomPromise = redis.get(REDIS_ROOM_KEY).catch(() => null);
    const [users, currentRoomRaw] = await Promise.all([dbPromise, roomPromise]);

    let currentHost = null;
    if (currentRoomRaw) {
      try {
        const room = typeof currentRoomRaw === 'string' ? JSON.parse(currentRoomRaw) : currentRoomRaw;
        currentHost = room?.publisher || room?.inviter || null;
      } catch (_) {}
    }

    const dataList = (users || []).map(m => ({
      qq: m.qq,
      username: m.username || `网友_${String(m.qq).slice(-4)}`,
      avatarUrl: m.avatarUrl || `https://q1.qlogo.cn/g?b=qq&nk=${m.qq}&s=640`,
      isHosting: Boolean(currentHost && (m.username === currentHost || m.qq === currentHost)),
      lastActiveAt: m.lastActiveAt || 0
    }));

    return c.json({
      code: 0,
      total: dataList.length,
      data: dataList
    }, 200);

  } catch (error) {
    console.error('[User List API Error]', error);
    return c.json({ code: 500, message: '获取成员列表失败' }, 500);
  }
});

// ----------------------------------------------------
// 路由：/api/user/sync
// ----------------------------------------------------
app.post('/api/user/sync', async (c) => {
  try {
    const { qq, username, avatarUrl } = await c.req.json().catch(() => ({}));

    if (!username || typeof username !== 'string') {
      return c.json({ code: 400, message: '缺少合法的 username' }, 400);
    }

    const db = await getDatabase(c.env);
    const users = db.collection('users');

    const cleanName = username.trim();
    const cleanQq = String(qq || '').trim();
    const now = Date.now();

    const updateDoc = {
      $set: { lastActiveAt: now, updatedAt: now },
      $setOnInsert: { createdAt: now }
    };

    const cleanAvatar = typeof avatarUrl === 'string' ? avatarUrl.trim() : '';
    if (cleanAvatar) {
      updateDoc.$set.avatarUrl = cleanAvatar;
    }

    let result;

    if (cleanQq) {
      result = await users.findOneAndUpdate(
        { qq: cleanQq },
        {
          ...updateDoc,
          $setOnInsert: {
            ...updateDoc.$setOnInsert,
            qq: cleanQq,
            username: cleanName,
            avatarUrl: cleanAvatar || `https://q1.qlogo.cn/g?b=qq&nk=${cleanQq}&s=640`
          }
        },
        { upsert: true, returnDocument: 'after' }
      );
    } else {
      result = await users.findOneAndUpdate(
        { username: cleanName },
        updateDoc,
        { returnDocument: 'after' }
      );

      if (!result) {
        return c.json({ code: 404, message: '用户档案不存在，请先使用 QQ 号登录' }, 404);
      }
    }

    return c.json({
      code: 0,
      message: '用户档案同步成功',
      data: result?.value ?? result
    }, 200);
  } catch (error) {
    console.error('[User Sync Error]', error);
    return c.json({ code: 500, message: '服务器内部错误' }, 500);
  }
});

// ----------------------------------------------------
// 路由：/api/user/update-name
// ----------------------------------------------------
app.post('/api/user/update-name', async (c) => {
  try {
    const { qq, token, newUsername } = await c.req.json().catch(() => ({}));
    let targetQq = String(qq || '').trim();

    if (!targetQq && token) {
      const match = String(token).match(/^token_(\d+)_/);
      if (match) targetQq = match[1];
    }

    const cleanName = String(newUsername || '').trim();

    if (!targetQq) {
      return c.json({ code: 400, message: '无法识别用户身份' }, 400);
    }

    if (!cleanName) {
      return c.json({ code: 400, message: '昵称不能为空' }, 400);
    }

    if (cleanName.length > 12) {
      return c.json({ code: 400, message: '昵称最多 12 个字' }, 400);
    }

    const db = await getDatabase(c.env);
    const now = Date.now();

    const result = await db.collection('users').findOneAndUpdate(
      { qq: targetQq },
      {
        $set: { username: cleanName, lastActiveAt: now, updatedAt: now },
        $setOnInsert: {
          qq: targetQq,
          avatarUrl: `https://q1.qlogo.cn/g?b=qq&nk=${targetQq}&s=640`,
          createdAt: now
        }
      },
      { upsert: true, returnDocument: 'after' }
    );

    const user = result?.value ?? result;

    return c.json({
      code: 0,
      message: '昵称更新成功',
      username: cleanName,
      data: user ? { qq: user.qq, username: user.username, avatarUrl: user.avatarUrl } : undefined
    }, 200);
  } catch (err) {
    console.error('[Update Name Error]', err);
    return c.json({ code: 500, message: `服务器异常: ${err.message}` }, 500);
  }
});

export default app;