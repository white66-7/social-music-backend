// api/user/avatar.js 或 pages/api/user/avatar.js
import formidable from 'formidable';
import fs from 'fs';
import path from 'path';

// 关闭 Next.js 默认 body 解析，交给 formidable
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method Not Allowed' });

  // 确保存放目录存在 (public/uploads)
  const uploadDir = path.join(process.cwd(), 'public', 'uploads');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const form = formidable({
    uploadDir,
    keepExtensions: true,
    maxFileSize: 5 * 1024 * 1024, // 限制 5MB
    filename: (name, ext, part) => {
      return `avatar_${Date.now()}_${Math.random().toString(36).substring(2, 8)}${ext}`;
    }
  });

  form.parse(req, (err, fields, files) => {
    if (err) {
      console.error('[Upload Error]', err);
      return res.status(500).json({ code: 500, message: '上传失败' });
    }

    const uploadedFile = Array.isArray(files.file) ? files.file[0] : files.file;
    if (!uploadedFile) {
      return res.status(400).json({ code: 400, message: '缺少文件' });
    }

    const fileName = path.basename(uploadedFile.filepath);
    // 构造访问该图片的公网网络 URL
    const fileUrl = `https://www.white667.xyz/uploads/${fileName}`;

    return res.status(200).json({
      code: 0,
      message: '上传成功',
      url: fileUrl
    });
  });
}