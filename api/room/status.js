import { redis, REDIS_ROOM_KEY } from '../../lib/redis.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ code: 405, message: '仅支持 GET 请求' });
  }

  try {
    const roomData = await redis.get(REDIS_ROOM_KEY);

    if (!roomData) {
      return res.status(200).json({ exists: false });
    }

    const room = typeof roomData === 'string' ? JSON.parse(roomData) : roomData;

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