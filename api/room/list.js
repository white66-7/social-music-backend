// pages/api/user/list.js
import { getDatabase } from '../../lib/mongodb.js';
import { redis, REDIS_ROOM_KEY } from '../../lib/redis.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ code: 405, message: '仅支持 GET 请求' });
  }

  try {
    const db = await getDatabase();
    const usersCollection = db.collection('users');

    // 1. 查询所有通过密钥注册/登录的用户，按最近活跃时间倒序排列
    const users = await usersCollection
      .find({})
      .sort({ lastActiveAt: -1, createdAt: -1 })
      .project({
        username: 1,
        avatarUrl: 1,
        lastActiveAt: 1,
        createdAt: 1
      })
      .toArray();

    // 2. 顺带检查当前谁在放歌
    let currentHost = null;
    try {
      const currentRoomRaw = await redis.get(REDIS_ROOM_KEY);
      if (currentRoomRaw) {
        const room = typeof currentRoomRaw === 'string' ? JSON.parse(currentRoomRaw) : currentRoomRaw;
        currentHost = room.publisher || room.inviter;
      }
    } catch (_) {}

    // 3. 组装成员数据，标记谁是当前房主
    const memberList = users.map(user => ({
      username: user.username,
      avatarUrl: user.avatarUrl || '',
      isHosting: currentHost ? (user.username === currentHost) : false,
      lastActiveAt: user.lastActiveAt || user.createdAt || null
    }));

    return res.status(200).json({
      code: 0,
      total: memberList.length,
      data: memberList
    });
  } catch (error) {
    console.error('[Get Users List Error]', error);
    return res.status(500).json({ code: 500, message: '获取成员列表失败' });
  }
}