// pages/api/auth/login.js
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

      // 口令校验与容错
      if (!existingUser.pin) {
        existingUser.pin = cleanPin;
      } else if (existingUser.pin !== cleanPin) {
        return res.status(403).json({ code: 403, message: '该 QQ 已绑定专属口令，口令错误！' });
      }

      // 自动清洗：把之前测试残留的难看名字 "QQ用户_xxxx" 自动转为清爽的 "音乐人_后四位"
      if (existingUser.username && existingUser.username.startsWith('QQ用户_')) {
        existingUser.username = `音乐人_${cleanQq.slice(-4)}`;
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

    // 2. 新成员首次认证：秒级创建，默认昵称 + 官方高清头像
    const shortQq = cleanQq.slice(-4);
    const defaultNickname = `音乐人_${shortQq}`;
    const avatarUrl = `https://q1.qlogo.cn/g?b=qq&nk=${cleanQq}&s=640`;

    const newUser = {
      qq: cleanQq,
      username: defaultNickname,
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
    console.error('[Login Error]', error);
    return res.status(500).json({ code: 500, message: `服务器处理异常: ${error.message}` });
  }
}