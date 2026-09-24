import { redis } from '../../lib/redis.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ code: 405, message: '仅支持 POST 请求' });
  }

  try {
    const { qq, username, pin } = req.body || {};
    const rawAccount = qq || username;
    const cleanQq = String(rawAccount || '').trim();
    const cleanPin = String(pin || '').trim();

    if (!cleanQq || !/^[1-9][0-9]{4,11}$/.test(cleanQq)) {
      return res.status(400).json({ code: 400, message: '请输入合法的 QQ 号码' });
    }

    if (!cleanPin || cleanPin.length !== 4) {
      return res.status(400).json({ code: 400, message: '请输入 4 位专属口令' });
    }

    // 1. 查询 Redis
    const userRaw = await redis.hget('app:circle_members', cleanQq);

    if (userRaw) {
      const existingUser = typeof userRaw === 'string' ? JSON.parse(userRaw) : userRaw;

      // 容错：如果之前测试的数据没有 pin，直接补绑当前口令
      if (!existingUser.pin) {
        existingUser.pin = cleanPin;
        await redis.hset('app:circle_members', cleanQq, JSON.stringify(existingUser));
        return res.status(200).json({
          code: 0,
          message: '口令已重新绑定并登录',
          token: `token_${cleanQq}_${Date.now()}`,
          user: existingUser
        });
      }

      if (existingUser.pin !== cleanPin) {
        return res.status(403).json({ code: 403, message: '该 QQ 已绑定专属口令，口令错误！' });
      }

      existingUser.lastActiveAt = Date.now();
      await redis.hset('app:circle_members', cleanQq, JSON.stringify(existingUser));

      return res.status(200).json({
        code: 0,
        message: '登录成功',
        token: `token_${cleanQq}_${Date.now()}`,
        user: existingUser
      });
    }

    // 2. 新成员首次认证：安全拉取 QQ 昵称（带双重防崩溃解码）
    let nickname = `QQ用户_${cleanQq}`;
    try {
      const qzoneResp = await fetch(`https://r.qzone.qq.com/fcg-bin/cgi_get_portrait.js?uins=${cleanQq}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(2500)
      });
      const buf = await qzoneResp.arrayBuffer();
      
      let text = '';
      try {
        text = new TextDecoder('gbk').decode(buf);
      } catch (_) {
        text = new TextDecoder('utf-8').decode(buf);
      }

      const match = text.match(/"(?:[^"\\]|\\.)*"/g);
      if (match && match.length >= 7) {
        nickname = JSON.parse(match[6]);
      }
    } catch (e) {
      console.warn('[昵称获取跳过，使用默认昵称]:', e.message);
    }

    const avatarUrl = `https://q1.qlogo.cn/g?b=qq&nk=${cleanQq}&s=640`;

    const newUser = {
      qq: cleanQq,
      username: nickname,
      avatarUrl: avatarUrl,
      pin: cleanPin,
      createdAt: Date.now(),
      lastActiveAt: Date.now()
    };

    await redis.hset('app:circle_members', cleanQq, JSON.stringify(newUser));

    return res.status(200).json({
      code: 0,
      message: '首次认证并绑定成功',
      token: `token_${cleanQq}_${Date.now()}`,
      user: newUser
    });

  } catch (error) {
    console.error('[Login Fatal Error]', error);
    // 必须返回规范 JSON，绝不抛出异常让 Vercel 崩溃
    return res.status(500).json({ code: 500, message: `服务器处理异常: ${error.message}` });
  }
}