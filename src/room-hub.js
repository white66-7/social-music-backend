import jwt from 'jsonwebtoken';

import { DEFAULT_JWT_SECRET } from './lib/auth.js';

/**
 * 房主心跳超时阈值。超过这么久没收到房主上报，就认为房主进程已经没了，
 * 自动关房，避免僵尸房间永远挂在「正在放歌」。
 */
export const ROOM_TTL_MS = 90_000;

/** alarm 的巡检间隔，比 TTL 短，保证超时能被及时发现 */
const ALARM_INTERVAL_MS = 20_000;

/**
 * 「未确认」房间的最长存活时间。
 *
 * 客户端会并行地一边 join 播放器校验口令、一边先把房间挂到后端（pending），
 * 这样开房只需等两次往返里较慢的那一次，而不是相加。
 * 口令校验失败、或客户端半路被杀时，这个占位房间必须自己烂掉。
 * pending 房间对成员端不可见，所以回收它纯粹是资源问题，不会影响任何人。
 */
const PENDING_TTL_MS = 30_000;

/**
 * 主动去播放器服务器确认「房间还在不在」的间隔。
 *
 * 这是**兜底**路径：正常情况下房主 App 的 Neri 长连接会先发现房间没了，
 * 并立刻调 /api/room/host/stop 通知后端（那条路径大约 3~5 秒）。
 * 只有房主 App 被杀掉、或它自己也在重试时才会走到这里，
 * 所以间隔取小一点，把最坏情况压到 20~40 秒。
 */
const EXISTENCE_CHECK_INTERVAL_MS = 20_000;

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

  // 未经房主确认的房间（口令还在校验中）对成员端完全不可见。
  // 否则一次失败的邀请会短暂地在所有人屏幕上闪出一个幽灵房间。
  // 房主自己也不需要这份数据 —— 它本来就知道 roomId，等确认后由快照接管。
  if (room.pending) return null;

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

    // pending 房间还没被房主确认，不能拿它合成成员或角标 ——
    // 否则一次失败的邀请会让所有人短暂看到「某某正在放歌」。
    const hostQq = this.room && !this.room.pending ? this.room.publisherQq : null;

    // 房主把 App 切到后台时可能断开连接，但他还在放歌，必须留在成员列表里，
    // 否则成员数会莫名其妙地掉一个。
    if (hostQq && !byQq.has(hostQq)) {
      byQq.set(hostQq, {
        qq: hostQq,
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
        isHosting: Boolean(hostQq && m.qq === hostQq)
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

    // 先把快照推出去，再落盘。
    // 落盘是一次 await 的存储往返，放在前面等于让每个成员的画面都先等它一下 ——
    // 而版本号和快照在内存里已经自洽，先发没有一致性风险。
    // 最坏情况是 DO 在落盘前被回收、版本号回退一格，而客户端只丢弃「严格更旧」的
    // 版本（MainActivity.applySnapshot），所以不会错乱。
    const text = JSON.stringify(this.snapshot());
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch (e) {
        // 连接刚断，交给 webSocketClose 去收敛成员列表
      }
    }

    await this.persist();
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
   * 身份只从 JWT 里取，这里刻意不查数据库。
   *
   * Durable Object 和 Worker 跑在同一个 isolate 里、却属于**不同的 I/O 上下文**。
   * 在 DO 里碰任何「需要在模块层持有连接」的东西都会踩坑 —— 当初数据还在
   * MongoDB 上时，就因为复用了 Worker 建立的连接而抛
   * "Cannot perform I/O on behalf of a different Durable Object"，或者让请求永远挂住。
   * 现在数据在 D1 上、走 binding 没有连接概念，但 DO 依然不需要查库：
   * 展示用的昵称/头像由 /api/user/list 在 Worker 侧提供，
   * DO 只要 qq 来算在线集合就够了。
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

      // 客户端并行开房：先挂一个占位房间，等口令校验通过再 confirm。
      // 不传 pending 的调用方行为完全不变。
      pending: body.pending === true,

      // 每次 start 都把上报序号的高水位归零 —— 它是客户端「我重新开始计数」的信号。
      // 不归零的话，App 重启后客户端 seq 从 1 开始，会被旧的高水位永久饿死，
      // 表现就是「重启后切歌再也不生效」。
      lastStateSeq: 0,

      lastHeartbeatAt: now
    };

    await this.bumpAndBroadcast();
    await this.ensureAlarm();

    return json({
      code: 0,
      message: this.room.pending ? '房间已受理，等待口令校验' : '房间开播成功',
      pending: Boolean(this.room.pending),
      // pending 房间里 publicRoom() 返回 null，房主端会等确认后的快照接管
      data: publicRoom(this.room)
    });
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

    // 「确认房间可见」和「播放状态」是两件独立的事：前者只关系到房间对成员是否可见，
    // 不该被播放状态的序号闸门挡住 —— 否则一条迟到的上报顺手把 confirm 也吞掉，
    // 房间就永远亮不出来了。所以它放在序号检查之前。
    let justRevealed = false;
    if (body.confirm === true && this.room.pending) {
      this.room.pending = false;
      justRevealed = true;
    }

    // 序号保护 —— 这是「切歌跳回去」的根因。
    //
    // 客户端在跨境长链路上是并发上报的（1~8 秒的往返），先发的后到是常态。
    // 没有这道闸，一次迟到的「上一首」上报会把刚切的新歌覆盖回去，
    // 成员端看到的就是「切歌没反应」或者「又跳回上一首了」。
    //
    // 心跳在上面已经续过了，所以这里直接返回安全 —— 不会把房主误判成掉线。
    // 不写状态、不落盘：这条路径要尽可能廉价。
    if (playback && typeof playback.seq === 'number' && playback.seq <= (this.room.lastStateSeq || 0)) {
      // 唯一的例外：这一条顺手把房间点亮了，那就必须广播出去，不然没人知道它可见了
      if (justRevealed) await this.bumpAndBroadcast();
      return json({ code: 0, message: 'ok', stale: true, revealed: justRevealed });
    }

    if (playback) {
      if (playback.currentSong !== undefined) this.room.currentSong = playback.currentSong;
      if (playback.currentCover !== undefined) this.room.currentCover = playback.currentCover;
      if (typeof playback.durationMs === 'number') this.room.durationMs = playback.durationMs;
      if (typeof playback.basePositionMs === 'number') this.room.basePositionMs = playback.basePositionMs;
      if (typeof playback.isPlaying === 'boolean') this.room.isPlaying = playback.isPlaying;
      if (typeof playback.playbackRate === 'number') this.room.playbackRate = playback.playbackRate;
      if (typeof playback.seq === 'number') this.room.lastStateSeq = playback.seq;
      // 位置锚点必须跟着上报时刻一起刷新，否则成员端会拿旧锚点继续外推
      this.room.baseTimestampMs = now;
      // 收到真实播放状态 = 房主的口令校验已经通过（他在报歌了），房间对成员可见
      this.room.pending = false;
    }

    // 这里刻意不再调 ensureAlarm()：alarm 链是自维持的
    // （hostStart 设一次，alarm() 结尾自己续期），而它每次都要读一遍 storage。
    // 扇出路径上多一次存储往返就是让所有成员的画面一起多等一次。
    await this.bumpAndBroadcast();

    return json({ code: 0, message: 'ok' });
  }

  async handleHostStop(request) {
    const body = await request.json().catch(() => ({}));

    if (this.room && this.room.publisherQq !== body.user?.qq) {
      return json({ code: 0, message: '非房主请求已忽略' });
    }

    // 指定了房间号就必须对得上。
    //
    // 关房一直按「用户」关，这在并发下会误伤：用户关播后立刻重开、或者一次已作废的
    // 开房请求迟到撤销，那条笼统的 stop 会把**刚建好的那个房间**关掉，
    // 而房主端还显示着「房间上线成功」，直到下一次保活才悄悄 404 ——
    // 表现就是「刚开好，过一会儿又不更新了」。
    // 带上房间号之后，这类迟到请求只会打到它自己那一个房间上。
    if (body.roomId && this.room && this.room.roomId !== body.roomId) {
      return json({ code: 0, message: '房间号不匹配，已忽略' });
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

    // pending 房间还没等到口令校验结果，用更短的窗口把它清掉。
    // 它对成员端不可见，所以回收它纯粹是防垃圾（客户端校验途中被杀的情况）。
    if (this.room.pending && idle > PENDING_TTL_MS) {
      console.warn('[RoomHub] 房间确认超时（口令校验未完成），自动回收');
      await this.closeRoom('pending_timeout');
      return;
    }

    if (idle > ROOM_TTL_MS) {
      console.warn(`[RoomHub] 房主心跳已中断 ${Math.round(idle / 1000)}s，自动关房`);
      await this.closeRoom('timeout');
      return;
    }

    // pending 房间去播放器服务器探测毫无意义 —— 房主还没 join 成功，
    // 那边本来就查不到这个房间，探了只会误判成「房间已消失」。
    if (!this.room.pending) {
      await this.verifyRoomStillExists();
    }

    // 无条件续期：能走到这里说明本次 alarm 已经触发，旧闹钟必然不存在了，
    // 再读一次 getAlarm() 纯属多一次存储往返。
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
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
