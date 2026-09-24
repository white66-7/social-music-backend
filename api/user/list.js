import { redis, REDIS_ROOM_KEY } from '../../lib/redis.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ code: 405, message: '仅支持 GET 请求' });
  }

  try {
    // 1. 从 Redis 直接拉取所有成员
    const rawMembers = await redis.hvals('app:circle_members');
    const members = (rawMembers || []).map(item => (typeof item === 'string' ? JSON.parse(item) : item));

    // 按活跃时间倒序
    members.sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));

    // 2. 检查当前活跃房主
    let currentHost = null;
    try {
      const currentRoomRaw = await redis.get(REDIS_ROOM_KEY);
      if (currentRoomRaw) {
        const room = typeof currentRoomRaw === 'string' ? JSON.parse(currentRoomRaw) : currentRoomRaw;
        currentHost = room.publisher || room.inviter;
      }
    } catch (_) {}

    // 3. 组装响应数据（脱敏掉 pin）
    const dataList = members.map(m => ({
      qq: m.qq,
      username: m.username,
      avatarUrl: m.avatarUrl || `https://q1.qlogo.cn/g?b=qq&nk=${m.qq}&s=640`,
      isHosting: currentHost ? (m.username === currentHost || m.qq === currentHost) : false
    }));

    return res.status(200).json({
      code: 0,
      total: dataList.length,
      data: dataList
    });
  } catch (error) {
    console.error('[User List API Error]', error);
    return res.status(500).json({ code: 500, message: '获取成员列表失败' });
  }
}