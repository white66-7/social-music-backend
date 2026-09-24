// api/room/history.js 或 pages/api/room/history.js
import { getDatabase } from '../../lib/mongodb.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ code: 405, message: '仅支持 GET 请求' });
  }

  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 30);

    const db = await getDatabase();
    const history = await db.collection('room_logs')
      .find({})
      .sort({ startedAt: -1 })
      .limit(limit)
      .project({
        roomId: 1,
        publisher: 1,
        inviter: 1,
        hostAvatarUrl: 1,
        startedAt: 1,
        endedAt: 1,
        status: 1
      })
      .toArray();

    return res.status(200).json({
      code: 0,
      data: history
    });
  } catch (error) {
    console.error('[Get History Error]', error);
    return res.status(500).json({ code: 500, message: '查询历史失败' });
  }
}