// pages/api/user/update-name.js
import { getDatabase } from '../../lib/mongodb.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ code: 405, message: '仅支持 POST 请求' });
  }

  try {
    const { qq, token, newUsername } = req.body || {};
    let targetQq = String(qq || '').trim();

    // 容错：如果前端没传 qq，尝试从 token_1262500838_xxx 里提取 QQ
    if (!targetQq && token) {
      const match = String(token).match(/^token_(\d+)_/);
      if (match) targetQq = match[1];
    }

    const cleanName = String(newUsername || '').trim();

    if (!targetQq) {
      return res.status(400).json({ code: 400, message: '无法识别用户身份' });
    }

    if (!cleanName) {
      return res.status(400).json({ code: 400, message: '昵称不能为空' });
    }

    if (cleanName.length > 12) {
      return res.status(400).json({ code: 400, message: '昵称最多 12 个字' });
    }

    // 🌟 用户档案已全量迁至 MongoDB（users 集合，qq 为唯一键），不再写 Redis Hash
    const db = await getDatabase();
    const now = Date.now();

    // 不存在则自动登记，保证老客户端（未走登录接口）也能改昵称
    const result = await db.collection('users').findOneAndUpdate(
      { qq: targetQq },
      {
        $set: { username: cleanName, lastActiveAt: now, updatedAt: now },
        $setOnInsert: {
          qq: targetQq,
          avatarUrl: `https://q1.qlogo.cn/g?b=qq&nk=${targetQq}&s=640`,
          createdAt: now
        }
      },
      { upsert: true, returnDocument: 'after' }
    );

    const user = result?.value ?? result; // 兼容 mongodb 驱动 v6+ 直接返回文档

    return res.status(200).json({
      code: 0,
      message: '昵称更新成功',
      username: cleanName,
      data: user ? { qq: user.qq, username: user.username, avatarUrl: user.avatarUrl } : undefined
    });
  } catch (err) {
    console.error('[Update Name Error]', err);
    return res.status(500).json({ code: 500, message: `服务器异常: ${err.message}` });
  }
}