import { MongoClient } from 'mongodb';

const DB_NAME = 'social_music';

const CLIENT_OPTIONS = {
  maxPoolSize: 2,
  serverSelectionTimeoutMS: 4000,
  connectTimeoutMS: 4000
};

/**
 * ⚠️ 每个请求单独建连，绝不能把 MongoClient 缓存在模块作用域。
 *
 * Cloudflare 的运行时会按「请求」划分 I/O 上下文。把连接缓存在模块级、
 * 在另一个请求里复用它，请求就会永远不返回，客户端拿到的是 500
 * "code had hung and would never generate a response"；
 * 如果同一个请求里还调用了 Durable Object，则会直接抛
 * "Cannot perform I/O on behalf of a different Durable Object"。
 *
 * 实测（wrangler dev，同一路由连续请求）：
 *   模块级缓存：659ms 成功 → 挂死 → 384ms 成功 → 挂死   （一次成功一次失败交替）
 *   每请求新建：565ms → 555ms → 563ms → 654ms          （全部成功）
 *
 * 那个「一次成功一次失败」的交替，正是旧版成员列表在「只有我一个」和
 * 「两个人」之间反复横跳的根因 —— 失败时客户端降级成了只显示自己。
 *
 * 代价是一次 TCP+TLS+认证握手（边缘到 Atlas 大约几十到一百毫秒），
 * 换回来的是稳定；同一个请求内多次取库仍然复用同一个连接。
 */
export async function getDatabase(c) {
  const existing = c.get('__db');
  if (existing) return existing;

  const uri = c.env.MONGODB_URI;
  if (!uri) {
    throw new Error('请配置 MONGODB_URI 环境变量');
  }

  const client = new MongoClient(uri, CLIENT_OPTIONS);
  await client.connect();

  const db = client.db(DB_NAME);
  c.set('__db', db);
  c.set('__dbClient', client);

  await ensureIndexes(db);
  return db;
}

/**
 * 请求结束时释放连接。由 index.js 的中间件在 finally 里调用。
 * 不关的话，每个请求都会泄漏一条到 Atlas 的连接。
 */
export async function closeDatabase(c) {
  const client = c.get('__dbClient');
  if (!client) return;
  try {
    await client.close();
  } catch (e) {
    console.warn('[MongoDB] 关闭连接失败:', e.message);
  }
}

/**
 * 索引是 DDL，每个 isolate 建一次就够了。
 * 这个 promise 只是结果，本身不持有 I/O 对象，所以放模块级是安全的。
 */
let indexesReady = null;

function ensureIndexes(db) {
  if (!indexesReady) {
    indexesReady = Promise.allSettled([
      db.collection('users').createIndex({ qq: 1 }, { unique: true }),
      db.collection('room_logs').createIndex(
        { startedAt: 1 },
        { expireAfterSeconds: 7776000 }
      ),
      // 同一个邀请链接反复开播，在历史里应该是一条记录。
      // 注意：历史数据里若已有重复 roomId，这个索引会建失败（只打警告，不影响功能）。
      db.collection('room_logs').createIndex({ roomId: 1 }, { unique: true })
    ]).then(results => {
      for (const r of results) {
        if (r.status === 'rejected') {
          console.warn('[MongoDB] 索引初始化异常 (非致命):', r.reason?.message);
        }
      }
    });
  }
  return indexesReady;
}
