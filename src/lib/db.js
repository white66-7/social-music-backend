/**
 * 数据层：Cloudflare D1（SQLite）。
 *
 * 2026-09 从 MongoDB 迁过来，原因是 Cloudflare 按「请求」划分 I/O 上下文：
 * MongoClient 不能跨请求复用，于是每个请求都得重建连接，实测一次 2~4 秒，
 * 把登录、成员列表、开房全拖慢了。D1 是 binding 调用，没有连接概念，
 * 单次查询 1~5ms，也顺带消除了「跨上下文复用 I/O 对象」那一整类坑。
 */

export function getDb(env) {
  if (!env.DB) {
    throw new Error('未配置 D1 绑定 DB');
  }
  return env.DB;
}

/** 把 D1 的行转成对外的用户结构（绝不带 pin） */
export function toPublicUser(row) {
  return {
    qq: String(row.qq),
    username: row.username,
    avatarUrl: row.avatar_url || '',
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at
  };
}

/** 由 QQ 号推导头像 —— 本应用头像始终来自 QQ，用户无法在应用内修改 */
export function qqAvatarUrl(qq) {
  return `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640`;
}

export function defaultNickname(qq) {
  return `网友_${String(qq).slice(-4)}`;
}

// ==========================================================
// 用户
// ==========================================================

export async function findUser(env, qq) {
  return getDb(env)
    .prepare(
      'SELECT qq, username, avatar_url, pin, created_at, last_active_at FROM users WHERE qq = ?'
    )
    .bind(String(qq))
    .first();
}

/** 全部注册成员，按最近活跃倒序 */
export async function listUsers(env) {
  const { results } = await getDb(env)
    .prepare(
      'SELECT qq, username, avatar_url, last_active_at FROM users ORDER BY last_active_at DESC'
    )
    .all();
  return results || [];
}

/** 新建档案。qq 已存在时什么都不做（幂等） */
export async function insertUser(env, { qq, username, avatarUrl, pin, createdAt }) {
  await getDb(env)
    .prepare(
      `INSERT INTO users (qq, username, avatar_url, pin, created_at, last_active_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(qq) DO NOTHING`
    )
    .bind(String(qq), username, avatarUrl || '', pin || '', createdAt, createdAt)
    .run();
}

/**
 * 登录成功后更新档案。
 * pin 只在需要时传（首次哈希、或把历史明文口令升级成 bcrypt）。
 */
export async function touchUserLogin(env, qq, { pin, lastActiveAt }) {
  const db = getDb(env);
  if (pin) {
    await db
      .prepare('UPDATE users SET pin = ?, last_active_at = ? WHERE qq = ?')
      .bind(pin, lastActiveAt, String(qq))
      .run();
  } else {
    await db
      .prepare('UPDATE users SET last_active_at = ? WHERE qq = ?')
      .bind(lastActiveAt, String(qq))
      .run();
  }
}

/**
 * 同步档案。刻意只更新已存在的行（不 upsert）——
 * 以前会凭空造出没有 pin 的档案，而登录又曾把「没有 pin」当首次绑定放行。
 * 返回是否命中已有档案。
 */
export async function syncUserProfile(env, qq, { username, avatarUrl }) {
  const now = Date.now();
  const cleanName = (username || '').trim();
  const cleanAvatar = (avatarUrl || '').trim();

  const res = await getDb(env)
    .prepare(
      `UPDATE users
       SET last_active_at = ?,
           updated_at = ?,
           username = CASE WHEN ? <> '' THEN ? ELSE username END,
           avatar_url = CASE WHEN ? <> '' THEN ? ELSE avatar_url END
       WHERE qq = ?`
    )
    .bind(now, now, cleanName, cleanName, cleanAvatar, cleanAvatar, String(qq))
    .run();

  return Boolean(res.meta && res.meta.changes > 0);
}

/** 改昵称；档案不存在时补建一条（沿用旧 upsert 的语义） */
export async function setUsername(env, qq, newName) {
  const db = getDb(env);
  const now = Date.now();

  const res = await db
    .prepare('UPDATE users SET username = ?, last_active_at = ?, updated_at = ? WHERE qq = ?')
    .bind(newName, now, now, String(qq))
    .run();

  if (res.meta && res.meta.changes > 0) return;

  await db
    .prepare(
      `INSERT INTO users (qq, username, avatar_url, pin, created_at, last_active_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?, ?)
       ON CONFLICT(qq) DO NOTHING`
    )
    .bind(String(qq), newName, qqAvatarUrl(qq), now, now, now)
    .run();
}

// ==========================================================
// 房间历史
// ==========================================================

/** 开播时记录。同一个 room_id 复用同一条历史 */
export async function upsertRoomLog(env, { roomId, publisher, inviter, hostAvatarUrl, deepLink }) {
  await getDb(env)
    .prepare(
      `INSERT INTO room_logs
         (room_id, publisher, inviter, host_avatar_url, deep_link, status, started_at, ended_at, end_reason)
       VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, NULL)
       ON CONFLICT(room_id) DO UPDATE SET
         publisher       = excluded.publisher,
         inviter         = excluded.inviter,
         host_avatar_url = excluded.host_avatar_url,
         deep_link       = excluded.deep_link,
         status          = 'active',
         started_at      = excluded.started_at,
         ended_at        = NULL,
         end_reason      = NULL`
    )
    .bind(roomId, publisher, inviter, hostAvatarUrl || '', deepLink, Date.now())
    .run();
}

/**
 * 收尾当前活动房间。全站同时只允许一个房间，所以不用 room_id 也能精确定位。
 * 同时覆盖「房主主动关房」和「超时被回收」两条路径。
 */
export async function endActiveRoomLogs(env, reason) {
  await getDb(env)
    .prepare('UPDATE room_logs SET status = ?, ended_at = ?, end_reason = ? WHERE status = ?')
    .bind('ended', Date.now(), reason === 'timeout' ? 'timeout' : 'manual', 'active')
    .run();
}

export async function listRoomLogs(env, limit) {
  const { results } = await getDb(env)
    .prepare(
      `SELECT room_id, publisher, inviter, host_avatar_url, started_at, ended_at, status
       FROM room_logs ORDER BY started_at DESC LIMIT ?`
    )
    .bind(limit)
    .all();
  return results || [];
}
