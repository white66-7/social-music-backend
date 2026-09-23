import { redis, REDIS_ROOM_KEY } from '../../lib/redis.js';

const DEFAULT_NERI_SERVER = 'https://neriplayer.hancat.work';

// 毫秒级探活函数
async function isNeriRoomAlive(serverUrl, roomId) {
  try {
    const baseUrl = (serverUrl || DEFAULT_NERI_SERVER).replace(/\/+$/, '');
    const probeUrl = `${baseUrl}/api/rooms/${roomId}/state`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1800); // 1.8 秒超时控制

    const resp = await fetch(probeUrl, {
      method: 'GET',
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (resp.status === 401 || resp.ok) {
      return true;
    }
    // 404 / 410 说明房主已解散房间或房间已过期
    if (resp.status === 404 || resp.status === 410) {
      return false;
    }

    return false;
  } catch (e) {
    // 遇到外部网络抖动或超时，友好宽容处理，避免误删
    return true; 
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ code: 405, message: '仅支持 GET 请求' });
  }

  try {
    const roomData = await redis.get(REDIS_ROOM_KEY);

    if (!roomData) {
      return res.status(200).json({ exists: false });
    }

    const room = typeof roomData === 'string' ? JSON.parse(roomData) : roomData;

    // 【后端代查核心】：向 NeriPlayer 服务端核实真实存活状态
    const alive = await isNeriRoomAlive(room.serverUrl, room.roomId);

    if (!alive) {
      // 官方服务端判定房间已不存在，自动清理 Redis
      await redis.del(REDIS_ROOM_KEY);
      return res.status(200).json({ exists: false });
    }

    return res.status(200).json({
      exists: true,
      roomId: room.roomId,
      inviter: room.inviter,
      deepLink: room.deepLink,
      updatedAt: room.updatedAt || Math.floor(Date.now() / 1000)
    });
  } catch (error) {
    console.error('[Get Status Error]', error);
    return res.status(200).json({ exists: false });
  }
}