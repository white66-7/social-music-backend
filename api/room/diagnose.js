import WebSocket from 'ws';

function testRootWebSocket(roomId, secret, useExplicitOrigin = false) {
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
            ws.close(1000, 'Test Done');
          } catch (_) {}
        }
        resolve(res);
      }
    };

    try {
      const url = `wss://neriplayer.hancat.work/?roomId=${encodeURIComponent(roomId)}&secret=${encodeURIComponent(secret)}&nickname=DiagBot`;

      const headers = {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10) NeriPlayer/1.0'
      };
      if (useExplicitOrigin) {
        // 传递合法的官方 Origin，杜绝 null
        headers['Origin'] = 'https://neriplayer.hancat.work';
      }

      ws = new WebSocket(url, { headers, handshakeTimeout: 3500 });

      timer = setTimeout(() => {
        finish({ status: 'TIMEOUT', message: '握手超时' });
      }, 4000);

      // 收到 101 并成功建立连接
      ws.on('open', () => {
        // 连上后等待 500ms，看服务端推下来的第一条房间消息
        ws.on('message', (data) => {
          finish({
            status: 'OPEN_SUCCESS',
            message: '【100% 连通并握手成功！】',
            firstMessageFromRoom: data.toString().slice(0, 200)
          });
        });

        setTimeout(() => {
          finish({
            status: 'OPEN_SUCCESS',
            message: '【100% 连通并握手成功 (101 Switching Protocols)】'
          });
        }, 500);
      });

      ws.on('unexpected-response', (req, res) => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => {
          finish({
            status: 'UNEXPECTED_HTTP',
            statusCode: res.statusCode,
            body: body.trim()
          });
        });
      });

      ws.on('close', (code, reason) => {
        finish({ status: 'CLOSED', code, reason: reason ? reason.toString() : '' });
      });

      ws.on('error', (err) => {
        finish({ status: 'ERROR', error: err.message });
      });

    } catch (e) {
      finish({ status: 'EXCEPTION', error: e.message });
    }
  });
}

export default async function handler(req, res) {
  const roomId = req.query.roomId || 'QUYUDY';
  const secret = req.query.secret || '';

  // 实验 A：不带 Origin 纯净连接根路径 /
  // 实验 B：带合法官方 Origin 连接根路径 /
  const [testA_no_origin, testB_with_origin] = await Promise.all([
    testRootWebSocket(roomId, secret, false),
    testRootWebSocket(roomId, secret, true)
  ]);

  let conclusion = '未能连通';
  if (testA_no_origin.status === 'OPEN_SUCCESS' || testB_with_origin.status === 'OPEN_SUCCESS') {
    conclusion = '🎉 完美破案！根路径 / 直连成功，房间真实有效且能正常通信！';
  }

  return res.status(200).json({
    conclusion,
    testA_no_origin,
    testB_with_origin
  });
}