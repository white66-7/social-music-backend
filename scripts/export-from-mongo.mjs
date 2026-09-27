/**
 * 一次性脚本：把 MongoDB 里的用户和房间历史导出成 D1 能直接执行的 SQL。
 *
 * 用法：
 *   node scripts/export-from-mongo.mjs          # 生成 seed.sql
 *   npx wrangler d1 execute social-music-db --remote --file=seed.sql
 *
 * 迁移完成后，这个脚本和 package.json 里的 mongodb 依赖都可以删掉。
 * 生成的 seed.sql 含用户数据，已在 .gitignore 里排除。
 */
import fs from 'node:fs';
import dns from 'node:dns';
import { MongoClient } from 'mongodb';

// 这台机器 c-ares 会回退到无效的 127.0.0.1，必须显式指定 DNS
dns.setServers(['223.5.5.5', '114.114.114.114']);

const OUT_PATH = 'seed.sql';

function readDevVars() {
  const vars = {};
  for (const raw of fs.readFileSync('.dev.vars', 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    vars[line.slice(0, i).trim()] = v;
  }
  return vars;
}

function sqlStr(value) {
  if (value === null || value === undefined) return 'NULL';
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/**
 * 数值字段。
 * 必须单独处理 null —— 直接塞进数组再 join 的话会被转成空串，
 * 结果就是 "... 1790495881076, )" 这种尾逗号语法错误。
 */
function sqlNum(value) {
  if (value === null || value === undefined) return 'NULL';
  return String(value);
}

/** Mongo 里的时间既可能是 Date 也可能是毫秒数，统一成毫秒 */
function toMillis(value) {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const vars = readDevVars();
if (!vars.MONGODB_URI) {
  console.error('✗ .dev.vars 里没有 MONGODB_URI');
  process.exit(1);
}

const client = new MongoClient(vars.MONGODB_URI, {
  maxPoolSize: 2,
  serverSelectionTimeoutMS: 8000
});

console.error('正在连接 MongoDB…');
await client.connect();
const db = client.db('social_music');

const lines = ['-- 由 scripts/export-from-mongo.mjs 自动生成', ''];

const users = await db.collection('users').find({}).toArray();
lines.push(`-- 用户 ${users.length} 条`);
let userCount = 0;
for (const u of users) {
  if (!u.qq) continue;
  const qq = String(u.qq);
  lines.push(
    'INSERT INTO users (qq, username, avatar_url, pin, created_at, last_active_at, updated_at) VALUES (' +
      [
        sqlStr(qq),
        sqlStr(u.username || `网友_${qq.slice(-4)}`),
        sqlStr(u.avatarUrl || ''),
        sqlStr(u.pin || ''),
        sqlNum(toMillis(u.createdAt) ?? Date.now()),
        sqlNum(toMillis(u.lastActiveAt) ?? 0),
        sqlNum(toMillis(u.updatedAt))
      ].join(', ') +
      ') ON CONFLICT(qq) DO NOTHING;'
  );
  userCount++;
}

const logs = await db.collection('room_logs').find({}).toArray();
lines.push('', `-- 房间历史 ${logs.length} 条（room_id 是主键，重复的只保留一条）`);
let logCount = 0;
const seen = new Set();
for (const l of logs) {
  if (!l.roomId || seen.has(l.roomId)) continue;
  seen.add(l.roomId);
  lines.push(
    'INSERT INTO room_logs (room_id, publisher, inviter, host_avatar_url, deep_link, status, started_at, ended_at, end_reason) VALUES (' +
      [
        sqlStr(l.roomId),
        sqlStr(l.publisher || ''),
        sqlStr(l.inviter || ''),
        sqlStr(l.hostAvatarUrl || ''),
        sqlStr(l.deepLink || ''),
        sqlStr(l.status || 'ended'),
        sqlNum(toMillis(l.startedAt) ?? Date.now()),
        sqlNum(toMillis(l.endedAt)),
        sqlStr(l.endReason)
      ].join(', ') +
      ') ON CONFLICT(room_id) DO UPDATE SET\n' +
      '  publisher = excluded.publisher,\n' +
      '  inviter = excluded.inviter,\n' +
      '  host_avatar_url = excluded.host_avatar_url,\n' +
      '  deep_link = excluded.deep_link,\n' +
      '  status = excluded.status,\n' +
      '  started_at = excluded.started_at,\n' +
      '  ended_at = excluded.ended_at,\n' +
      '  end_reason = excluded.end_reason;'
  );
  logCount++;
}

await client.close();

fs.writeFileSync(OUT_PATH, lines.join('\n') + '\n', 'utf8');

console.error(`✓ 已生成 ${OUT_PATH}：用户 ${userCount} 条、房间历史 ${logCount} 条`);
console.error('  下一步：npx wrangler d1 execute social-music-db --remote --file=seed.sql');
