import { redis, REDIS_ROOM_KEY, loadRoom, renewRoom } from '../../lib/redis.js';
import { verifyRoomSecret } from '../../lib/neri.js';
import { getDatabase } from '../../lib/mongodb.js';
import { ObjectId } from 'mongodb';

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

      // 开播前唯一一次真核验：需要真的用 joinSecret 加入才能确认密钥正确。
      // 这会触发 NeriPlayer 的 autoPauseOnMemberChange（加入 + 退出各暂停一次），
      // 但此刻房间刚建、还没有听众，只影响房主自己，可以接受。
      // ⚠️ 绝不要把这条路径挪到轮询里，轮询必须用 lib/neri.js 的 checkRoomExists。
      const probeResult = await verifyRoomSecret(serverUrl, roomId, secret);
      if (!probeResult.ok) {
        return res.status(400).json({ code: 400, message: probeResult.message });
      }

      let hostAvatarUrl = '';
      let mongoLogId = null;
      const now = new Date();

      try {
        const db = await getDatabase();

        // 🌟 用户档案已迁至 MongoDB：按 QQ / 昵称双通道命中房主头像
        if (username) {
          const key = String(username);
          const host = await db.collection('users').findOne(
            { $or: [{ qq: key }, { username: key }] },
            { projection: { avatarUrl: 1 } }
          );
          if (host?.avatarUrl) hostAvatarUrl = host.avatarUrl;
        }

        const insertResult = await db.collection('room_logs').insertOne({
          roomId,
          publisher: username,
          inviter: inviter || username,
          hostAvatarUrl, // 与 GET /api/room/history 的投影字段对齐，否则历史记录头像恒为空
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
        // 心跳负责续租，这是房间存活的唯一依据
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
