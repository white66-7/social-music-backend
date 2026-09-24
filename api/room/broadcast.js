import crypto from 'crypto';
import { redis, REDIS_ROOM_KEY } from '../../lib/redis.js';
import { getDatabase } from '../../lib/mongodb.js';
import { ObjectId } from 'mongodb';

const ROOM_LEASE_SECONDS = 12;

async function probeNeriRoomOnCloud(serverUrl, roomId, secret) {
  try {
    let base = (serverUrl || 'https://neriplayer.hancat.work').trim();
    if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
    base = base.replace(/\/+$/, '');

    const userUuid = crypto.randomUUID();
    const joinUrl = `${base}/api/rooms/${encodeURIComponent(roomId)}/join`;

    const joinResponse = await fetch(joinUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10) NeriPlayer/1.0',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        userUuid: userUuid,
        nickname: '审核助手',
        joinSecret: (secret || '').trim()
      }),
      signal: AbortSignal.timeout(3500)
    });

    const joinText = await joinResponse.text();
    let result = null;
    try {
      result = JSON.parse(joinText);
    } catch (_) {}

    if (!joinResponse.ok || !result || result.ok !== true) {
      let errMsg = '该 NeriPlayer 房间不存在或口令已失效';
      if (result?.error) {
        const errLower = result.error.toLowerCase();
        if (errLower.includes('secret') || errLower.includes('unauthorized')) {
          errMsg = '房间口令/密钥错误或已失效';
        } else if (errLower.includes('not found') || errLower.includes('room missing')) {
          errMsg = '房间已关闭或房主已离开';
        } else {
          errMsg = `房间拒绝: ${result.error}`;
        }
      }
      return { alive: false, message: errMsg };
    }

    const token = result.token;
    if (token) {
      fetch(`${base}/api/rooms/${encodeURIComponent(roomId)}/leave`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10) NeriPlayer/1.0'
        },
        body: JSON.stringify({})
      }).catch(() => {});
    }

    return { alive: true };
  } catch (error) {
    return {
      alive: false,
      message: `核验超时或无法连通节点: ${error.message || '请检查服务器配置'}`
    };
  }
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

    // 1. 开启放歌 (start)
    if (action === 'start') {
      const roomOwner = currentRoom ? (currentRoom.publisher || currentRoom.inviter) : null;
      if (currentRoom && roomOwner !== username) {
        return res.status(409).json({
          code: 409,
          message: `当前已有其他人在放歌【${currentRoom.inviter || roomOwner}】`
        });
      }

      if (!deepLink || !roomId) {
        return res.status(400).json({ code: 400, message: '缺少房间链接或房间号' });
      }

      const probeResult = await probeNeriRoomOnCloud(serverUrl, roomId, secret);
      if (!probeResult.alive) {
        return res.status(400).json({
          code: 400,
          message: probeResult.message
        });
      }

      let hostAvatarUrl = '';
      let mongoLogId = null;
      const now = new Date();

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
        console.warn('[MongoDB 警告] 记录日志失败:', err.message);
      }

      const newRoomPayload = {
        roomId,
        inviter: inviter || username,
        publisher: username,
        hostAvatarUrl,
        secret: secret || '',
        deepLink,
        serverUrl: serverUrl || '',
        mongoLogId,
        lastProbedAt: now.getTime(),
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

    // 2. 房主心跳 (heartbeat)
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

    // 3. 关闭房间 (stop / expire)
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