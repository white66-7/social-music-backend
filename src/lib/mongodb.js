import { MongoClient } from 'mongodb';

let cachedClient = null;
let isIndexesInitialized = false;

export async function getDatabase(env) {
  const uri = env.MONGODB_URI;
  if (!uri) {
    throw new Error('请配置 MONGODB_URI 环境变量');
  }

  // ⚡ 检查并建立连接，如果连接失败清空缓存，确保下次可以重新连
  if (!cachedClient) {
    try {
      cachedClient = new MongoClient(uri, {
        maxPoolSize: 2, // Workers 边缘单线程，连接池保持在 1~2 最轻量省连接
        serverSelectionTimeoutMS: 4000,
        connectTimeoutMS: 4000,
      });
      await cachedClient.connect();
    } catch (err) {
      cachedClient = null; // 失败时清空，防止死连接残留
      throw err;
    }
  }

  const db = cachedClient.db('social_music');

  // ⚡ 核心修复：后台异步创建索引，绝不使用 await 阻塞用户请求！
  if (!isIndexesInitialized) {
    isIndexesInitialized = true;
    // 用 allSettled：某个索引建失败（比如历史数据本来就有重复）不该连累其它的
    Promise.allSettled([
      db.collection('users').createIndex({ qq: 1 }, { unique: true }),
      db.collection('room_logs').createIndex(
        { startedAt: 1 },
        { expireAfterSeconds: 7776000 }
      ),
      // room_logs 按 roomId 唯一：同一个邀请链接反复开播，在历史里应该是一条记录。
      // RoomHub.openRoomLog 的 upsert 语义依赖这个索引。
      db.collection('room_logs').createIndex({ roomId: 1 }, { unique: true })
    ]).then(results => {
      for (const r of results) {
        if (r.status === 'rejected') {
          console.warn('[MongoDB] 索引初始化异常 (非致命):', r.reason?.message);
        }
      }
    });
  }

  return db;
}