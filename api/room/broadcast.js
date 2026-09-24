import https from 'https';
import { redis, REDIS_ROOM_KEY } from '../../lib/redis.js';
import { getDatabase } from '../../lib/mongodb.js';
import { ObjectId } from 'mongodb';

const ROOM_LEASE_SECONDS = 30;

/**
 * 云端精准探活：使用 Node 原生协议握手探测房间是否存活
 * 在海外 Vercel 执行，毫秒级响应且无任何网络墙阻断
 */
function probeNeriRoomOnCloud(serverUrl, roomId, secret) {
  return new Promise((resolve) => {
    try {
      const url = new URL(serverUrl || 'https://neriplayer.hancat.work');
      const req = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        path: `/?roomId=${roomId}&secret=${secret || ''}&nickname=ProbeBot`,
        method: 'GET',
        headers: {
          'Connection': 'Upgrade',
          'Upgrade': 'websocket',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10) NeriPlayer/1.0'
        },
        timeout: 3000
      });

      // 收到 101 Switching Protocols，说明房间确实存在且密钥有效！
      req.on('upgrade', (res, socket) => {
        socket.destroy();
        resolve({ alive: true });
      });

      // 收到普通的 HTTP 响应（说明拒绝升级），400/403/404 判定为死房间
      req.on('response', (res) => {
        if (res.statusCode === 400 || res.statusCode === 403 || res.statusCode === 404) {
          resolve({ alive: false, statusCode: res.statusCode });
        } else {
          resolve({ alive: true });
        }
      });

      req.on('error', (err) => {
        console.warn('[Cloud Probe 警告] 探测网络轻微抖动，降级放行:', err.message);
        resolve({ alive: true }); // 网络抖动不误杀真实房间
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ alive: true });
      });

      req.end();
    } catch (e) {
      resolve({ alive: true });
    }
  });
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ code: 405, message: '仅支持 POST 请求' });
  }

  try {
    const { action, username, roomId, inviter, publisher, secret, deepLink, serverUrl } = req.body || {};

    if (!action) {
      return res.status(400).json({ code: 400, message: '缺少 action 参数' });
    }

    const currentRoomRaw = await redis.get(REDIS_ROOM_KEY);
    const currentRoom = currentRoomRaw
      ? (typeof currentRoomRaw === 'string' ? JSON.parse(currentRoomRaw) : currentRoomRaw)
      : null;

    // =========================================================================
    // 1. 开启放歌 (start)
    // =========================================================================
    if (action === 'start') {
      const roomOwner = currentRoom ? (currentRoom.publisher || currentRoom.inviter) : null;
      if (currentRoom && roomOwner !== username) {
        return res.status(409).json({
          code: 409,
          message: `当前房间已被【${currentRoom.inviter || roomOwner}】占用`
        });
      }

      if (!deepLink || !roomId) {
        return res.status(400).json({ code: 400, message: '缺少房间链接或房间号' });
      }

      // 🌟 云端核心核验：拦截伪造/过期的死口令
      const probeResult = await probeNeriRoomOnCloud(serverUrl, roomId, secret);
      if (!probeResult.alive) {
        return res.status(400).json({
          code: 400,
          message: '该 NeriPlayer 房间不存在或口令已失效！'
        });
      }

      let hostAvatarUrl = '';
      let mongoLogId = null;
      const now = new Date();

      // 安全包裹 MongoDB（容错降级，即便数据库偶尔抖动也不阻断放歌）
      try {
        const db = await getDatabase();
        const users = db.collection('users');
        const roomLogs = db.collection('room_logs');

        const userDoc = await users.findOne({ username });
        if (userDoc?.avatarUrl) {
          hostAvatarUrl = userDoc.avatarUrl;
        }

        const insertResult = await roomLogs.insertOne({
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
      } catch (err) {
        console.warn('[MongoDB 警告] 记录日志失败，继续放歌业务:', err.message);
      }

      // 核心业务：写入 Redis 极速广播
      const newRoomPayload = {
        roomId,
        inviter: inviter || username,
        publisher: username,
        hostAvatarUrl,
        secret: secret || '',
        deepLink,
        mongoLogId,
        updatedAt: Math.floor(now.getTime() / 1000)
      };

      await redis.set(REDIS_ROOM_KEY, JSON.stringify(newRoomPayload), {
        ex: ROOM_LEASE_SECONDS
      });

      return res.status(200).json({
        code: 0,
        message: '房间开播成功',
        data: newRoomPayload
      });
    }

    // =========================================================================
    // 2. 房主心跳续期 (heartbeat)
    // =========================================================================
    if (action === 'heartbeat') {
      const roomOwner = currentRoom ? (currentRoom.publisher || currentRoom.inviter) : null;
      if (currentRoom && roomOwner === username) {
        currentRoom.updatedAt = Math.floor(Date.now() / 1000);
        await redis.set(REDIS_ROOM_KEY, JSON.stringify(currentRoom), {
          ex: ROOM_LEASE_SECONDS
        });
        return res.status(200).json({ code: 0, message: '续期成功' });
      }
      return res.status(404).json({ code: 404, message: '房间已失效或不是房主' });
    }

    // =========================================================================
    // 3. 关闭房间 (stop / expire)
    // =========================================================================
    if (action === 'stop' || action === 'expire') {
      const roomOwner = currentRoom ? (currentRoom.publisher || currentRoom.inviter) : null;
      if (currentRoom && roomOwner === username) {
        await redis.del(REDIS_ROOM_KEY);
        if (currentRoom.mongoLogId) {
          try {
            const db = await getDatabase();
            await db.collection('room_logs').updateOne(
              { _id: new ObjectId(currentRoom.mongoLogId) },
              {
                $set: {
                  status: 'ended',
                  endedAt: new Date(),
                  endReason: action === 'stop' ? 'manual' : 'timeout'
                }
              }
            );
          } catch (e) {
            console.warn('[MongoDB 警告] 归档失败:', e.message);
          }
        }
        return res.status(200).json({ code: 0, message: '房间已释放并归档' });
      }
      return res.status(200).json({ code: 0, message: '非房主请求已忽略' });
    }

    return res.status(200).json({ code: 0, message: 'ok' });
  } catch (error) {
    console.error('[Broadcast Error]', error);
    return res.status(500).json({ code: 500, message: '服务器内部错误' });
  }
}