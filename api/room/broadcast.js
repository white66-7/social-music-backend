import { redis, REDIS_ROOM_KEY } from '../../lib/redis.js';

const ROOM_TTL_SECONDS = 20; // 20 秒超时销毁

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ code: 405, message: '仅支持 POST 请求' });
  }

  try {
    const { action, username, roomId, inviter, secret, deepLink } = req.body || {};

    if (!action) {
      return res.status(400).json({ code: 400, message: '缺少 action 参数' });
    }

    const currentRoomRaw = await redis.get(REDIS_ROOM_KEY);
    const currentRoom = currentRoomRaw
      ? (typeof currentRoomRaw === 'string' ? JSON.parse(currentRoomRaw) : currentRoomRaw)
      : null;

    if (action === 'start') {
      // 平权机制：若已有其他人正在开播，禁止覆盖
      if (currentRoom && currentRoom.inviter !== username) {
        return res.status(409).json({
          code: 409,
          message: `当前房间已被【${currentRoom.inviter}】占用，请等待其放歌结束`
        });
      }

      if (!deepLink || !roomId) {
        return res.status(400).json({ code: 400, message: '缺少房间链接或房间号' });
      }

      const newRoomPayload = {
        roomId,
        inviter: inviter || username,
        secret: secret || '',
        deepLink,
        updatedAt: Math.floor(Date.now() / 1000)
      };

      // 写入并设置 20 秒 TTL 过期
      await redis.set(REDIS_ROOM_KEY, JSON.stringify(newRoomPayload), {
        ex: ROOM_TTL_SECONDS
      });

      return res.status(200).json({ code: 0, message: '房间开播成功', data: newRoomPayload });
    }

    // -------------------------------------------------------------
    // 动作 2：心跳保活 (heartbeat)
    // -------------------------------------------------------------
    if (action === 'heartbeat') {
      if (!currentRoom) {
        return res.status(404).json({ code: 404, message: '房间已过期或不存在' });
      }

      // 仅允许房主本人保活
      if (currentRoom.inviter !== username) {
        return res.status(403).json({ code: 403, message: '无权操作他人房间心跳' });
      }

      currentRoom.updatedAt = Math.floor(Date.now() / 1000);

      // 刷新 20 秒 TTL
      await redis.set(REDIS_ROOM_KEY, JSON.stringify(currentRoom), {
        ex: ROOM_TTL_SECONDS
      });

      return res.status(200).json({ code: 0, message: '心跳更新成功' });
    }

    // -------------------------------------------------------------
    // 动作 3：主动下线结束 (stop)
    // -------------------------------------------------------------
    if (action === 'stop') {
      if (currentRoom && currentRoom.inviter === username) {
        await redis.del(REDIS_ROOM_KEY);
      }
      return res.status(200).json({ code: 0, message: '房间已关闭' });
    }

    return res.status(400).json({ code: 400, message: `未知操作: ${action}` });

  } catch (error) {
    console.error('[Broadcast Error]', error);
    return res.status(500).json({ code: 500, message: '服务器内部错误' });
  }
}