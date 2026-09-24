import { redis } from '../../lib/redis.js';

// 封装可靠的 QQ 昵称抓取函数（双通道 + 超时熔断）
async function fetchQqNickname(cleanQq) {
  // 渠道 1：腾讯官方接口（带 Referer 伪装）
  try {
    const qzoneResp = await fetch(
      `https://r.qzone.qq.com/fcg-bin/cgi_get_portrait.fcg?uins=${cleanQq}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://qzone.qq.com/'
        },
        signal: AbortSignal.timeout(3000)
      }
    );

    if (qzoneResp.ok) {
      const buf = await qzoneResp.arrayBuffer();
      let text = '';
      try {
        text = new TextDecoder('gbk').decode(buf);
      } catch (_) {
        text = new TextDecoder('utf-8').decode(buf);
      }

      // 正确提取 portraitCallBack(...) 内的 JSON 并解析
      const jsonMatch = text.match(/portraitCallBack\(([\s\S]*?)\);?/);
      if (jsonMatch && jsonMatch[1]) {
        const data = JSON.parse(jsonMatch[1]);
        // 腾讯接口第 6 项即为昵称
        const nick = data[cleanQq]?.[6];
        if (nick && typeof nick === 'string' && nick.trim()) {
          return nick.trim();
        }
      }
    }
  } catch (e) {
    console.warn('[官方接口拉取失败，尝试备用通道]:', e.message);
  }

  // 渠道 2：公共备用 API（防止 Vercel 海外服务器 IP 被腾讯拦截）
  try {
    const backupResp = await fetch(`https://api.usuuu.com/qq/${cleanQq}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(3000)
    });
    if (backupResp.ok) {
      const resData = await backupResp.json();
      const nick = resData?.data?.name;
      if (nick && typeof nick === 'string' && nick.trim()) {
        return nick.trim();
      }
    }
  } catch (e) {
    console.warn('[备用通道拉取失败]:', e.message);
  }

  return `QQ用户_${cleanQq}`;
}

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
      } else if (existingUser.pin !== cleanPin) {
        return res.status(403).json({ code: 403, message: '该 QQ 已绑定专属口令，口令错误！' });
      }

      // ★ 关键修复：如果老数据之前存成了默认的 "QQ用户_xxx"，本次登录自动重新抓取并更新 Redis！
      if (!existingUser.username || existingUser.username.startsWith('QQ用户_')) {
        const realNick = await fetchQqNickname(cleanQq);
        if (realNick && !realNick.startsWith('QQ用户_')) {
          existingUser.username = realNick;
        }
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

    // 2. 新成员首次认证：安全拉取真实昵称
    const nickname = await fetchQqNickname(cleanQq);
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
    return res.status(500).json({ code: 500, message: `服务器处理异常: ${error.message}` });
  }
}