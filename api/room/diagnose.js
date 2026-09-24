import WebSocket from 'ws';

function testPathWithRoom(path, roomId, secret) {
  return new Promise((resolve) => {
    let ws = null;
    let timer = null;
    let isDone = false;

    const finish = (res) => {
      if (!isDone) {
        isDone = true;
        if (timer) clearTimeout(timer);
        if (ws) {
          try {
            ws.removeAllListeners();
            ws.on('error', () => {});
            ws.close(1000, 'Done');
          } catch (_) {}
        }
        resolve({ path, ...res });
      }
    };

    try {
      // 路径和 Query 双保险携带参数
      const url = `wss://neriplayer.hancat.work${path}?secret=${encodeURIComponent(secret)}&nickname=DiagBot&roomId=${encodeURIComponent(roomId)}`;

      ws = new WebSocket(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) NeriPlayer/1.0' },
        handshakeTimeout: 3000
      });

      timer = setTimeout(() => {
        finish({ status: 'TIMEOUT', message: '连接超时' });
      }, 3500);

      // 握手成功
      ws.on('open', () => {
        finish({
          status: 'OPEN_SUCCESS',
          hit: true,
          message: '🎉 100% 命中！成功升级为 WebSocket (101 Switching Protocols)！'
        });
      });

      ws.on('unexpected-response', (req, res) => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => {
          finish({
            status: `HTTP_${res.statusCode}`,
            hit: false,
            body: body.trim()
          });
        });
      });

      ws.on('close', (code, reason) => {
        finish({
          status: 'CLOSED_BY_SERVER',
          hit: code === 1000,
          code,
          reason: reason ? reason.toString() : ''
        });
      });

      ws.on('error', err => {
        finish({ status: 'ERROR', hit: false, error: err.message });
      });

    } catch (e) {
      finish({ status: 'EXCEPTION', hit: false, error: e.message });
    }
  });
}

export default async function handler(req, res) {
  const roomId = req.query.roomId || 'QUYUDY';
  const secret = req.query.secret || '';

  // 待测试的动态路径格式
  const candidatePatterns = [
    `/${roomId}`,                 // 格式 1: /QUYUDY (最主流)
    `/room/${roomId}`,            // 格式 2: /room/QUYUDY
    `/rooms/${roomId}`,           // 格式 3: /rooms/QUYUDY
    `/ws/${roomId}`,              // 格式 4: /ws/QUYUDY
    `/join/${roomId}`,            // 格式 5: /join/QUYUDY
    `/listen-together/${roomId}`  // 格式 6: /listen-together/QUYUDY
  ];

  const results = await Promise.all(
    candidatePatterns.map(p => testPathWithRoom(p, roomId, secret))
  );

  const matched = results.find(r => r.status === 'OPEN_SUCCESS');

  return res.status(200).json({
    conclusion: matched 
      ? `🎉 彻底破案！真实端点是：${matched.path}` 
      : '未命中成功端点，查看各项返回状态码',
    results
  });
}