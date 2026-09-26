import { redis, REDIS_ROOM_KEY, loadRoom, renewRoom, updateRoomMeta } from '../../lib/redis.js';
import { checkRoomExists } from '../../lib/neri.js';
import { getDatabase } from '../../lib/mongodb.js';
import { ObjectId } from 'mongodb';

const PROBE_COOLDOWN_MS = 15 * 1000;

async function archiveRoomLog(room, endReason) {
  if (!room.mongoLogId) return;
  try {
    const db = await getDatabase();
    await db.collection('room_logs').updateOne(
      { _id: new ObjectId(room.mongoLogId) },
      { $set: { status: 'ended', endedAt: new Date(), endReason } }
    );
  } catch (e) {
    console.warn('[MongoDB 警告] 归档失败:', e.message);
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ code: 405, message: '仅支持 GET 请求' });
  }

  try {
    const isForce = req.query.force === 'true';
    const currentRoom = await loadRoom();

    if (!currentRoom) {
      return res.status(200).json({ exists: false });
    }

    const now = Date.now();
    const lastProbedAt = currentRoom.lastProbedAt || 0;
    const needProbe = isForce || (now - lastProbedAt > PROBE_COOLDOWN_MS);

    if (needProbe && currentRoom.roomId) {
      const probe = await checkRoomExists(currentRoom.serverUrl, currentRoom.roomId);

      // 只有 NeriPlayer 服务端明确回答「房间不存在 / 已关闭」才删房（400 / 404 / 410）。
      if (probe === 'dead') {
        await redis.del(REDIS_ROOM_KEY);
        await archiveRoomLog(currentRoom, 'cloud_probe_dead');
        return res.status(200).json({ exists: false, message: '房间已关闭或失效' });
      }

      // 'unknown'（超时、网络不可达、5xx）一律原样放行，绝不能因为一次探活抖动
      // 就把正在放歌的房间删掉 —— 房间真正的过期由房主心跳的租约负责。
      //
      // 'alive' 和 'unknown' 都记录探活时间，免得 NeriPlayer 慢或不可达时被高频轮询
      // 反复捶打；但两者都只动元数据、不续租约，房间何时过期始终由房主心跳决定。
      currentRoom.lastProbedAt = now;
      const ttl = await redis.ttl(REDIS_ROOM_KEY);
      if (ttl > 0) {
        // 保留剩余租约，避免读接口变相给房间续命
        await updateRoomMeta(currentRoom);
      } else if (ttl === -1) {
        // 历史脏数据：老版本把 keepTtl 拼成了 keepttl，被静默忽略后这些房间键
        // 没有过期时间。这里顺手补一个租约，让它们重新受房主心跳约束。
        await renewRoom(currentRoom);
      }
      // ttl === -2 说明 key 刚过期，什么都不做
    }

    return res.status(200).json({
      exists: true,
      inviter: currentRoom.inviter,
      publisher: currentRoom.publisher,
      hostAvatarUrl: currentRoom.hostAvatarUrl,
      deepLink: currentRoom.deepLink,
      roomId: currentRoom.roomId,
      currentSong: currentRoom.currentSong || null,
      currentCover: currentRoom.currentCover || null,
    });
  } catch (error) {
    console.error('[Room Status API Error]', error);
    return res.status(500).json({ code: 500, message: '服务器内部错误' });
  }
}
