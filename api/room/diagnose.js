export default async function handler(req, res) {
  const roomId = req.query.roomId || 'QUYUDY';
  const secret = req.query.secret || 'eD28BpOuYIYSXS6NUy3AN4a1jf2QgKOTz0dMGsOtS8I';
  const server = 'https://neriplayer.hancat.work';

  // 待检测的 HTTP 候选端点列表（GET 与 POST）
  const candidates = [
    // 常见 GET 查询参数
    { method: 'GET', path: `/api/room/state?roomId=${roomId}&secret=${secret}` },
    { method: 'GET', path: `/api/room/state?roomId=${roomId}` },
    { method: 'GET', path: `/api/room?roomId=${roomId}&secret=${secret}` },
    { method: 'GET', path: `/api/room?roomId=${roomId}` },
    { method: 'GET', path: `/room/state?roomId=${roomId}&secret=${secret}` },
    { method: 'GET', path: `/room/state?roomId=${roomId}` },
    { method: 'GET', path: `/room?roomId=${roomId}&secret=${secret}` },
    { method: 'GET', path: `/room?roomId=${roomId}` },
    { method: 'GET', path: `/state?roomId=${roomId}&secret=${secret}` },
    { method: 'GET', path: `/state?roomId=${roomId}` },
    { method: 'GET', path: `/?roomId=${roomId}&action=refresh` },
    { method: 'GET', path: `/?roomId=${roomId}&action=state` },

    // 常见 RESTful 路径参数
    { method: 'GET', path: `/api/room/${roomId}/state?secret=${secret}` },
    { method: 'GET', path: `/api/room/${roomId}?secret=${secret}` },
    { method: 'GET', path: `/room/${roomId}/state?secret=${secret}` },
    { method: 'GET', path: `/room/${roomId}?secret=${secret}` },
    { method: 'GET', path: `/${roomId}/state?secret=${secret}` },

    // 常见 POST 请求
    { method: 'POST', path: `/api/room/state`, body: { roomId, secret } },
    { method: 'POST', path: `/api/room/refresh`, body: { roomId, secret } },
    { method: 'POST', path: `/room/state`, body: { roomId, secret } },
    { method: 'POST', path: `/refresh`, body: { roomId, secret } },
    { method: 'POST', path: `/`, body: { action: 'refresh', roomId, secret } }
  ];

  const results = await Promise.all(
    candidates.map(async (item) => {
      try {
        const url = `${server}${item.path}`;
        const options = {
          method: item.method,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 10) NeriPlayer/1.0',
            'Accept': 'application/json'
          },
          signal: AbortSignal.timeout(3000)
        };
        if (item.body) {
          options.headers['Content-Type'] = 'application/json';
          options.body = JSON.stringify(item.body);
        }

        const resp = await fetch(url, options);
        const text = await resp.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}

        // 判断是否命中：返回 JSON 包含 ok: true，且包含 version 或 members 字段
        const isHit = json && json.ok === true && (json.version !== undefined || json.members !== undefined || json.expectedPositionMs !== undefined);

        return {
          endpoint: `${item.method} ${item.path}`,
          status: resp.status,
          hit: isHit,
          data: json || text.slice(0, 150)
        };
      } catch (err) {
        return {
          endpoint: `${item.method} ${item.path}`,
          error: err.message
        };
      }
    })
  );

  const hitItem = results.find(r => r.hit);

  return res.status(200).json({
    conclusion: hitItem 
      ? `🎉 抓到了！NeriPlayer 的真实 HTTP 探针接口是：${hitItem.endpoint}`
      : '未自动匹配到，请查看各项响应数据',
    hitEndpoint: hitItem || null,
    scanResults: results
  });
}