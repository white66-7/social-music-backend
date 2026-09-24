const DEFAULT_NERI_SERVER = 'https://neriplayer.hancat.work';

// 探活专用身份。因为只读探活不携带 joinSecret，NeriPlayer 服务端会在创建成员之前
// 就 403 返回，这个 UUID 不会真的进房间，复用不会和任何真实成员冲突。
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

/**
 * 只读探活：POST /join，但故意不带 joinSecret。
 *
 * NeriPlayer-LTW 的 join 路由里，房间存在性检查排在密钥检查之前，且所有提前 return
 * 都发生在「创建成员 + 广播 room_state_updated」之前，所以这条路径：
 *   - 不会创建成员（不会留下幽灵成员）
 *   - 不会广播房间状态
 *   - 不会触发 autoPauseOnMemberChange 把所有人的歌暂停
 *
 * 返回三态：
 *   'alive'   房间存在且活跃（403 join_secret_required）
 *   'dead'    房间明确不存在 / 已关闭（400 / 404 / 410）
 *   'unknown' 超时、网络不可达或服务端 5xx —— 绝不允许据此删房
 */
export async function checkRoomExists(serverUrl, roomId) {
  const base = normalizeBase(serverUrl);
  try {
    const response = await postJoin(
      base,
      roomId,
      { userUuid: PROBE_UUID, nickname: '审核助手' },
      4000
    );

    if (response.status === 403) return 'alive';
    if ([400, 404, 410].includes(response.status)) return 'dead';
    return 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

/**
 * 开播前的口令核验：真的用 joinSecret 加入一次房间，成功后立刻退出。
 *
 * ⚠️ 这条路径会让房间里所有人的播放暂停（NeriPlayer 的 autoPauseOnMemberChange
 * 默认开启，新成员加入和显式离开都会触发），所以只能用在「房主刚开播、房间还没人」
 * 的场景，绝不能放到轮询路径上。轮询请用 checkRoomExists。
 */
export async function verifyRoomSecret(serverUrl, roomId, secret) {
  const base = normalizeBase(serverUrl);
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

    const joinText = await joinResponse.text();
    let result = null;
    try {
      result = JSON.parse(joinText);
    } catch (_) {}

    if (!joinResponse.ok || !result || result.ok !== true) {
      let message = '该 NeriPlayer 房间不存在或口令已失效';
      if (result?.error) {
        const errLower = result.error.toLowerCase();
        if (errLower.includes('secret') || errLower.includes('unauthorized')) {
          message = '房间口令/密钥错误或已失效';
        } else if (errLower.includes('not found') || errLower.includes('room missing')) {
          message = '房间已关闭或房主已离开';
        } else {
          message = `房间拒绝: ${result.error}`;
        }
      }
      return { ok: false, message };
    }

    const token = result.token;
    if (token) {
      fetch(`${base}/api/rooms/${encodeURIComponent(roomId)}/leave`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10) NeriPlayer/1.0',
        },
        body: JSON.stringify({}),
      }).catch(() => {});
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: `核验超时或无法连通节点: ${error.message || '请检查服务器配置'}`,
    };
  }
}

export { DEFAULT_NERI_SERVER };
