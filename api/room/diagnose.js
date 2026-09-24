import https from 'https';

// 测试单个端点的 WebSocket 升级响应
function probeSinglePath(serverUrl, path, queryParams) {
  return new Promise((resolve) => {
    try {
      const url = new URL(serverUrl);
      const req = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        path: path + queryParams,
        method: 'GET',
        headers: {
          'Connection': 'Upgrade',
          'Upgrade': 'websocket',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10) NeriPlayer/1.0'
        },
        timeout: 3000
      });

      let isDone = false;
      const finish = (result) => {
        if (!isDone) {
          isDone = true;
          req.destroy();
          resolve(result);
        }
      };

      // 命中真实 WebSocket 端点，升级成功
      req.on('upgrade', (res, socket) => {
        socket.destroy();
        finish({
          path,
          status: 101,
          hit: true,
          message: '【100% 命中！】这是真实 WebSocket 端点，且握手成功 (101 Switching Protocols)'
        });
      });

      // 收到普通的 HTTP 响应
      req.on('response', (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          finish({
            path,
            status: res.statusCode,
            hit: res.statusCode !== 404 && res.statusCode !== 200,
            body: body.trim()
          });
        });
      });

      req.on('error', err => finish({ path, status: -1, error: err.message }));
      req.on('timeout', () => finish({ path, status: 408, error: '超时' }));
      req.end();
    } catch (e) {
      resolve({ path, status: -2, error: e.message });
    }
  });
}

export default async function handler(req, res) {
  const roomId = req.query.roomId || 'QUYUDY';
  const secret = req.query.secret || '';
  let server = req.query.server || 'https://neriplayer.hancat.work';

  if (!server.startsWith('http')) server = 'https://' + server;
  server = server.replace(/\/+$/, '');

  const queryParams = `?roomId=${encodeURIComponent(roomId)}&secret=${encodeURIComponent(secret)}&nickname=DiagBot`;

  // 待检测的候选路径列表
  const candidatePaths = [
    '/ws',
    '/join',
    '/room',
    '/listen-together',
    '/listen-together/join',
    '/api/ws',
    '/connect',
    '/__baseline_404__' // 故意放一个不存在的假路由作为 404 基准线
  ];

  // 并发请求所有候选路径
  const scanResults = await Promise.all(
    candidatePaths.map(p => probeSinglePath(server, p, queryParams))
  );

  const baseline404 = scanResults.find(r => r.path === '/__baseline_404__');
  const matchedEndpoint = scanResults.find(r => r.status === 101);
  const differentBehavior = scanResults.filter(r => 
    r.path !== '/__baseline_404__' && 
    (r.status === 101 || r.body !== baseline404?.body)
  );

  let verdict = '未找到任何有效端点';
  if (matchedEndpoint) {
    verdict = `【确定结果】真实端点就是：${matchedEndpoint.path}，握手 101 完全成功！`;
  } else if (differentBehavior.length > 0) {
    verdict = `【关键发现】以下路径表现与 404 基准线不同，需重点查看：${differentBehavior.map(d => `${d.path}(HTTP ${d.status})`).join(', ')}`;
  } else {
    verdict = `【确定结果】所有路由均返回了相同的 404 基准响应。说明房间号 ${roomId} 确实已在服务端过期或不存在！`;
  }

  return res.status(200).json({
    target: { server, roomId, hasSecret: !!secret },
    verdict,
    scanMatrix: scanResults
  });
}