import jwt from 'jsonwebtoken';

import { DEFAULT_JWT_SECRET } from './lib/auth.js';

/**
 * 房主心跳超时阈值。超过这么久没收到房主上报，就认为房主进程已经没了，
 * 自动关房，避免僵尸房间永远挂在「正在放歌」。
 */
export const ROOM_TTL_MS = 90_000;

/** alarm 的巡检间隔，比 TTL 短，保证超时能被及时发现 */
const ALARM_INTERVAL_MS = 30_000;

/** 主动去播放器服务器确认「房间还在不在」的间隔 */
const EXISTENCE_CHECK_INTERVAL_MS = 60_000;

/** 探测请求的超时，避免外部服务卡住把 alarm 拖死 */
const EXISTENCE_CHECK_TIMEOUT_MS = 8_000;

const FALLBACK_NERI_SERVER = 'https://neriplayer.hancat.work';

const HUB_INSTANCE_NAME = 'hub';

export function getHubStub(env) {
  return env.ROOM.get(env.ROOM.idFromName(HUB_INSTANCE_NAME));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

/**
 * 对外暴露的房间结构。
 * 刻意剔除 secret —— 现在的架构里只有房主自己需要 Neri 房间密钥（用于自己的
 * 长连接），成员端完全不需要，因此它没有再离开服务器的理由。
 */
function publicRoom(room) {
  if (!room) return null;
  return {
    roomId: room.roomId,
    inviter: room.inviter,
    publisher: room.publisher,
    // 客户端用它判断「房主是不是我」。成员列表里本来就带 qq，不算新增暴露面。
    publisherQq: room.publisherQq,
    hostAvatarUrl: room.hostAvatarUrl,
    deepLink: room.deepLink,
    serverUrl: room.serverUrl,
    currentSong: room.currentSong ?? null,
    currentCover: room.currentCover ?? null,
    durationMs: room.durationMs ?? 0,
    basePositionMs: room.basePositionMs ?? 0,
    baseTimestampMs: room.baseTimestampMs ?? 0,
    playbackRate: room.playbackRate ?? 1,
    isPlaying: room.isPlaying ?? false,
    startedAt: room.startedAt ?? 0
  };
}

export class RoomHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.room = null;
    this.version = 0;
    this.lastExistenceCheckAt = 0;

    // DO 可能被回收后再唤醒，构造时先把权威状态从存储里捞回来，
    // 期间阻塞其它事件，防止半初始化状态下对外广播错数据。
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get(['room', 'version']);
      this.room = stored.get('room') || null;
      this.version = stored.get('version') || 0;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 顺序不能调：'/host/state' 同样以 '/state' 结尾，
    // 把 '/state' 放前面会把房主的状态上报整个吞掉。
    if (path.endsWith('/ws')) return this.handleWebSocket(request, url);
    if (path.endsWith('/host/start')) return this.handleHostStart(request);
    if (path.endsWith('/host/state')) return this.handleHostState(request);
    if (path.endsWith('/host/stop')) return this.handleHostStop(request);
    if (path.endsWith('/members')) {
      return json({ code: 0, members: this.members(), serverTime: Date.now() });
    }
    if (path.endsWith('/state')) return json(this.snapshot());

    return json({ code: 404, message: '未知的房间中枢路由' }, 404);
  }

  // ==========================================================
  // 快照与广播
  // ==========================================================

  snapshot() {
    return {
      type: 'sync',
      version: this.version,
      serverTime: Date.now(),
      room: publicRoom(this.room),
      members: this.members()
    };
  }

  /**
   * 在线成员 = 当前持有 WebSocket 的连接方。
   *
   * 这取代了旧版「把数据库里全部注册用户当成房间成员」的做法 —— 那正是
   * 成员列表在 1 人和 2 人之间反复横跳的根因。
   */
  members() {
    const byQq = new Map();

    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (!att?.qq) continue;
      const prev = byQq.get(att.qq);
      if (!prev || (att.joinedAt || 0) < (prev.joinedAt || 0)) byQq.set(att.qq, att);
    }

    // 房主把 App 切到后台时可能断开连接，但他还在放歌，必须留在成员列表里，
    // 否则成员数会莫名其妙地掉一个。
    if (this.room?.publisherQq && !byQq.has(this.room.publisherQq)) {
      byQq.set(this.room.publisherQq, {
        qq: this.room.publisherQq,
        username: this.room.publisher,
        avatarUrl: this.room.hostAvatarUrl || '',
        joinedAt: this.room.startedAt || 0
      });
    }

    return [...byQq.values()]
      .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0))
      .map(m => ({
        qq: m.qq,
        username: m.username,
        avatarUrl: m.avatarUrl || '',
        isHosting: Boolean(this.room?.publisherQq && m.qq === this.room.publisherQq)
      }));
  }

  async persist() {
    await this.ctx.storage.put({ room: this.room, version: this.version });
  }

  /**
   * 版本号 +1，持久化，然后把完整快照推给所有连接。
   * 全量快照而不是增量补丁：房间状态本来就小，客户端不必维护合并逻辑，
   * 也就不存在「漏了一条消息就永久错位」的隐患。
   */
  async bumpAndBroadcast() {
    this.version += 1;
    await this.persist();

    const text = JSON.stringify(this.snapshot());
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch (e) {
        // 连接刚断，交给 webSocketClose 去收敛成员列表
      }
    }
  }

  // ==========================================================
  // WebSocket
  // ==========================================================

  async handleWebSocket(request, url) {
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return json({ code: 426, message: '需要 WebSocket 升级' }, 426);
    }

    const token = url.searchParams.get('token') || '';
    let claims = null;
    try {
      claims = jwt.verify(token, this.env.JWT_SECRET || DEFAULT_JWT_SECRET);
    } catch {
      claims = null;
    }
    if (!claims?.qq) return json({ code: 401, message: '未授权' }, 401);

    const profile = this.resolveProfile(claims);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.serializeAttachment({ ...profile, joinedAt: Date.now() });
    this.ctx.acceptWebSocket(server);

    // 新连接进来会改变成员列表，bumpAndBroadcast 会把含新成员的快照
    // 一并推给他自己也推给所有人，大家看到的是同一个版本。
    await this.bumpAndBroadcast();
    await this.ensureAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * 身份只从 JWT 里取，这里刻意不查 MongoDB。
   *
   * Durable Object 和 Worker 跑在同一个 isolate 里，但属于**不同的 I/O 上下文**。
   * 一旦在 DO 里复用 Worker 建立的 Mongo 连接（lib/mongodb.js 的模块级缓存），
   * 运行时会直接抛 "Cannot perform I/O on behalf of a different Durable Object"，
   * 或者让请求永远挂住不返回。DO 里任何对 Mongo 的调用都会踩这个坑。
   *
   * 何况展示用的昵称/头像本来就由 /api/user/list 在 Worker 侧直连 Mongo 提供，
   * DO 只需要 qq 来算在线集合。
   */
  resolveProfile(claims) {
    const qq = String(claims.qq);
    return {
      qq,
      username: claims.username || `网友_${qq.slice(-4)}`,
      avatarUrl: `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640`
    };
  }

  async webSocketMessage(ws, message) {
    // 客户端是只读的：身份来自握手时的 JWT，房间状态只能由房主的 HTTP 上报改写。
    // 这里只处理保活 ping，避免任何客户端伪造状态。
    if (typeof message === 'string' && message.includes('ping')) {
      try {
        ws.send(JSON.stringify({ type: 'pong', serverTime: Date.now() }));
      } catch (e) {
        // 忽略：下一次广播会覆盖
      }
    }
  }

  async webSocketClose(ws) {
    await this.bumpAndBroadcast();
  }

  async webSocketError(ws) {
    await this.bumpAndBroadcast();
  }

  // ==========================================================
  // 房主控制
  // ==========================================================

  async handleHostStart(request) {
    const body = await request.json().catch(() => ({}));
    const { user, roomId, inviter, secret, deepLink, serverUrl } = body;

    if (!user?.qq || !roomId || !deepLink) {
      return json({ code: 400, message: '缺少房间链接或房间号' }, 400);
    }

    if (this.room?.publisherQq && this.room.publisherQq !== user.qq) {
      return json({
        code: 409,
        message: `当前已有其他人在放歌【${this.room.inviter || this.room.publisher}】`
      }, 409);
    }

    const now = Date.now();
    // 同一个房间重复 start 视为重连：保留已有播放信息
    const prev = this.room?.roomId === roomId ? this.room : null;

    // 重连时要先把锚点上的位置推进到「此刻」，否则新锚点仍挂着旧位置，
    // 成员端的进度条会往回跳（丢掉两次 start 之间的那段时间）。
    let carriedPosition = prev?.basePositionMs ?? 0;
    if (prev?.isPlaying && prev.baseTimestampMs) {
      carriedPosition = Math.max(
        0,
        prev.basePositionMs + (now - prev.baseTimestampMs) * (prev.playbackRate || 1)
      );
      if (prev.durationMs > 0) carriedPosition = Math.min(carriedPosition, prev.durationMs);
    }

    // 房间日志由 Worker 在校验通过之后写入 —— DO 不能碰 Mongo（见 resolveProfile 的注释），
    // 而且放在 Worker 侧也天然保证了「先校验归属、再写历史」的顺序。
    this.room = {
      roomId,
      inviter: inviter || user.username,
      publisher: user.username,
      publisherQq: user.qq,
      hostAvatarUrl: user.avatarUrl || '',
      secret: secret || prev?.secret || '',
      deepLink,
      serverUrl: serverUrl || prev?.serverUrl || '',
      currentSong: prev?.currentSong ?? null,
      currentCover: prev?.currentCover ?? null,
      durationMs: prev?.durationMs ?? 0,
      basePositionMs: carriedPosition,
      baseTimestampMs: now,
      playbackRate: prev?.playbackRate ?? 1,
      isPlaying: prev?.isPlaying ?? false,
      startedAt: prev?.startedAt ?? now,
      lastHeartbeatAt: now
    };

    await this.bumpAndBroadcast();
    await this.ensureAlarm();

    return json({ code: 0, message: '房间开播成功', data: publicRoom(this.room) });
  }

  async handleHostState(request) {
    const body = await request.json().catch(() => ({}));
    const { user, playback } = body;

    if (!this.room) {
      return json({ code: 404, message: '房间已失效' }, 404);
    }
    if (this.room.publisherQq !== user?.qq) {
      return json({ code: 403, message: '不是房主' }, 403);
    }

    const now = Date.now();
    this.room.lastHeartbeatAt = now;

    if (playback) {
      if (playback.currentSong !== undefined) this.room.currentSong = playback.currentSong;
      if (playback.currentCover !== undefined) this.room.currentCover = playback.currentCover;
      if (typeof playback.durationMs === 'number') this.room.durationMs = playback.durationMs;
      if (typeof playback.basePositionMs === 'number') this.room.basePositionMs = playback.basePositionMs;
      if (typeof playback.isPlaying === 'boolean') this.room.isPlaying = playback.isPlaying;
      if (typeof playback.playbackRate === 'number') this.room.playbackRate = playback.playbackRate;
      // 位置锚点必须跟着上报时刻一起刷新，否则成员端会拿旧锚点继续外推
      this.room.baseTimestampMs = now;
    }

    await this.bumpAndBroadcast();
    await this.ensureAlarm();

    return json({ code: 0, message: 'ok' });
  }

  async handleHostStop(request) {
    const body = await request.json().catch(() => ({}));

    if (this.room && this.room.publisherQq !== body.user?.qq) {
      return json({ code: 0, message: '非房主请求已忽略' });
    }

    await this.closeRoom('manual');
    return json({ code: 0, message: '房间已安全释放' });
  }

  // ==========================================================
  // 生命周期
  // ==========================================================

  async ensureAlarm() {
    if (!this.room) return;
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  async alarm() {
    if (!this.room) return;

    const idle = Date.now() - (this.room.lastHeartbeatAt || 0);
    if (idle > ROOM_TTL_MS) {
      console.warn(`[RoomHub] 房主心跳已中断 ${Math.round(idle / 1000)}s，自动关房`);
      await this.closeRoom('timeout');
      return;
    }

    await this.verifyRoomStillExists();

    await this.ensureAlarm();
  }

  /**
   * 主动向播放器服务器确认房间是否还在，不在就直接关房。
   *
   * 为什么需要这个：房主 App 可能被杀掉、也可能它自己的 Neri 长连接一直在
   * 静默重试，这时光靠心跳是发现不了「外部房间早就没了」的 ——
   * 房间会一直挂在「正在放歌」而且谁也关不掉。
   *
   * 用的是 GET /api/rooms/{id}/state 这个只读接口。
   * 不能用 join 来探测：那会往房间里塞进一个机器人，正是要避免的东西。
   */
  async verifyRoomStillExists() {
    const room = this.room;
    if (!room?.roomId) return;

    const now = Date.now();
    if (now - this.lastExistenceCheckAt < EXISTENCE_CHECK_INTERVAL_MS) return;
    this.lastExistenceCheckAt = now;

    const base = (room.serverUrl || this.env.DEFAULT_NERI_SERVER || FALLBACK_NERI_SERVER)
      .trim()
      .replace(/\/+$/, '');
    const url = `${base}/api/rooms/${encodeURIComponent(room.roomId)}/state`;

    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(EXISTENCE_CHECK_TIMEOUT_MS)
      });

      if (res.status === 404 || res.status === 410) {
        console.warn(`[RoomHub] 播放器服务器报告房间 ${room.roomId} 已不存在，自动关房`);
        await this.closeRoom('room_gone');
      }
      // 其它状态码（含 5xx）一律不下结论，等下一轮
    } catch (e) {
      // 网络抖动不该误判成「房间没了」
      console.warn('[RoomHub] 房间存活探测失败（忽略本轮）:', e.message);
    }
  }

  async closeRoom(reason) {
    // 没有房间可关就什么都不做：重复 stop 不该再广播一次 room_closed
    if (!this.room) return;

    this.room = null;
    this.version += 1;
    await this.ctx.storage.put({ room: null, version: this.version });
    await this.ctx.storage.deleteAlarm();

    const text = JSON.stringify({
      type: 'room_closed',
      reason,
      version: this.version,
      serverTime: Date.now()
    });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch (e) {
        // 忽略
      }
    }

    // 房间历史由 Worker 侧收尾（按 roomId 归档），DO 不碰 Mongo
  }
}
