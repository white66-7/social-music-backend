import { getDatabase } from '../../lib/mongodb.js';
import { redis, REDIS_ROOM_KEY } from '../../lib/redis.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ code: 405, message: '仅支持 GET 请求' });
  }

  try {
    //并发查询：同时去 MongoDB 查成员 和 Redis 查当前房间房主（大幅缩短响应时间）
    const dbPromise = getDatabase().then(db =>
      db.collection('users')
        .find({})
        .project({ pin: 0 })  // 🔒 数据库层直接剔除 pin，避免泄露且减小网络传输包体
        .sort({ lastActiveAt: -1 }) // 直接在数据库层按最后活跃时间倒序
        .toArray()
    );

    const roomPromise = redis.get(REDIS_ROOM_KEY).catch(() => null);

    // 等待两者同时返回
    const [users, currentRoomRaw] = await Promise.all([dbPromise, roomPromise]);

    // 2. 解析当前活跃房主 (从 Redis 中获取秒级变动的实时房间状态)
    let currentHost = null;
    if (currentRoomRaw) {
      try {
        const room = typeof currentRoomRaw === 'string' ? JSON.parse(currentRoomRaw) : currentRoomRaw;
        currentHost = room?.publisher || room?.inviter || null;
      } catch (_) {}
    }

    // 3. 组装响应数据（完全对齐 Android 客户端的数据契约）
    const dataList = (users || []).map(m => ({
      qq: m.qq,
      username: m.username || `网友_${String(m.qq).slice(-4)}`,
      avatarUrl: m.avatarUrl || `https://q1.qlogo.cn/g?b=qq&nk=${m.qq}&s=640`,
      // 判断是否是当前房主
      isHosting: Boolean(currentHost && (m.username === currentHost || m.qq === currentHost)),
      lastActiveAt: m.lastActiveAt || 0
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