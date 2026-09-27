-- 用户档案。qq 是主键，也是唯一身份标识（昵称可以随时改，不能拿来认人）。
CREATE TABLE IF NOT EXISTS users (
  qq             TEXT PRIMARY KEY,
  username       TEXT NOT NULL,
  avatar_url     TEXT NOT NULL DEFAULT '',
  pin            TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER
);

-- 成员列表按活跃时间倒序展示
CREATE INDEX IF NOT EXISTS idx_users_last_active ON users (last_active_at DESC);

-- 房间历史。room_id 做主键：同一个邀请链接反复开播只留一条记录。
CREATE TABLE IF NOT EXISTS room_logs (
  room_id         TEXT PRIMARY KEY,
  publisher       TEXT NOT NULL DEFAULT '',
  inviter         TEXT NOT NULL DEFAULT '',
  host_avatar_url TEXT NOT NULL DEFAULT '',
  deep_link       TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  end_reason      TEXT
);

CREATE INDEX IF NOT EXISTS idx_room_logs_started ON room_logs (started_at DESC);

-- 收尾「还在 active 的记录」时会按 status 过滤
CREATE INDEX IF NOT EXISTS idx_room_logs_status ON room_logs (status);
