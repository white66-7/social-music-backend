// api/room/broadcast.js 或 pages/api/room/broadcast.js
import { redis, REDIS_ROOM_KEY } from '../../lib/redis.js';
import { getDatabase } from '../../lib/mongodb.js';
import { ObjectId } from 'mongodb';

// Redis 租约 30 秒（容忍网络抖动，心跳一般每 5~8 秒发送一次）
const ROOM_LEASE_SECONDS = 30;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ code: 405, message: '仅支持 POST 请求' });
  }

  try {
    const { action, username, roomId, inviter, publisher, secret, deepLink } = req.body || {};

    if (!action) {
      return res.status(400).json({ code: 400, message: '缺少 action 参数' });
    }

    const currentRoomRaw = await redis.get(REDIS_ROOM_KEY);
    const currentRoom = currentRoomRaw
      ? (typeof currentRoomRaw === 'string' ? JSON.parse(currentRoomRaw) : currentRoomRaw)
      : null;

    const db = await getDatabase();
    const roomLogs = db.collection('room_logs');
    const users = db.collection('users');

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

      // 尝试从 MongoDB 取房主的最新真实头像
      let hostAvatarUrl = '';
      try {
        const userDoc = await users.findOne({ username });
        if (userDoc?.avatarUrl) {
          hostAvatarUrl = userDoc.avatarUrl;
        }
      } catch (err) {
        console.warn('获取房主头像失败 (非致命):', err.message);
      }

      const now = new Date();

      // 1.1 写入 MongoDB 沉淀开播流水（生成 mongoLogId）
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

      const mongoLogId = insertResult.insertedId.toString();

      // 1.2 写入 Redis 供前端毫秒级极速广播
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

      // 只有真正的房主才能续期
      if (currentRoom && roomOwner === username) {
        currentRoom.updatedAt = Math.floor(Date.now() / 1000);

        // 仅原地续期 Redis，绝不在 Mongo 中插入新日志，0 空间损耗！
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

      // 严格鉴权：只有房主本人调用才能销毁房间！听众误发直接忽略
      if (currentRoom && roomOwner === username) {
        // 3.1 删除 Redis 实时状态
        await redis.del(REDIS_ROOM_KEY);

        // 3.2 归档 MongoDB 中的对应场次为 ended
        if (currentRoom.mongoLogId) {
          try {
            await roomLogs.updateOne(
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
            console.warn('归档房间日志异常:', e.message);
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