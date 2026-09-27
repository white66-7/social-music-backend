import { MongoClient } from 'mongodb';

let cachedClient = null;
let isIndexesInitialized = false;

export async function getDatabase(env) {
  const uri = env.MONGODB_URI;
  if (!uri) {
    throw new Error('请配置 MONGODB_URI 环境变量');
  }

  if (!cachedClient) {
    cachedClient = new MongoClient(uri, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 5000,
    });
    await cachedClient.connect();
  }

  const db = cachedClient.db('social_music');

  if (!isIndexesInitialized) {
    try {
      await db.collection('users').createIndex({ qq: 1 }, { unique: true });
      await db.collection('room_logs').createIndex(
        { startedAt: 1 },
        { expireAfterSeconds: 7776000 }
      );
      isIndexesInitialized = true;
    } catch (e) {
      console.warn('[MongoDB] 索引初始化异常 (非致命):', e.message);
    }
  }

  return db;
}