// pages/api/user/update-name.js
import { redis } from '../../lib/redis.js';

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

    const userRaw = await redis.hget('app:circle_members', targetQq);
    if (!userRaw) {
      return res.status(404).json({ code: 404, message: '用户不存在' });
    }

    const user = typeof userRaw === 'string' ? JSON.parse(userRaw) : userRaw;
    user.username = cleanName;
    user.lastActiveAt = Date.now();

    await redis.hset('app:circle_members', targetQq, JSON.stringify(user));

    return res.status(200).json({
      code: 0,
      message: '昵称更新成功',
      username: cleanName
    });
  } catch (err) {
    console.error('[Update Name Error]', err);
    return res.status(500).json({ code: 500, message: `服务器异常: ${err.message}` });
  }
}