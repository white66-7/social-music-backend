import { redis, REDIS_ROOM_KEY, loadRoom, renewRoom, updateRoomMeta } from '../../lib/redis.js';
import { checkRoomExists, fetchCurrentRoomState } from '../../lib/neri.js';
import { getDatabase } from '../../lib/mongodb.js';
import { ObjectId } from 'mongodb';

const PROBE_COOLDOWN_MS = 15 * 1000;
const STATE_SYNC_COOLDOWN_MS = 10 * 1000; // 防并发击穿与过频加入

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

    // 1. 房间存活探活 (死房即刻下线)
    const lastProbedAt = currentRoom.lastProbedAt || 0;
    const needProbe = isForce || (now - lastProbedAt > PROBE_COOLDOWN_MS);

    if (needProbe && currentRoom.roomId) {
      const probe = await checkRoomExists(currentRoom.serverUrl, currentRoom.roomId);

      if (probe === 'dead') {
        await redis.del(REDIS_ROOM_KEY);
        await archiveRoomLog(currentRoom, 'cloud_probe_dead');
        return res.status(200).json({ exists: false, message: '房间已关闭或失效' });
      }

      currentRoom.lastProbedAt = now;
      const ttl = await redis.ttl(REDIS_ROOM_KEY);
      if (ttl > 0) {
        await updateRoomMeta(currentRoom);
      } else if (ttl === -1) {
        await renewRoom(currentRoom);
      }
    }

    // 2. 切歌刷新检测 (按需懒加载)
    let estimatedPosition = currentRoom.basePositionMs || 0;
    if (currentRoom.isPlaying && currentRoom.baseTimestampMs) {
      estimatedPosition += (now - currentRoom.baseTimestampMs) * (currentRoom.playbackRate || 1);
    }

    const isSongFinished = currentRoom.durationMs > 0 && estimatedPosition >= currentRoom.durationMs;
    const lastStateSyncAt = currentRoom.lastStateSyncAt || 0;
    const isCoolDownPassed = now - lastStateSyncAt > STATE_SYNC_COOLDOWN_MS;

    // 当歌曲播放完毕或者前端强制刷新，且已过冷却时间，拉取最新一首歌
    if ((isSongFinished || isForce) && isCoolDownPassed && currentRoom.secret) {
      // 先写回冷却时间戳，相当于抢占锁，防止并发容器同时 join
      currentRoom.lastStateSyncAt = now;
      await updateRoomMeta(currentRoom);

      const latest = await fetchCurrentRoomState(currentRoom.serverUrl, currentRoom.roomId, currentRoom.secret);
      if (latest && latest.currentSong) {
        currentRoom.currentSong = latest.currentSong;
        currentRoom.currentCover = latest.currentCover;
        currentRoom.durationMs = latest.durationMs;
        currentRoom.basePositionMs = latest.basePositionMs;
        currentRoom.baseTimestampMs = latest.baseTimestampMs;
        currentRoom.playbackRate = latest.playbackRate;
        currentRoom.isPlaying = latest.isPlaying;

        await updateRoomMeta(currentRoom);
      }
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
      durationMs: currentRoom.durationMs || 0,
      basePositionMs: currentRoom.basePositionMs || 0,
      baseTimestampMs: currentRoom.baseTimestampMs || now,
      playbackRate: currentRoom.playbackRate || 1,
      isPlaying: currentRoom.isPlaying ?? true,
    });
  } catch (error) {
    console.error('[Room Status API Error]', error);
    return res.status(500).json({ code: 500, message: '服务器内部错误' });
  }
}