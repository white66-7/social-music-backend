import jwt from 'jsonwebtoken';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ code: 405, message: '仅支持 POST 请求' });
  }

  try {
    const { username, pin } = req.body || {};

    if (!username || !username.trim()) {
      return res.status(400).json({ code: 400, message: '用户名不能为空' });
    }

    const expectedPin = process.env.COMMUNITY_PIN || '8888';

    if (String(pin).trim() !== String(expectedPin).trim()) {
      return res.status(401).json({ code: 401, message: '通行口令不正确' });
    }

    const jwtSecret = process.env.JWT_SECRET || 'default_jwt_secret_music';
    const token = jwt.sign(
      { username: username.trim() },
      jwtSecret,
      { expiresIn: '30d' }
    );

    return res.status(200).json({
      code: 0,
      message: '验证成功',
      token,
      username: username.trim()
    });
  } catch (error) {
    console.error('[Login Error]', error);
    return res.status(500).json({ code: 500, message: '服务器内部错误' });
  }
}