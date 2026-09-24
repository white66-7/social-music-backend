import https from 'https';
import WebSocket from 'ws';

// 辅助函数：发送原始 HTTP 请求并提取状态码、头信息与返回内容
function rawHttpRequest(urlStr, headers = {}) {
  return new Promise((resolve) => {
    try {
      const url = new URL(urlStr);
      const req = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10) NeriPlayer/1.0',
          ...headers
        },
        timeout: 3000
      });

      let isDone = false;
      const done = (data) => {
        if (!isDone) {
          isDone = true;
          req.destroy();
          resolve(data);
        }
      };

      // 收到 101 Switching Protocols 升级成功
      req.on('upgrade', (res, socket) => {
        socket.destroy();
        done({
          type: 'UPGRADE_101',
          statusCode: 101,
          headers: res.headers,
          message: '成功升级为 WebSocket (101 Switching Protocols)'
        });
      });

      // 收到普通 HTTP 响应
      req.on('response', (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          done({
            type: 'HTTP_RESPONSE',
            statusCode: res.statusCode,
            headers: res.headers,
            body: body.slice(0, 300)
          });
        });
      });

      req.on('error', (err) => {
        done({ type: 'NETWORK_ERROR', error: err.message });
      });

      req.on('timeout', () => {
        done({ type: 'TIMEOUT', error: '请求超过 3 秒未响应' });
      });

      req.end();
    } catch (e) {
      resolve({ type: 'EXCEPTION', error: e.message });
    }
  });
}

// 辅助函数：使用标准 ws 库测试真实连接表现
function wsClientTest(wsUrlStr) {
  return new Promise((resolve) => {
    let ws = null;
    let timer = null;
    let isDone = false;

    const done = (res) => {
      if (!isDone) {
        isDone = true;
        if (timer) clearTimeout(timer);
        if (ws) {
          try {
            ws.removeAllListeners();
            ws.on('error', () => {});
            ws.terminate();
          } catch (_) {}
        }
        resolve(res);
      }
    };

    try {
      ws = new WebSocket(wsUrlStr, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) NeriPlayer/1.0' },
        handshakeTimeout: 3000
      });

      timer = setTimeout(() => {
        done({ status: 'TIMEOUT', message: 'WebSocket 连接超时' });
      }, 3500);

      ws.on('open', () => {
        done({ status: 'OPEN_SUCCESS', message: 'WebSocket 连接成功建立！' });
      });

      ws.on('unexpected-response', (req, res) => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => {
          done({
            status: 'UNEXPECTED_RESPONSE',
            statusCode: res.statusCode,
            body: body.slice(0, 300)
          });
        });
      });

      ws.on('close', (code, reason) => {
        done({
          status: 'CLOSED_BY_SERVER',
          code,
          reason: reason ? reason.toString() : ''
        });
      });

      ws.on('error', (err) => {
        done({ status: 'ERROR', error: err.message });
      });
    } catch (e) {
      done({ status: 'EXCEPTION', error: e.message });
    }
  });
}

export default async function handler(req, res) {
  const roomId = req.query.roomId || req.body?.roomId || '';
  const secret = req.query.secret || req.body?.secret || '';
  let server = req.query.server || req.body?.server || 'https://neriplayer.hancat.work';

  if (!server.startsWith('http')) server = 'https://' + server;
  server = server.replace(/\/+$/, '');

  const queryParams = `?roomId=${encodeURIComponent(roomId)}&secret=${encodeURIComponent(secret)}&nickname=DiagBot`;

  // 并行执行 4 组探针测试
  const [test1_get_root, test2_upgrade_root, test3_upgrade_ws, test4_ws_client_ws] = await Promise.all([
    // 实验 1：普通 HTTP GET 请求根路径 /
    rawHttpRequest(`${server}/`),

    // 实验 2：向根路径 / 发送原生 WebSocket 升级头
    rawHttpRequest(`${server}/${queryParams}`, {
      'Connection': 'Upgrade',
      'Upgrade': 'websocket',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version': '13'
    }),

    // 实验 3：向 /ws 路径发送原生 WebSocket 升级头
    rawHttpRequest(`${server}/ws${queryParams}`, {
      'Connection': 'Upgrade',
      'Upgrade': 'websocket',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version': '13'
    }),

    // 实验 4：使用标准 WebSocket 客户端直连 /ws
    wsClientTest(`${server.replace(/^http/, 'ws')}/ws${queryParams}`)
  ]);

  // 自动根据测试结果得出确切诊断结论
  let conclusion = '未知状态';
  if (test3_upgrade_ws.type === 'UPGRADE_101' || test4_ws_client_ws.status === 'OPEN_SUCCESS') {
    conclusion = '【确定原因】服务端真实端点正是 /ws，且当前房间和密钥完全有效！';
  } else if (test3_upgrade_ws.statusCode === 403 || test4_ws_client_ws.code === 1008) {
    conclusion = '【确定原因】端点为 /ws，但服务器鉴权失败：房间密钥 (secret) 错误或房间未开启！';
  } else if (test3_upgrade_ws.statusCode === 404) {
    conclusion = '【确定原因】端点为 /ws，但房间号 (roomId) 不存在或已过期解散！';
  } else if (test2_upgrade_root.statusCode === 200 && test3_upgrade_ws.statusCode === 200) {
    conclusion = '【确定原因】Cloudflare CDN 拦截了机房 IP 的 Upgrade 请求，自动降级为 HTTP 200。';
  }

  return res.status(200).json({
    diagnoseTarget: { server, roomId, secretProvided: !!secret },
    conclusion,
    details: {
      experiment1_plain_http_root: test1_get_root,
      experiment2_upgrade_to_root: test2_upgrade_root,
      experiment3_upgrade_to_ws: test3_upgrade_ws,
      experiment4_ws_client_ws: test4_ws_client_ws
    }
  });
}