import { RoomHub } from '../src/room-hub.js';

class MockStorage {
  constructor() { this.map = new Map(); this.alarm = null; }
  async get(keys) {
    if (Array.isArray(keys)) {
      const m = new Map();
      for (const k of keys) m.set(k, this.map.has(k) ? this.map.get(k) : null);
      return m;
    }
    return this.map.has(keys) ? this.map.get(keys) : null;
  }
  async put(obj) { for (const [k, v] of Object.entries(obj)) this.map.set(k, v); }
  async getAlarm() { return this.alarm; }
  async setAlarm(t) { this.alarm = t; }
  async deleteAlarm() { this.alarm = null; }
}

class MockCtx {
  constructor() { this.storage = new MockStorage(); this.sockets = []; this.ready = null; }
  blockConcurrencyWhile(fn) { this.ready = fn(); return this.ready; }
  acceptWebSocket(ws) { this.sockets.push(ws); }
  getWebSockets() { return this.sockets; }
}

class MockSocket {
  constructor(att) { this._att = att; this.sent = []; }
  serializeAttachment(a) { this._att = a; }
  deserializeAttachment() { return this._att; }
  send(t) { this.sent.push(t); }
  last() { return this.sent.length ? JSON.parse(this.sent[this.sent.length - 1]) : null; }
}

const env = { JWT_SECRET: 'test-secret' }; // 没配 MONGODB_URI，Mongo 相关调用会安全降级

let failures = 0;
function check(label, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${label}`); }
  else { console.log(`  FAIL  ${label} ${extra}`); failures++; }
}

const post = (path, body) => new Request(`https://room-hub${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

const ctx = new MockCtx();
const hub = new RoomHub(ctx, env);
await ctx.ready;

const A = { qq: '1001', username: '阿甲', avatarUrl: 'a.png' };
const B = { qq: '1002', username: '阿乙', avatarUrl: 'b.png' };

console.log('\n[1] 初始快照');
let snap = await (await hub.fetch(new Request('https://room-hub/state'))).json();
check('没有房间', snap.room === null);
check('没有成员', snap.members.length === 0);

console.log('\n[2] 房主开播');
let res = await hub.fetch(post('/host/start', {
  user: A, roomId: 'abc123', inviter: '阿甲', secret: 's3cret',
  deepLink: 'neriplayer://x?roomId=abc123', mongoLogId: null
}));
let data = await res.json();
check('HTTP 200', res.status === 200, `got ${res.status}`);
check('房间已建立', data.data?.roomId === 'abc123');
check('secret 没有外泄到 publicRoom', data.data && !('secret' in data.data));
check('publisherQq 正确', data.data?.publisherQq === '1001');

console.log('\n[3] 成员 = 在线连接，房主即使掉线也在列');
ctx.acceptWebSocket(new MockSocket({ ...A, joinedAt: 100 }));
ctx.acceptWebSocket(new MockSocket({ ...B, joinedAt: 200 }));
snap = await (await hub.fetch(new Request('https://room-hub/state'))).json();
check('两位成员', snap.members.length === 2, JSON.stringify(snap.members));
check('房主被正确标记', snap.members.find(m => m.qq === '1001')?.isHosting === true);
check('成员不重复', new Set(snap.members.map(m => m.qq)).size === 2);

// 房主断开连接后仍必须留在列表里（他在放歌）
ctx.sockets = ctx.sockets.filter(s => s.deserializeAttachment().qq !== '1001');
snap = await (await hub.fetch(new Request('https://room-hub/state'))).json();
check('房主断线后仍在成员列表', snap.members.some(m => m.qq === '1001' && m.isHosting));

console.log('\n[4] 非房主不能改状态');
res = await hub.fetch(post('/host/state', { user: B, playback: { currentSong: '坏歌 - 黑客' } }));
check('返回 403', res.status === 403, `got ${res.status}`);

console.log('\n[5] 房主上报播放状态');
res = await hub.fetch(post('/host/state', {
  user: A,
  playback: { currentSong: '晴天 - 周杰伦', currentCover: 'c.png', durationMs: 269000, basePositionMs: 1000, isPlaying: true }
}));
check('HTTP 200', res.status === 200);
snap = await (await hub.fetch(new Request('https://room-hub/state'))).json();
check('歌曲已更新', snap.room.currentSong === '晴天 - 周杰伦');
check('时长已更新', snap.room.durationMs === 269000);
check('锚点时间戳已刷新', snap.room.baseTimestampMs > 0);

console.log('\n[5b] 同一房间重连：进度锚点必须向前推进，不能回跳');
await hub.fetch(post('/host/state', {
  user: A,
  playback: { currentSong: '晴天 - 周杰伦', durationMs: 269000, basePositionMs: 30_000, isPlaying: true }
}));
const beforeReconnect = (await (await hub.fetch(new Request('https://room-hub/state'))).json()).room;

await new Promise(r => setTimeout(r, 1200));

await hub.fetch(post('/host/start', {
  user: A, roomId: 'abc123', inviter: '阿甲', secret: 's3cret',
  deepLink: 'neriplayer://x?roomId=abc123'
}));
const afterReconnect = (await (await hub.fetch(new Request('https://room-hub/state'))).json()).room;

check('歌曲被保留', afterReconnect.currentSong === '晴天 - 周杰伦');
check(
  '位置向前推进（不归零、不回跳）',
  afterReconnect.basePositionMs >= beforeReconnect.basePositionMs + 1000,
  `${beforeReconnect.basePositionMs} -> ${afterReconnect.basePositionMs}`
);
check('位置不超过总时长', afterReconnect.basePositionMs <= afterReconnect.durationMs);

console.log('\n[5c] /members 轻量在线名单');
const presence = await (await hub.fetch(new Request('https://room-hub/members'))).json();
check('返回 members 数组', Array.isArray(presence.members));
check('带服务器时间', typeof presence.serverTime === 'number');
check('房主仍在列', presence.members.some(m => m.qq === '1001' && m.isHosting));

console.log('\n[6] 第二个人开播应被拒');
res = await hub.fetch(post('/host/start', {
  user: B, roomId: 'zzz999', deepLink: 'neriplayer://x?roomId=zzz999'
}));
check('返回 409 冲突', res.status === 409, `got ${res.status}`);

console.log('\n[7] 非房主关房被忽略');
res = await hub.fetch(post('/host/stop', { user: B }));
data = await res.json();
check('房间仍在', (await (await hub.fetch(new Request('https://room-hub/state'))).json()).room !== null);

console.log('\n[8] 房主心跳中断后 alarm 自动关房');
hub.room.lastHeartbeatAt = Date.now() - 200_000; // 200 秒没心跳，远超 90 秒 TTL
await hub.alarm();
snap = await (await hub.fetch(new Request('https://room-hub/state'))).json();
check('房间已被回收', snap.room === null);
check('广播过 room_closed', ctx.sockets.some(s => s.last()?.type === 'room_closed'));

console.log('\n[9] 关房后重复 stop 不应再广播');
const before = ctx.sockets[0].sent.length;
await hub.fetch(post('/host/stop', { user: A }));
check('没有多余广播', ctx.sockets[0].sent.length === before);

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures === 0 ? 0 : 1);
