import crypto from 'crypto';
import { redis, REDIS_ROOM_KEY } from '../../lib/redis.js';
import { getDatabase } from '../../lib/mongodb.js';
import { ObjectId } from 'mongodb';

const PROBE_COOLDOWN_MS = 15 * 1000;

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
      signal: AbortSignal.timeout(3000)
    });

    const joinText = await joinResponse.text();
    let result = null;
    try {
      result = JSON.parse(joinText);
    } catch (_) {}

    if (!joinResponse.ok || !result || result.ok !== true) {
      return { alive: false };
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
    return { alive: false };
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ code: 405, message: '仅支持 GET 请求' });
  }

  try {
    const isForce = req.query.force === 'true';
    const currentRoomRaw = await redis.get(REDIS_ROOM_KEY);

    if (!currentRoomRaw) {
      return res.status(200).json({ exists: false });
    }

    const currentRoom = typeof currentRoomRaw === 'string' ? JSON.parse(currentRoomRaw) : currentRoomRaw;
    const now = Date.now();
    const lastProbedAt = currentRoom.lastProbedAt || 0;

    const needProbe = isForce || (now - lastProbedAt > PROBE_COOLDOWN_MS);

    if (needProbe && currentRoom.roomId) {
      const probe = await probeNeriRoomOnCloud(
        currentRoom.serverUrl,
        currentRoom.roomId,
        currentRoom.secret
      );

      if (!probe.alive) {
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
                  endReason: 'cloud_probe_dead'
                }
              }
            );
          } catch (e) {
            console.warn('[MongoDB 警告] 归档失败:', e.message);
          }
        }

        return res.status(200).json({ exists: false, message: '房间已关闭或失效' });
      }

      currentRoom.lastProbedAt = now;
      try {
        await redis.set(REDIS_ROOM_KEY, JSON.stringify(currentRoom), { keepttl: true });
      } catch (_) {
        await redis.set(REDIS_ROOM_KEY, JSON.stringify(currentRoom), { ex: 12 });
      }
    }

    return res.status(200).json({
      exists: true,
      inviter: currentRoom.inviter,
      publisher: currentRoom.publisher,
      hostAvatarUrl: currentRoom.hostAvatarUrl,
      deepLink: currentRoom.deepLink,
      roomId: currentRoom.roomId
    });
  } catch (error) {
    console.error('[Room Status API Error]', error);
    return res.status(500).json({ code: 500, message: '服务器内部错误' });
  }
}