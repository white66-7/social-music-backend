import { getDatabase } from '../../lib/mongodb.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ code: 405, message: '仅支持 POST 请求' });
  }

  try {
    const { username, avatarUrl } = req.body || {};

    if (!username || typeof username !== 'string') {
      return res.status(400).json({ code: 400, message: '缺少合法的 username' });
    }

    const db = await getDatabase();
    const users = db.collection('users');

    const now = new Date();
    const updateDoc = {
      $set: {
        lastActiveAt: now,
        updatedAt: now,
      },
      $setOnInsert: {
        createdAt: now,
      }
    };

    // 只有传入有效头像 URL 才更新，防止空值覆盖已有头像
    if (avatarUrl && typeof avatarUrl === 'string' && avatarUrl.trim().length > 0) {
      updateDoc.$set.avatarUrl = avatarUrl.trim();
    }

    const result = await users.findOneAndUpdate(
      { username: username.trim() },
      updateDoc,
      { upsert: true, returnDocument: 'after' }
    );

    return res.status(200).json({
      code: 0,
      message: '用户档案同步成功',
      data: result.value || result
    });
  } catch (error) {
    console.error('[User Sync Error]', error);
    return res.status(500).json({ code: 500, message: '服务器内部错误' });
  }
}