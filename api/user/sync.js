import { getDatabase } from '../../lib/mongodb.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ code: 405, message: '仅支持 POST 请求' });
  }

  try {
    const { qq, username, avatarUrl } = req.body || {};

    if (!username || typeof username !== 'string') {
      return res.status(400).json({ code: 400, message: '缺少合法的 username' });
    }

    const db = await getDatabase();
    const users = db.collection('users');

    const cleanName = username.trim();
    const cleanQq = String(qq || '').trim();
    // 🌟 统一用毫秒时间戳，避免与 login.js 的 Date.now() 混用导致排序错乱
    const now = Date.now();

    const updateDoc = {
      $set: { lastActiveAt: now, updatedAt: now },
      $setOnInsert: { createdAt: now }
    };

    // 只有传入有效头像 URL 才更新，防止空值覆盖已有头像
    const cleanAvatar = typeof avatarUrl === 'string' ? avatarUrl.trim() : '';
    if (cleanAvatar) {
      updateDoc.$set.avatarUrl = cleanAvatar;
    }

    let result;

    if (cleanQq) {
      // 优先按 qq 命中（迁移后的唯一身份键）
      result = await users.findOneAndUpdate(
        { qq: cleanQq },
        {
          ...updateDoc,
          $setOnInsert: {
            ...updateDoc.$setOnInsert,
            qq: cleanQq,
            username: cleanName,
            avatarUrl: cleanAvatar || `https://q1.qlogo.cn/g?b=qq&nk=${cleanQq}&s=640`
          }
        },
        { upsert: true, returnDocument: 'after' }
      );
    } else {
      // 老客户端只传 nickname：仅更新已存在的档案。
      // 这里绝不能 upsert —— users 集合有 qq 唯一索引，插入无 qq 的文档会被当成 qq:null，
      // 第二条就会撞 E11000 重复键，且这种档案永远登录不了
      result = await users.findOneAndUpdate(
        { username: cleanName },
        updateDoc,
        { returnDocument: 'after' }
      );

      if (!result) {
        return res.status(404).json({ code: 404, message: '用户档案不存在，请先使用 QQ 号登录' });
      }
    }

    return res.status(200).json({
      code: 0,
      message: '用户档案同步成功',
      data: result?.value ?? result
    });
  } catch (error) {
    console.error('[User Sync Error]', error);
    return res.status(500).json({ code: 500, message: '服务器内部错误' });
  }
}