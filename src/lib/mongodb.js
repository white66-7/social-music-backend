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
    Promise.all([
      db.collection('users').createIndex({ qq: 1 }, { unique: true }),
      db.collection('room_logs').createIndex(
        { startedAt: 1 },
        { expireAfterSeconds: 7776000 }
      )
    ]).catch(e => {
      console.warn('[MongoDB] 索引初始化异常 (非致命):', e.message);
    });
  }

  return db;
}