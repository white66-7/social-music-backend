import { redis, REDIS_ROOM_KEY } from '../../lib/redis.js';

const ROOM_TTL_SECONDS = 7200; 

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
      if (currentRoom && currentRoom.inviter !== username) {
        return res.status(409).json({
          code: 409,
          message: `当前房间已被【${currentRoom.inviter}】占用`
        });
      }

      if (!deepLink || !roomId) {
        return res.status(400).json({ code: 400, message: '缺少房间链接或房间号' });
      }

      // 解析口令里是否有自定义 baseUrl
      let serverUrl = 'https://neriplayer.hancat.work';
      try {
        const queryPart = deepLink.split('?')[1] || '';
        const params = new URLSearchParams(queryPart);
        if (params.get('baseUrl')) {
          serverUrl = decodeURIComponent(params.get('baseUrl'));
        }
      } catch (e) {}

      const newRoomPayload = {
        roomId,
        inviter: inviter || username,
        secret: secret || '',
        deepLink,
        serverUrl,
        updatedAt: Math.floor(Date.now() / 1000)
      };

      await redis.set(REDIS_ROOM_KEY, JSON.stringify(newRoomPayload), {
        ex: ROOM_TTL_SECONDS
      });

      return res.status(200).json({ code: 0, message: '房间开播成功', data: newRoomPayload });
    }

    // 房主在 App 里主动点结束
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