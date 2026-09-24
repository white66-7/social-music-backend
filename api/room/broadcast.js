import WebSocket from 'ws';
import { redis, REDIS_ROOM_KEY } from '../../lib/redis.js';
import { getDatabase } from '../../lib/mongodb.js';
import { ObjectId } from 'mongodb';

const ROOM_LEASE_SECONDS = 30;

/**
 * 云端精准探活：使用标准 WebSocket 客户端检测 NeriPlayer 房间真实可用性
 * 
 * 核心优化：
 * 1. 彻底根除假阳性：网络不通、域名错误、HTTP 4xx/5xx、超时均严格判定为【不可用】；
 * 2. 深度鉴权拦截：完整监听 WebSocket 握手及建连后的 Close 状态码（1008/4xxx）；
 * 3. 避免扰乱真实房间：核验通过后使用标准 Code 1000 优雅退出，严禁粗暴 RST 断流；
 * 4. 严防 Serverless 挂起：统一 Promise 结算与定时器/Socket 资源清理。
 */
function probeNeriRoomOnCloud(serverUrl, roomId, secret, timeoutMs = 3500) {
  return new Promise((resolve) => {
    let isSettled = false;
    let timer = null;
    let ws = null;

    // 统一结算与资源清理，防止 Serverless 函数内存泄漏或卡死
    const finish = (result) => {
      if (isSettled) return;
      isSettled = true;

      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      if (ws) {
        try {
          ws.removeAllListeners();
          if (ws.readyState === WebSocket.OPEN) {
            // 使用标准 1000 正常关闭，绝不触发服务端的异常广播
            ws.close(1000, 'Probe Completed');
          } else {
            ws.terminate();
          }
        } catch (_) {}
      }

      resolve(result);
    };

    try {
      // 1. 规范化 URL 地址与协议转换 (http -> ws, https -> wss)
      let base = (serverUrl || 'https://neriplayer.hancat.work').trim();
      if (!/^https?:\/\//i.test(base) && !/^wss?:\/\//i.test(base)) {
        base = 'https://' + base;
      }

      const wsUrl = new URL(base);
      wsUrl.protocol = wsUrl.protocol === 'http:' ? 'ws:' : 'wss:';
      if (!wsUrl.pathname || wsUrl.pathname === '/') {
        wsUrl.pathname = '/';
      }
      wsUrl.searchParams.set('roomId', roomId);
      if (secret) {
        wsUrl.searchParams.set('secret', secret);
      }
      // 符合 NeriPlayer 1-24 位字符规范
      wsUrl.searchParams.set('nickname', 'SystemProbe');

      // 2. 超时兜底（防止目标服务器不响应卡住接口）
      timer = setTimeout(() => {
        finish({
          alive: false,
          code: 408,
          message: '连接房间超时，服务器未响应或节点已离线'
        });
      }, timeoutMs);

      // 3. 建立标准 WebSocket 连接
      ws = new WebSocket(wsUrl.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10) NeriPlayer/1.0',
          'Origin': wsUrl.origin.replace(/^ws/, 'http')
        },
        handshakeTimeout: 3000
      });

      // 4. 监听 HTTP 协议升级失败（目标服务返回 400/401/403/404/500/502 等）
      ws.on('unexpected-response', (req, res) => {
        const status = res.statusCode || 500;
        let msg = `服务端拒绝连接 (HTTP ${status})`;
        if (status === 404) {
          msg = '该房间不存在或已关闭 (404)';
        } else if (status === 401 || status === 403) {
          msg = '房间口令/密钥错误或拒绝加入 (403)';
        } else if (status === 400) {
          msg = '口令格式不合规或参数错误 (400)';
        } else if (status >= 500) {
          msg = `Neri 节点服务器异常 (HTTP ${status})`;
        }
        finish({ alive: false, code: status, message: msg });
      });

      // 5. 监听底层网络异常（DNS 解析失败、连接被重置、拒绝连接等）
      ws.on('error', (err) => {
        finish({
          alive: false,
          code: -1,
          message: `无法连接到房间节点: ${err.message || '网络不可达'}`
        });
      });

      // 6. 监听业务鉴权踢出（如握手成功后，服务端立即下发 1008 或 4xxx 关闭帧）
      ws.on('close', (code, reason) => {
        const reasonText = reason ? reason.toString() : '';
        if (code === 1008) {
          finish({
            alive: false,
            code,
            message: `房间安全策略拒绝: ${reasonText || '密钥无效'}`
          });
        } else if (code >= 4000) {
          finish({
            alive: false,
            code,
            message: `房间拒绝加入 (${code}): ${reasonText || '房间已关闭或密钥过期'}`
          });
        } else if (code !== 1000) {
          finish({
            alive: false,
            code,
            message: `连接被异常中断 (code ${code}): ${reasonText || '未知原因'}`
          });
        }
      });

      // 7. 成功握手，并留出 300ms 缓冲防“秒踢”
      ws.on('open', () => {
        setTimeout(() => {
          finish({ alive: true, code: 0, message: '房间正常存活' });
        }, 300);
      });

    } catch (e) {
      finish({
        alive: false,
        code: -2,
        message: `探活初始化异常: ${e.message}`
      });
    }
  });
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ code: 405, message: '仅支持 POST 请求' });
  }

  try {
    const { action, username, roomId, inviter, publisher, secret, deepLink, serverUrl } = req.body || {};

    if (!action) {
      return res.status(400).json({ code: 400, message: '缺少 action 参数' });
    }

    const currentRoomRaw = await redis.get(REDIS_ROOM_KEY);
    const currentRoom = currentRoomRaw
      ? (typeof currentRoomRaw === 'string' ? JSON.parse(currentRoomRaw) : currentRoomRaw)
      : null;

    // =========================================================================
    // 1. 开启放歌 (start) - 必须精准探活
    // =========================================================================
    if (action === 'start') {
      const roomOwner = currentRoom ? (currentRoom.publisher || currentRoom.inviter) : null;
      if (currentRoom && roomOwner !== username) {
        return res.status(409).json({
          code: 409,
          message: `当前已有其他人在放歌【${currentRoom.inviter || roomOwner}】`
        });
      }

      if (!deepLink || !roomId) {
        return res.status(400).json({ code: 400, message: '缺少房间链接或房间号' });
      }

      // 🌟 云端精准探活：真正校验 WebSocket 连通性与房间密钥
      const probeResult = await probeNeriRoomOnCloud(serverUrl, roomId, secret);
      if (!probeResult.alive) {
        return res.status(400).json({
          code: 400,
          // 直接返回准确的失败原因（手机端会弹窗回显给用户）
          message: probeResult.message || '该 NeriPlayer 房间不存在或口令已失效！'
        });
      }

      let hostAvatarUrl = '';
      let mongoLogId = null;
      const now = new Date();

      // 安全操作 MongoDB 记录历史（容错降级，不阻断主流程）
      try {
        const db = await getDatabase();
        const users = db.collection('users');
        const roomLogs = db.collection('room_logs');

        const userDoc = await users.findOne({ username });
        if (userDoc?.avatarUrl) {
          hostAvatarUrl = userDoc.avatarUrl;
        }

        const insertResult = await roomLogs.insertOne({
          roomId,
          publisher: username,
          inviter: inviter || username,
          hostAvatarUrl,
          deepLink,
          status: 'active',
          startedAt: now,
          endedAt: null,
          endReason: null,
        });
        mongoLogId = insertResult.insertedId.toString();
      } catch (err) {
        console.warn('[MongoDB 警告] 记录日志失败，继续放歌业务:', err.message);
      }

      // 核心业务：写入 Redis 极速广播 (带 30 秒租约)
      const newRoomPayload = {
        roomId,
        inviter: inviter || username,
        publisher: username,
        hostAvatarUrl,
        secret: secret || '',
        deepLink,
        mongoLogId,
        updatedAt: Math.floor(now.getTime() / 1000)
      };

      await redis.set(REDIS_ROOM_KEY, JSON.stringify(newRoomPayload), {
        ex: ROOM_LEASE_SECONDS
      });

      return res.status(200).json({
        code: 0,
        message: '房间开播成功',
        data: newRoomPayload
      });
    }

    // =========================================================================
    // 2. 房主心跳续期 (heartbeat)
    // =========================================================================
    if (action === 'heartbeat') {
      const roomOwner = currentRoom ? (currentRoom.publisher || currentRoom.inviter) : null;
      if (currentRoom && roomOwner === username) {
        currentRoom.updatedAt = Math.floor(Date.now() / 1000);
        await redis.set(REDIS_ROOM_KEY, JSON.stringify(currentRoom), {
          ex: ROOM_LEASE_SECONDS
        });
        return res.status(200).json({ code: 0, message: '续期成功' });
      }
      return res.status(404).json({ code: 404, message: '房间已失效或不是房主' });
    }

    // =========================================================================
    // 3. 关闭房间 (stop / expire)
    // =========================================================================
    if (action === 'stop' || action === 'expire') {
      const roomOwner = currentRoom ? (currentRoom.publisher || currentRoom.inviter) : null;
      if (currentRoom && roomOwner === username) {
        await redis.del(REDIS_ROOM_KEY);
        if (currentRoom.mongoLogId) {
          try {
            const db = await getDatabase();
            await db.collection('room_logs').updateOne(
              { _id: new ObjectId(currentRoom.mongoLogId) },
              {
                $set: {
                  status: 'ended',
                  endedAt: new Date(),
                  endReason: action === 'stop' ? 'manual' : 'timeout'
                }
              }
            );
          } catch (e) {
            console.warn('[MongoDB 警告] 归档失败:', e.message);
          }
        }
        return res.status(200).json({ code: 0, message: '房间已释放并归档' });
      }
      return res.status(200).json({ code: 0, message: '非房主请求已忽略' });
    }

    return res.status(200).json({ code: 0, message: 'ok' });
  } catch (error) {
    console.error('[Broadcast Error]', error);
    return res.status(500).json({ code: 500, message: '服务器内部错误' });
  }
}