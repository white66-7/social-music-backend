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

      // 🌟 严格校验：只要有记录且已设置过 pin，哪怕差一位也绝对报错！
      if (existingUser.pin) {
        if (String(existingUser.pin).trim() !== cleanPin) {
          return res.status(403).json({ 
            code: 403, 
            message: '该 QQ 已绑定口令，口令错误！' 
          });
        }
      } else {
        // 如果是早期老数据缺失 pin，仅首次补齐绑定
        existingUser.pin = cleanPin;
      }

      // 刷新活跃时间
      existingUser.lastActiveAt = Date.now();
      
      // 写回 Redis，确保 pin 永远被妥善保存
      await redis.hset('app:circle_members', cleanQq, JSON.stringify(existingUser));

      return res.status(200).json({
        code: 0,
        message: '登录成功',
        token: `token_${cleanQq}_${Date.now()}`,
        user: existingUser
      });
    }

    // 2. 新成员首次认证：秒级创建并牢固绑定 pin
    const shortQq = cleanQq.slice(-4);
    const defaultNickname = `音乐人_${shortQq}`;
    const avatarUrl = `https://q1.qlogo.cn/g?b=qq&nk=${cleanQq}&s=640`;

    const newUser = {
      qq: cleanQq,
      username: defaultNickname,
      avatarUrl: avatarUrl,
      pin: cleanPin, // 👈 首次直接落盘
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