// lib/mongodb.js
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
if (!uri) {
  throw new Error('请在环境变量中设置 MONGODB_URI');
}

const options = {
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 5000,
};

let client;
let clientPromise;

if (process.env.NODE_ENV === 'development') {
  if (!global._mongoClientPromise) {
    client = new MongoClient(uri, options);
    global._mongoClientPromise = client.connect();
  }
  clientPromise = global._mongoClientPromise;
} else {
  client = new MongoClient(uri, options);
  clientPromise = client.connect();
}

let isIndexesInitialized = false;
export async function getDatabase() {
  const client = await clientPromise;
  const db = client.db('social_music');

  if (!isIndexesInitialized) {
    try {
      // 🌟 1. 用户表：必须把 qq 作为唯一索引，确保一个 QQ 对应唯一账号
      await db.collection('users').createIndex({ qq: 1 }, { unique: true });

      // 2. 房间历史表：startedAt 建立 90 天自动删除索引 (90 * 86400 秒)
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

export default clientPromise;