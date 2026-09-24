import { redis } from '../../../lib/redis.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ code: 405, message: '仅支持 POST 请求' });
  }

  try {
    const { qq, pin } = req.body || {};
    const cleanQq = String(qq || '').trim();
    const cleanPin = String(pin || '').trim();

    if (!cleanQq || !/^[1-9][0-9]{4,11}$/.test(cleanQq)) {
      return res.status(400).json({ code: 400, message: '请输入合法的 QQ 号码' });
    }

    if (!cleanPin || cleanPin.length !== 4) {
      return res.status(400).json({ code: 400, message: '请输入 4 位专属口令' });
    }

    // 1. 检查 Redis 中该 QQ 是否已被登记
    const userRaw = await redis.hget('app:circle_members', cleanQq);

    if (userRaw) {
      // 老成员：校验口令防冒名
      const existingUser = typeof userRaw === 'string' ? JSON.parse(userRaw) : userRaw;
      if (existingUser.pin !== cleanPin) {
        return res.status(403).json({ code: 403, message: '该 QQ 已绑定专属口令，口令错误！' });
      }

      // 顺带尝试拉取最新昵称（如果改了网名）
      let latestNickname = existingUser.username;
      try {
        const qzoneResp = await fetch(`https://r.qzone.qq.com/fcg-bin/cgi_get_portrait.js?uins=${cleanQq}`, { signal: AbortSignal.timeout(2000) });
        const buffer = await qzoneResp.arrayBuffer();
        const text = new TextDecoder('gbk').decode(buffer);
        const match = text.match(/"(?:[^"\\]|\\.)*"/g);
        if (match && match.length >= 7) {
          latestNickname = JSON.parse(match[6]);
        }
      } catch (_) {}

      existingUser.username = latestNickname;
      existingUser.lastActiveAt = Date.now();
      await redis.hset('app:circle_members', cleanQq, JSON.stringify(existingUser));

      return res.status(200).json({
        code: 0,
        message: '登录成功',
        token: `token_${cleanQq}_${Date.now()}`,
        user: existingUser
      });
    }

    // 2. 新成员首次进入：自动拉取腾讯官方昵称
    let nickname = `QQ用户_${cleanQq}`;
    try {
      const qzoneResp = await fetch(`https://r.qzone.qq.com/fcg-bin/cgi_get_portrait.js?uins=${cleanQq}`, { signal: AbortSignal.timeout(3000) });
      const buffer = await qzoneResp.arrayBuffer();
      const text = new TextDecoder('gbk').decode(buffer);
      const match = text.match(/"(?:[^"\\]|\\.)*"/g);
      if (match && match.length >= 7) {
        nickname = JSON.parse(match[6]);
      }
    } catch (e) {
      console.warn('[腾讯昵称解析异常，使用保底昵称]', e.message);
    }

    const avatarUrl = `https://q1.qlogo.cn/g?b=qq&nk=${cleanQq}&s=640`;

    const newUser = {
      qq: cleanQq,
      username: nickname,
      avatarUrl: avatarUrl,
      pin: cleanPin, // 绑定专属 4 位密码，防止他人输入此 QQ 号顶替
      createdAt: Date.now(),
      lastActiveAt: Date.now()
    };

    // 写入 Redis 成员表，全内存存储
    await redis.hset('app:circle_members', cleanQq, JSON.stringify(newUser));

    return res.status(200).json({
      code: 0,
      message: '首次认证并绑定成功',
      token: `token_${cleanQq}_${Date.now()}`,
      user: newUser
    });
  } catch (error) {
    console.error('[Login API Error]', error);
    return res.status(500).json({ code: 500, message: '服务器内部错误' });
  }
}