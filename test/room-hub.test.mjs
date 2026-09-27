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

console.log('\n[12] 播放器服务器报告房间已消失 → 后端自动关房');
await hub.fetch(post('/host/start', {
  user: A, roomId: 'gone01', inviter: '阿甲', secret: 's3cret',
  deepLink: 'neriplayer://x?roomId=gone01', serverUrl: 'https://neri.test'
}));
snap = await (await hub.fetch(new Request('https://room-hub/state'))).json();
check('房间已建立', snap.room?.roomId === 'gone01');

const realFetch = globalThis.fetch;
// 打桩：播放器服务器说这个房间不存在
globalThis.fetch = async () => new Response('{"ok":false,"error":"room not initialized"}', { status: 404 });
hub.lastExistenceCheckAt = 0;
await hub.alarm();
globalThis.fetch = realFetch;

snap = await (await hub.fetch(new Request('https://room-hub/state'))).json();
check('房间已被自动关闭', snap.room === null);
check('关房原因是 room_gone', ctx.sockets.some(s => {
  const m = s.last();
  return m?.type === 'room_closed' && m.reason === 'room_gone';
}));

console.log('\n[12b] 探测失败（网络抖动）不得误判成房间没了');
await hub.fetch(post('/host/start', {
  user: A, roomId: 'alive01', inviter: '阿甲', secret: 's3cret',
  deepLink: 'neriplayer://x?roomId=alive01', serverUrl: 'https://neri.test'
}));
globalThis.fetch = async () => { throw new Error('network down'); };
hub.lastExistenceCheckAt = 0;
await hub.alarm();
globalThis.fetch = realFetch;

snap = await (await hub.fetch(new Request('https://room-hub/state'))).json();
check('网络异常时房间保留', snap.room?.roomId === 'alive01');

// 收尾，避免影响后续静态检查以外的状态
await hub.fetch(post('/host/stop', { user: A }));

console.log('\n[10] 静态约束：DO 不得引入跨 I/O 上下文的依赖');
// Durable Object 与 Worker 同 isolate 但属于不同 I/O 上下文。
// 之前 DO 里调 getDatabase() 复用了 Worker 建立的 Mongo 连接，线上表现为
// 「Cannot perform I/O on behalf of a different Durable Object」以及请求永久挂住。
// 这条测试就是防止那个 bug 被重新引入。
const { readFileSync } = await import('node:fs');
const hubSource = readFileSync(new URL('../src/room-hub.js', import.meta.url), 'utf8');
check('room-hub.js 不 import mongodb', !/from ['"]mongodb['"]/.test(hubSource));
check('room-hub.js 不 import getDatabase', !/getDatabase/.test(hubSource));
check('room-hub.js 不 import redis', !/lib\/redis/.test(hubSource));
// 注意：出站 fetch 本身没问题 —— 每次调用都会创建属于本 DO 上下文的 I/O。
// 真正致命的是「复用模块级缓存的连接对象」，那条约束在 [11] 里单独检查。
check('room-hub.js 不缓存连接对象', !/^let\s+\w*[Cc]lient\s*=/m.test(hubSource));

console.log('\n[11] 静态约束：数据层必须走 D1，不得再引入要持有连接的客户端');
// Cloudflare 按「请求」划分 I/O 上下文。像 MongoClient 这种要在模块层持有连接的
// 客户端，跨请求复用会让请求永不返回（500 "code had hung"），
// 与 DO 混用时还会抛 "Cannot perform I/O on behalf of a different Durable Object"。
// 实测表现为「一次成功、一次挂死」交替 —— 旧版成员列表在 1 人和 2 人之间横跳的根因。
// 迁到 D1 后这类问题从根上消失，这几条断言防止有人再引回来。
const dbSource = readFileSync(new URL('../src/lib/db.js', import.meta.url), 'utf8');
check('db.js 通过 D1 binding 访问', /env\.DB/.test(dbSource));
check('db.js 不 import 任何数据库驱动', !/from ['"](mongodb|pg|mysql)/.test(dbSource));
check('db.js 模块级没有连接变量', !/^let\s+\w*[Cc]lient\s*=/m.test(dbSource));

const indexSrc = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
check('index.js 不再引用 mongodb', !/mongodb/i.test(indexSrc));
check('index.js 没有连接缓存', !/^let\s+cached/m.test(indexSrc));

console.log('\n[13] 静态约束：房间实时路径不得调用 Mongo');
// 每次请求新建 Mongo 连接要 2~4 秒（Cloudflare 按请求划分 I/O 上下文，
// 连接不能跨请求复用）。开房/关房/查房间状态都是实时操作，
// 一旦这些路由里混进 getDatabase/loadProfile，用户就会明显感觉到卡。
const indexSource = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

function routeBody(path) {
  const start = indexSource.indexOf(`'${path}'`);
  if (start < 0) return '';
  const end = indexSource.indexOf('\n});', start);
  return indexSource.slice(start, end < 0 ? undefined : end);
}

for (const path of ['/api/room/state', '/api/room/host/start', '/api/room/host/stop']) {
  const body = routeBody(path);
  check(`${path} 已抽出处理体`, body.length > 0);
  check(`${path} 不调用 getDatabase/loadProfile`, !/getDatabase|loadProfile/.test(body));
}

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures === 0 ? 0 : 1);
