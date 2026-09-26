import { redis, REDIS_ROOM_KEY, loadRoom, renewRoom } from '../../lib/redis.js';
import { checkRoomExists, verifyRoomSecret } from '../../lib/neri.js';
import { getDatabase } from '../../lib/mongodb.js';
import { ObjectId } from 'mongodb';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ code: 405, message: '仅支持 POST 请求' });
  }

  try {
    const { action, username, roomId, inviter, publisher, secret, deepLink, serverUrl, resume } = req.body || {};

    if (!action) {
      return res.status(400).json({ code: 400, message: '缺少 action 参数' });
    }

    const currentRoom = await loadRoom();

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

      let probeResult;
      if (resume) {
        const exists = await checkRoomExists(serverUrl, roomId);
        probeResult = exists === 'dead'
          ? { ok: false, message: '房间已关闭或不存在，无法恢复' }
          : {
              ok: true,
              currentSong: currentRoom?.currentSong || null,
              currentCover: currentRoom?.currentCover || null,
              durationMs: currentRoom?.durationMs || 0,
              basePositionMs: currentRoom?.basePositionMs || 0,
              baseTimestampMs: currentRoom?.baseTimestampMs || Date.now(),
              playbackRate: currentRoom?.playbackRate || 1,
              isPlaying: currentRoom?.isPlaying ?? true,
            };
      } else {
        probeResult = await verifyRoomSecret(serverUrl, roomId, secret);
      }

      if (!probeResult.ok) {
        return res.status(400).json({ code: 400, message: probeResult.message });
      }

      let hostAvatarUrl = '';
      let mongoLogId = null;
      const now = new Date();

      try {
        const db = await getDatabase();

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
        currentSong: probeResult.currentSong || null, 
        currentCover: probeResult.currentCover || null,
        durationMs: probeResult.durationMs || 0,
        basePositionMs: probeResult.basePositionMs || 0,
        baseTimestampMs: probeResult.baseTimestampMs || now.getTime(),
        playbackRate: probeResult.playbackRate || 1,
        isPlaying: probeResult.isPlaying ?? true,
        mongoLogId,
        lastProbedAt: now.getTime(),
        lastStateSyncAt: now.getTime(),
        lastHeartbeatAt: now.getTime(),
        updatedAt: Math.floor(now.getTime() / 1000)
      };

      await renewRoom(newRoomPayload);

      return res.status(200).json({
        code: 0,
        message: '房间开播成功',
        data: newRoomPayload
      });
    }

    if (action === 'heartbeat') {
      const roomOwner = currentRoom ? (currentRoom.publisher || currentRoom.inviter) : null;
      if (currentRoom && roomOwner === username) {
        const now = Date.now();
        currentRoom.updatedAt = Math.floor(now / 1000);
        currentRoom.lastHeartbeatAt = now;
        await renewRoom(currentRoom);
        return res.status(200).json({ code: 0, message: '续期成功' });
      }
      return res.status(404).json({ code: 404, message: '房间已失效或不是房主' });
    }

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
    console.error('[Broadcast API Error]', error);
    return res.status(500).json({ code: 500, message: '服务器内部错误' });
  }
}