// pages/api/auth/login.js
import { getDatabase } from '../../lib/mongodb.js';
import { redis } from '../../lib/redis.js';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

// 用于 JWT 签名的密钥，优先读取环境变量
const JWT_SECRET = process.env.JWT_SECRET || 'white667-social-music-secure-jwt-key';

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

    //利用 Redis 进行防爆破拦截（4位 PIN 码仅 10000 种组合，必须限制）
    const failRateKey = `login:fail:${cleanQq}`;
    const failCount = await redis.get(failRateKey);
    if (failCount && parseInt(failCount, 10) >= 5) {
      return res.status(429).json({ 
        code: 429, 
        message: '口令错误次数过多，请 10 分钟后再试' 
      });
    }

    // 连接 MongoDB 查验用户
    const db = await getDatabase();
    const usersCollection = db.collection('users');

    const existingUser = await usersCollection.findOne({ qq: cleanQq });

    if (existingUser) {
      // 兼容老明文数据与新 Bcrypt 哈希数据
      const isMatch = existingUser.pin.startsWith('$2')
        ? await bcrypt.compare(cleanPin, existingUser.pin)
        : existingUser.pin === cleanPin;

      if (!isMatch) {
        // 口令错误，Redis 累计失败次数并设置 10 分钟过期
        await redis.incr(failRateKey);
        await redis.expire(failRateKey, 600);
        return res.status(403).json({ 
          code: 403, 
          message: '口令错误' 
        });
      }

      // 登录成功，清除试错记录
      await redis.del(failRateKey);

      // 如果原来存的是明文口令，顺手升级为加盐密文，并刷新活跃时间
      const updateData = { lastActiveAt: Date.now() };
      if (!existingUser.pin.startsWith('$2')) {
        updateData.pin = await bcrypt.hash(cleanPin, 10);
      }

      await usersCollection.updateOne(
        { qq: cleanQq },
        { $set: updateData }
      );

      // 签发真正的 JWT Token（30天有效）
      const token = jwt.sign(
        { qq: existingUser.qq, username: existingUser.username },
        JWT_SECRET,
        { expiresIn: '30d' }
      );

      // 去除敏感字段后返回前端
      const { pin: _, _id, ...safeUser } = existingUser;

      return res.status(200).json({
        code: 0,
        message: '登录成功',
        token, 
        user: safeUser
      });
    }

    //新用户注册落库 MongoDB
    const shortQq = cleanQq.slice(-4);
    const defaultNickname = `网友_${shortQq}`;
    const avatarUrl = `https://q1.qlogo.cn/g?b=qq&nk=${cleanQq}&s=640`;

    // PIN 加盐哈希加密，杜绝明文入库
    const hashedPin = await bcrypt.hash(cleanPin, 10);

    const newUser = {
      qq: cleanQq,
      username: defaultNickname,
      avatarUrl: avatarUrl,
      pin: hashedPin,
      createdAt: Date.now(),
      lastActiveAt: Date.now()
    };

    await usersCollection.insertOne(newUser);
    await redis.del(failRateKey);

    // 签发 JWT
    const token = jwt.sign(
      { qq: newUser.qq, username: newUser.username },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    const { pin: _, _id, ...safeUser } = newUser;

    return res.status(200).json({
      code: 0,
      message: '首次认证并绑定成功',
      token,
      user: safeUser
    });

  } catch (error) {
    console.error('[Login Error]', error);
    return res.status(500).json({ code: 500, message: `服务器处理异常: ${error.message}` });
  }
}