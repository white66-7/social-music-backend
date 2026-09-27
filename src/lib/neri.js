const DEFAULT_NERI_SERVER = 'https://neriplayer.hancat.work';
/**
 * 规范化服务器地址
 */
export function normalizeBase(serverUrl) {
  let base = (serverUrl || DEFAULT_NERI_SERVER).trim();
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
  return base.replace(/\/+$/, '');
}

/**
 * 播放状态提取工具函数
 */
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

export async function verifyRoomSecret(serverUrl, roomId, secret) {
  // 直接放行，杜绝发包
  return {
    ok: true,
    currentSong: null,
    currentCover: null,
    durationMs: 0,
    basePositionMs: 0,
    baseTimestampMs: Date.now(),
    playbackRate: 1,
    isPlaying: true
  };
}

export async function checkRoomExists(serverUrl, roomId, secret = '') {
  return 'alive';
}

export async function fetchCurrentRoomState(serverUrl, roomId, secret) {
  return null;
}