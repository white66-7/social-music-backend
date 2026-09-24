// api/room/status.js 或 pages/api/room/status.js
import { redis, REDIS_ROOM_KEY } from '../../lib/redis.js';
import { getDatabase } from '../../lib/mongodb.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ code: 405, message: '仅支持 GET 请求' });
  }

  try {
    const roomData = await redis.get(REDIS_ROOM_KEY);

    // 1. 如果当前有人正在放歌
    if (roomData) {
      const room = typeof roomData === 'string' ? JSON.parse(roomData) : roomData;
      return res.status(200).json({
        exists: true,
        roomId: room.roomId,
        inviter: room.inviter,
        publisher: room.publisher || room.inviter,
        hostAvatarUrl: room.hostAvatarUrl || '',
        deepLink: room.deepLink,
        updatedAt: room.updatedAt || Math.floor(Date.now() / 1000)
      });
    }

    // 2. 如果当前空闲：从 MongoDB 查询最近一次的历史放歌（作为贴心回显）
    let lastRoom = null;
    try {
      const db = await getDatabase();
      const lastDoc = await db.collection('room_logs')
        .find({ status: 'ended' })
        .sort({ endedAt: -1 })
        .limit(1)
        .project({ publisher: 1, inviter: 1, hostAvatarUrl: 1, endedAt: 1 })
        .toArray();

      if (lastDoc && lastDoc.length > 0) {
        lastRoom = lastDoc[0];
      }
    } catch (e) {
      // 容错降级，不阻断主流程
    }

    return res.status(200).json({
      exists: false,
      lastRoom: lastRoom || null
    });
  } catch (error) {
    console.error('[Get Status Error]', error);
    return res.status(200).json({ exists: false });
  }
}