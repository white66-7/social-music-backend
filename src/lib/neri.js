const DEFAULT_NERI_SERVER = 'https://neriplayer.hancat.work';
const PROBE_UUID = '00000000-0000-4000-8000-000000000000';

function normalizeBase(serverUrl) {
  let base = (serverUrl || DEFAULT_NERI_SERVER).trim();
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
  return base.replace(/\/+$/, '');
}

async function postJoin(base, roomId, body, timeoutMs) {
  return fetch(`${base}/api/rooms/${encodeURIComponent(roomId)}/join`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10) NeriPlayer/1.0',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export function extractPlaybackInfo(state) {
  if (!state) return null;

  const track = state.track || (
    Array.isArray(state.queue) && state.currentIndex >= 0
      ? state.queue[state.currentIndex]
      : null
  );

  const songTitle = track?.name || null;
  const artist = track?.artist || '未知歌手';
  const currentSong = songTitle ? `${songTitle} - ${artist}` : null;
  const currentCover = track?.coverUrl || null;
  const durationMs = track?.durationMs || 0;

  const playback = state.playback || {};
  const isPlaying = playback.state === 'playing';
  const basePositionMs = playback.basePositionMs || 0;
  const baseTimestampMs = playback.baseTimestampMs || Date.now();
  const playbackRate = playback.playbackRate || 1;

  return {
    currentSong,
    currentCover,
    durationMs,
    basePositionMs,
    baseTimestampMs,
    playbackRate,
    isPlaying
  };
}

/**
 * ⚡ 修复探活误杀逻辑：支持传入 secret，并将 400/403 判定为活着，杜绝误杀
 */
export async function checkRoomExists(serverUrl, roomId, secret = '') {
  const base = normalizeBase(serverUrl);
  try {
    const payload = { userUuid: PROBE_UUID, nickname: '审核助手' };
    if (secret) payload.joinSecret = secret.trim();

    const response = await postJoin(base, roomId, payload, 3500);

    // 200 成功 / 403 拒绝 / 400 提示需要口令，均代表房间存在
    if ([200, 400, 403].includes(response.status)) return 'alive';
    // 404 未找到 / 410 已解散，代表房间已彻底死亡
    if ([404, 410].includes(response.status)) return 'dead';
    return 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

export async function fetchCurrentRoomState(serverUrl, roomId, secret) {
  const base = normalizeBase(serverUrl);
  let token = null;

  try {
    const res = await postJoin(
      base,
      roomId,
      {
        userUuid: PROBE_UUID,
        nickname: '审核助手',
        joinSecret: (secret || '').trim(),
      },
      3500
    );

    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok || !json.state) return null;

    token = json.token;
    return extractPlaybackInfo(json.state);
  } catch (e) {
    return null;
  } finally {
    if (token) {
      try {
        await fetch(`${base}/api/rooms/${encodeURIComponent(roomId)}/leave`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'Mozilla/5.0 (Linux; Android 10) NeriPlayer/1.0',
          },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(1500),
        });
      } catch (_) {}
    }
  }
}

export async function verifyRoomSecret(serverUrl, roomId, secret) {
  const base = normalizeBase(serverUrl);
  let token = null;

  try {
    const joinResponse = await postJoin(
      base,
      roomId,
      {
        userUuid: PROBE_UUID,
        nickname: '审核助手',
        joinSecret: (secret || '').trim(),
      },
      3500
    );

    const result = await joinResponse.json().catch(() => null);

    if (!joinResponse.ok || !result || result.ok !== true) {
      let message = '房间不存在';
      if (result?.error) {
        const errLower = result.error.toLowerCase();
        if (errLower.includes('secret') || errLower.includes('unauthorized')) {
          message = '房间口令错误';
        } else if (errLower.includes('not found') || errLower.includes('room missing')) {
          message = '房间已关闭';
        } else {
          message = `房间拒绝: ${result.error}`;
        }
      }
      return { ok: false, message };
    }

    token = result.token;
    const playbackInfo = extractPlaybackInfo(result.state);
    return {
      ok: true,
      ...playbackInfo
    };
  } catch (error) {
    return {
      ok: false,
      message: `核验超时: ${error.message || '请检查服务器配置'}`,
    };
  } finally {
    if (token) {
      try {
        await fetch(`${base}/api/rooms/${encodeURIComponent(roomId)}/leave`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'Mozilla/5.0 (Linux; Android 10) NeriPlayer/1.0',
          },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(1500),
        });
      } catch (_) {}
    }
  }
}