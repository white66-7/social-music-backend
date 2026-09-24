import WebSocket from 'ws';
import { redis, REDIS_ROOM_KEY } from '../../lib/redis.js';
import { getDatabase } from '../../lib/mongodb.js';
import { ObjectId } from 'mongodb';

const ROOM_LEASE_SECONDS = 30;


function probeNeriRoomOnCloud(serverUrl, roomId, secret, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let isSettled = false;
    let timer = null;
    let ws = null;

    // 核心安全清理函数：彻底杜绝 Uncaught Exception
    const finish = (result) => {
      if (isSettled) return;
      isSettled = true;

      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      if (ws) {
        try {
          // 1. 先清空之前的监听器
          ws.removeAllListeners();
          // 2. 🌟 关键修复：挂载空函数接盘，防止 terminate 触发未捕获的 'error' 导致进程崩溃
          ws.on('error', () => {});

          if (ws.readyState === WebSocket.OPEN) {
            ws.close(1000, 'Probe Completed');
          } else {
            ws.terminate();
          }
        } catch (_) {}
      }

      resolve(result);
    };

    try {
      // 1. 规范化地址
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
      wsUrl.searchParams.set('nickname', 'SystemProbe');

      // 2. 超时保护
      timer = setTimeout(() => {
        finish({
          alive: false,
          code: 408,
          message: '连接房间超时，服务器响应过慢'
        });
      }, timeoutMs);

      // 3. 发起 WebSocket 请求（模拟 Android 客户端请求头）
      ws = new WebSocket(wsUrl.toString(), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10) NeriPlayer/1.0',
          'Origin': wsUrl.origin.replace(/^ws/, 'http')
        },
        handshakeTimeout: 3000
      });

      // 4. 监听 HTTP 响应异常（重点：读取 200/403/404 的实际响应内容）
      ws.on('unexpected-response', (req, res) => {
        let respBody = '';
        res.on('data', (chunk) => {
          respBody += chunk;
        });
        res.on('end', () => {
          const status = res.statusCode || 500;
          console.error(`[Probe 异常响应] 状态码: ${status}, 内容摘要: ${respBody.slice(0, 150)}`);

          let msg = `服务端未建立连接 (HTTP ${status})`;
          if (status === 200) {
            msg = '房间节点未开启 WebSocket 或返回了普通网页';
          } else if (status === 404) {
            msg = '该房间不存在或已解散 (404)';
          } else if (status === 403 || status === 401) {
            msg = '房间密钥无效或拒绝加入 (403)';
          }

          finish({ alive: false, code: status, message: msg });
        });
      });

      // 5. 监听网络层错误
      ws.on('error', (err) => {
        finish({
          alive: false,
          code: -1,
          message: `连接失败: ${err.message || '网络不可达'}`
        });
      });

      // 6. 监听关闭事件
      ws.on('close', (code, reason) => {
        const reasonText = reason ? reason.toString() : '';
        if (code === 1008 || code >= 4000) {
          finish({
            alive: false,
            code,
            message: `房间拒绝: ${reasonText || '口令无效'}`
          });
        } else if (code !== 1000) {
          finish({
            alive: false,
            code,
            message: `连接中断 (code ${code}): ${reasonText}`
          });
        }
      });

      // 7. 握手成功并保持片刻
      ws.on('open', () => {
        setTimeout(() => {
          finish({ alive: true, code: 0, message: '房间正常存活' });
        }, 300);
      });

    } catch (e) {
      finish({
        alive: false,
        code: -2,
        message: `探活参数异常: ${e.message}`
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