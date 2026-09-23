import { redis, REDIS_ROOM_KEY } from '../../lib/redis.js';

// 房间租约时长：15 秒（若房主超过 15 秒未发心跳，视为房间自然解散）
const ROOM_LEASE_SECONDS = 15;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
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

    // 1. 开启房间
    if (action === 'start') {
      if (currentRoom && currentRoom.inviter !== username) {
        return res.status(409).json({
          code: 409,
          message: `当前房间已被【${currentRoom.inviter}】占用`
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

      await redis.set(REDIS_ROOM_KEY, JSON.stringify(newRoomPayload), {
        ex: ROOM_LEASE_SECONDS
      });

      return res.status(200).json({ code: 0, message: '房间开播成功', data: newRoomPayload });
    }

    // 2. 房主心跳续期（每 5 秒发送一次）
    if (action === 'heartbeat') {
      if (currentRoom && currentRoom.inviter === username) {
        currentRoom.updatedAt = Math.floor(Date.now() / 1000);
        await redis.set(REDIS_ROOM_KEY, JSON.stringify(currentRoom), {
          ex: ROOM_LEASE_SECONDS
        });
        return res.status(200).json({ code: 0, message: '续期成功' });
      }
      return res.status(404).json({ code: 404, message: '房间已失效或不是房主' });
    }

    // 3. 主动关闭房间
    if (action === 'stop') {
      if (currentRoom && currentRoom.inviter === username) {
        await redis.del(REDIS_ROOM_KEY);
      }
      return res.status(200).json({ code: 0, message: '房间已关闭' });
    }

    return res.status(200).json({ code: 0, message: 'ok' });
  } catch (error) {
    console.error('[Broadcast Error]', error);
    return res.status(500).json({ code: 500, message: '服务器内部错误' });
  }
}