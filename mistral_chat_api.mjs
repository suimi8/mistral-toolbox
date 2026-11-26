// Mistral chat.mistral.ai 纯协议客户端（http2 直连绕 Cloudflare）
// 流程: message.newChat(首条) → chatId + userMessageId
//       POST /api/chat mode=start|append → SSE-ish "len:{json}" JSON-Patch 流
// 代理: --proxy <url> 或环境变量 MISTRAL_PROXY；通过 HTTP CONNECT 隧道转发 http2 直连
//      （undici/fetch 的 h1 指纹会被 Cloudflare 挑战，必须保住 node:http2 指纹）
import { readFileSync } from 'fs';
import { connect } from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import { randomUUID } from 'node:crypto';

// 2026-11 与官方 web 客户端逐头对齐（逆向 app.asar 实证 + 本机 Edge 156 CDP 实测 sec-ch-ua grease）：
//  - tRPC 端点（/api/trpc/*）官方 JS 级头: x-trpc-source / x-le-chat-inactive-message-content
//  - trpc-accept 刻意不发（实测 2026-11-25）：带上它上游会切换成分片 superjson JSONL 流
//    （逐行渐进补全对象），解码成本高且无收益；不带则返回整段 JSON 数组，两种格式
//    均为官方服务端合法输出且实测同过 Cloudflare（两种形态实测均 200）
//  - /api/chat 官方只显式设 content-type；accept 不设（浏览器默认 */*）
//  - 同源 GET 不发 origin（浏览器行为）；POST 带 origin + content-length
//  - accept-encoding 刻意不发：node:http2 不自动解压，上游 /api/chat 事件流需保持明文
const SEC_CH_UA = '"Not:A-Brand";v="8", "Chromium";v="156", "Microsoft Edge";v="156"';

// ---------- 客户端形态: 'web'(默认) | 'desktop' ----------
// 逆向实证（le-chat-desktop/package.json@1.6.0 + desktop-main）:
//   桌面端的 UI 就是 le-chat-web 同一套源码（"#ui/* points to le-chat-web source"），
//   对话请求由主进程原样转发到 chat.mistral.ai（删 host/origin、注入会话 cookie），
//   并用 ensureDesktopUserAgent 在 UA 后追加: `LeChat-Desktop/${版本} (${platform};${flavor};${arch})`
//   → 实测常量: LeChat-Desktop/1.6.0 (win32; production; x86_64)
// 因此桌面端/网页端是同一套 API，差异只在 UA 追加标记。
// (--client-profile 也可透传：reverse_proxy 启动参数里带 --client-profile desktop 即可)
let clientProfile = 'web';
export function setClientProfile(p) { clientProfile = p === 'desktop' ? 'desktop' : 'web'; }
export function getClientProfile() { return clientProfile; }
const DESKTOP_UA_SUFFIX = 'LeChat-Desktop/1.6.0 (win32; production; x86_64)';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0';
function currentUA() {
  return clientProfile === 'desktop' ? `${UA} ${DESKTOP_UA_SUFFIX}` : UA;
}

/** 从启动参数/环境变量感知客户端形态（供 reverse_proxy 等直接透传 --client-profile desktop） */
function detectClientProfile() {
  if (process.argv.includes('--client-profile')) {
    const v = process.argv[process.argv.indexOf('--client-profile') + 1];
    if (v === 'desktop' || v === 'web') clientProfile = v;
  } else if (process.env.MISTRAL_CLIENT_PROFILE) {
    clientProfile = process.env.MISTRAL_CLIENT_PROFILE === 'desktop' ? 'desktop' : 'web';
  }
}

// ---------- 出口代理（--proxy / MISTRAL_PROXY；http2 over CONNECT 隧道） ----------
let proxyUrl = null;
export function setChatProxy(url) { proxyUrl = url ? String(url) : null; }
function detectProxy() {
  if (proxyUrl) return proxyUrl;
  const i = process.argv.indexOf('--proxy');
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return (proxyUrl = process.argv[i + 1]);
  if (process.env.MISTRAL_PROXY) return (proxyUrl = process.env.MISTRAL_PROXY);
  return null;
}

/** 建立 http2 会话：无代理直连；有代理先 CONNECT 隧道再 TLS 升级（保住 http2 指纹，绕过 CF 对 h1 的拦截） */
async function connectH2(proxy) {
  if (!proxy) return connect('https://chat.mistral.ai', { protocol: 'https:' });
  return new Promise((resolve, reject) => {
    const u = new URL(proxy);
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    const socket = net.connect(port, u.hostname);
    socket.setTimeout(20000, () => { socket.destroy(); reject(new Error('代理连接超时')); });
    socket.once('error', (e) => reject(new Error('代理连接失败: ' + e.message)));
    socket.once('connect', () => {
      const auth = u.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || '')}`).toString('base64')}\r\n`
        : '';
      socket.write(`CONNECT chat.mistral.ai:443 HTTP/1.1\r\nHost: chat.mistral.ai:443\r\n${auth}\r\n`);
    });
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('latin1');
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      socket.off('data', onData);
      socket.setTimeout(0);
      if (!/^HTTP\/1\.[01] 200/.test(buf)) { socket.destroy(); reject(new Error('代理 CONNECT 失败: ' + buf.split('\r\n')[0])); return; }
      const tlsSock = tls.connect({ socket, servername: 'chat.mistral.ai', ALPNProtocols: ['h2'] });
      tlsSock.once('error', (e) => reject(new Error('TLS 握手失败: ' + e.message)));
      tlsSock.once('secureConnect', () => {
        try {
          const session = connect('https://chat.mistral.ai', {
            protocol: 'https:',
            createConnection: () => tlsSock,
          });
          resolve(session);
        } catch (e) { reject(e); }
      });
    };
    socket.on('data', onData);
  });
}

export function loadCookie(configPath) {
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  const cookies = cfg.session?.cookies || {};
  return { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '), cfg };
}

/** 借道备用 IP：解析同族域名（CF 共享边缘），用它的 IP + SNI=chat.mistral.ai 连接。
 * 背景（实测 2026-11-25）：chat.mistral.ai 自己的路由会被网络在 TLS 阶段重置（本机为 Clash
 * fake-ip 分流，chat 域名被规则送进死路），而 auth/api 域名的路由是通的；借道后 TLS 内容不变、
 * 服务端按 SNI 路由，实测 200。 */
const ALT_ROUTE_HOSTS = ['auth.mistral.ai', 'api.mistral.ai'];
let altIpCache = null; // { host, ip, at } —— 5 分钟缓存
async function resolveAltIp() {
  if (altIpCache && Date.now() - altIpCache.at < 5 * 60_000) return altIpCache;
  for (const h of ALT_ROUTE_HOSTS) {
    try {
      const r = await dns.promises.lookup(h, { all: true });
      if (r?.[0]?.address) { altIpCache = { host: h, ip: r[0].address, at: Date.now() }; return altIpCache; }
    } catch { /* 试下一个 */ }
  }
  return null;
}
function connectAlt() {
  return new Promise(async (resolve, reject) => {
    const info = await resolveAltIp().catch(() => null);
    if (!info) return reject(new Error('无备用 IP 可用（同族域名解析失败）'));
    const socket = tls.connect({ host: info.ip, port: 443, servername: 'chat.mistral.ai', ALPNProtocols: ['h2'] });
    socket.setTimeout(15000, () => { try { socket.destroy(); } catch {} reject(new Error(`借道 ${info.host} TLS 超时`)); });
    socket.once('error', (e) => reject(new Error(`借道 ${info.host} TLS 失败: ` + e.message.slice(0, 80))));
    socket.once('secureConnect', () => {
      try { resolve(connect('https://chat.mistral.ai', { protocol: 'https:', createConnection: () => socket })); }
      catch (e) { reject(e); }
    });
  });
}

async function connectRoute(route, proxy) {
  if (route === 'alt') return connectAlt();
  if (route === 'proxy') return connectH2(proxy);
  return connect('https://chat.mistral.ai', { protocol: 'https:' });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 路由策略粘性: direct(或配置的 proxy) → alt → 其它；连接层失败(无响应字节)自动换路重试 */
let preferredRoute = null;
function routeOrder(proxy) {
  const pref = preferredRoute || (proxy ? 'proxy' : 'direct');
  const all = ['direct', 'alt', ...(proxy ? ['proxy'] : [])];
  return [pref, ...all.filter((r) => r !== pref)];
}

function request(cookie, opts) {
  detectClientProfile();
  const proxy = detectProxy();
  const onChunk = opts?.onChunk || null;
  let gotData = false;   // 响应一旦开始出字节就不能换路重试（防流式重复副作用）
  const wrapped = { ...opts, onChunk: onChunk ? ((c) => { gotData = true; onChunk(c); }) : null };
  return (async () => {
    let last = { status: -1, headers: {}, text: '无可用路由' };
    for (const route of routeOrder(proxy)) {
      for (let attempt = 0; attempt < 2; attempt++) {   // 每条路最多 2 次（瞬时抖动）
        let client;
        try { client = await connectRoute(route, proxy); }
        catch (e) { last = { status: -1, headers: {}, text: '出口连接失败: ' + (e?.message || e) }; await sleep(400 * (attempt + 1)); continue; }
        const r = await requestOn(client, cookie, wrapped);
        const connErr = r.status === -1 || r.status === -2 || r.status === 0;
        // 连接层失败且还没吐过响应字节 → 换路重试；已经开始出字节的失败原样上抛（调用方能感知半截流）
        if (connErr && !gotData) {
          last = r;
          if (route === 'alt') altIpCache = null;   // 借道失败则重解析（含换下一个同族域名）
          await sleep(400 * (attempt + 1));
          continue;
        }
        if (connErr && gotData) return r;
        if (preferredRoute !== route) {
          preferredRoute = route;
          console.log(`[路由] chat.mistral.ai 改走 ${route === 'alt' ? `借道 ${altIpCache?.host || '备用IP'}` : route} 出口`);
        } else preferredRoute = route;
        return r;
      }
    }
    return last;
  })();
}

function requestOn(client, cookie, { path, method = 'GET', body = null, maxRead = 4 * 1024 * 1024, onChunk = null }) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { try { client.close(); } catch {} resolve({ status: -2, headers: {}, text: 'timeout' }); }, 180000);
    client.on('error', (e) => { clearTimeout(timer); try { client.close(); } catch {} resolve({ status: -1, headers: {}, text: e.message }); });
    const officialStyleHeaders = {
      ...(path.startsWith('/api/trpc') ? {
        'x-trpc-source': 'nextjs-react',
        'x-le-chat-inactive-message-content': 'on-demand',
      } : {}),
      'sec-ch-ua': SEC_CH_UA,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      ...(body ? {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        origin: 'https://chat.mistral.ai',
      } : {}),
      accept: '*/*',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      referer: 'https://chat.mistral.ai/work',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'user-agent': currentUA(),
      cookie,
    };
    const req = client.request({
      ':path': path, ':method': method, ':authority': 'chat.mistral.ai', ':scheme': 'https',
      ...officialStyleHeaders,
    });
    let status = 0, headers = {}, text = '';
    req.on('response', (h) => { status = h[':status']; headers = h; });
    req.on('data', (c) => {
      if (onChunk) onChunk(c);
      text += c;
      if (text.length > maxRead) { try { req.close(); } catch {} }
    });
    const done = () => { clearTimeout(timer); try { client.close(); } catch {} resolve({ status, headers, text }); };
    req.on('end', done);
    req.on('close', done);
    req.on('error', (e) => { clearTimeout(timer); try { client.close(); } catch {} resolve({ status: -1, headers: {}, text: e.message }); });
    req.end(body ?? undefined);
  });
}

/**
 * 兼容解析 tRPC 批响应：老格式 JSON 数组 [{"result":...}]；trpc-accept: application/jsonl 后
 * 变成逐行 JSONL（行可能带批索引包装 {"0":{"result":...}} 或直接 {"result":...}）。
 * 返回扁平化 item 数组（每项 {result}|{error} 形态）。
 */
export function parseBatchResponse(text) {
  const s = String(text || '').trim();
  if (!s) return [];
  const normalize = (items) => {
    const out = [];
    for (const it of items) {
      // {"0":{...}} 批索引包装展平
      if (it && typeof it === 'object' && !('result' in it) && !('error' in it)) {
        const keys = Object.keys(it).filter((k) => /^\d+$/.test(k));
        if (keys.length && keys.length === Object.keys(it).length) {
          for (const k of keys) out.push(it[k]);
          continue;
        }
      }
      out.push(it);
    }
    return out;
  };
  if (s.startsWith('[')) {
    try { const j = JSON.parse(s); return normalize(Array.isArray(j) ? j : [j]); } catch { /* 落到逐行解析 */ }
  }
  const items = [];
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { items.push(JSON.parse(t)); } catch { /* 半行/keepalive 忽略 */ }
  }
  return normalize(items);
}

// 把 HTTP 响应转成带 status/retryAfter 的错误
function httpError(prefix, r) {
  const cfChallenged = r.status === 403 && /Just a moment|cf-chl|cloudflare/i.test(r.text || '');
  const err = new Error(cfChallenged
    ? `${prefix}: 出口 IP 被 Cloudflare 挑战（IP 风控）。建议：等 10-30 分钟再试，或用 --proxy http://127.0.0.1:7897 换出口 IP`
    : `${prefix} HTTP ${r.status}: ${r.text.slice(0, 300)}`);
  err.status = r.status;
  err.retryAfter = parseInt(r.headers?.['retry-after'] || '0', 10) || 0;
  err.rateLimited = r.status === 429;
  err.cfChallenged = cfChallenged;
  return err;
}

// ---------- 1) 建会话（携带首条消息） ----------
export async function newChat(cookie, text, productType = 'work') {
  const json = { content: [{ type: 'text', text }], files: [], productType };
  const r = await request(cookie, {
    path: '/api/trpc/message.newChat?batch=1', method: 'POST',
    body: JSON.stringify({ 0: { json } }),
  });
  if (r.status !== 200) throw httpError('newChat', r);
  const j = parseBatchResponse(r.text);
  const err = j?.[0]?.error;
  if (err) throw new Error(`newChat 业务错误: ${err.json?.message}`);
  const data = j?.[0]?.result?.data?.json;
  const chatId = data?.chatId || data?.id || data?.chat?.id;
  const userMessageId = data?.messages?.id;
  if (!chatId) throw new Error(`newChat 无 chatId: ${r.text.slice(0, 300)}`);
  return { chatId, userMessageId, raw: data };
}

// ---------- 2) 发消息（start=首轮 / append=续轮） ----------
export async function sendChat(cookie, { chatId, messageId = null, messageInput, mode = 'start', productType = 'work', onDelta = null }) {
  const today = new Date().toISOString().slice(0, 10);
  const body = {
    mode, chatId,
    // append/edit: messageId = 新 user 消息 id（客户端生成 UUID）
    ...(mode === 'append' || mode === 'edit' ? { messageId: messageId || randomUUID() } : {}),
    messageInput,
    productType,
    clientPromptData: { currentDate: today, userTimezone: 'Asia/Shanghai' },
    disabledFeatures: [],
    stableAnonymousIdentifier: randomUUID(),
    supportedTaskCallbacks: [],
  };
  let acc = '';
  const r = await request(cookie, {
    path: '/api/chat', method: 'POST', body: JSON.stringify(body),
    onChunk: (c) => {
      acc += c.toString('utf8');
      // 增量解析完整行
      let idx;
      while ((idx = acc.indexOf('\n')) >= 0) {
        const line = acc.slice(0, idx);
        acc = acc.slice(idx + 1);
        const ev = parseStreamLine(line);
        if (ev && onDelta) onDelta(ev);
      }
    },
  });
  if (r.status !== 200) throw httpError('sendChat', r);
  return r;
}

// 解析 "15:{json}" 行 → 事件对象
export function parseStreamLine(line) {
  if (!line) return null;
  const i = line.indexOf(':');
  if (i < 0) return null;
  const len = parseInt(line.slice(0, i), 10);
  if (Number.isNaN(len)) return null;
  const payload = line.slice(i + 1);
  if (payload === 'null') return { type: 'end' };
  try {
    const o = JSON.parse(payload);
    // tRPC 包装: {json: {...}, meta: {...}}
    if (o && typeof o === 'object' && 'json' in o) return o.json;
    return o;
  } catch { return null; }
}

// 把事件流折叠成最终状态（应用 JSON-Patch 到 message/chat 对象）
export function foldStream(events) {
  const msgs = new Map();   // messageId -> 对象
  const chat = {};
  let finished = false;
  const applyPatch = (obj, patches) => {
    for (const p of patches || []) {
      if (p.op === 'replace' || p.op === 'add') {
        const path = p.path.replace(/^\//, '');
        if (!path) { Object.assign(obj, p.value); continue; }
        const parts = path.split('/');
        let cur = obj;
        for (let k = 0; k < parts.length - 1; k++) {
          const key = /^\d+$/.test(parts[k]) ? Number(parts[k]) : parts[k];
          if (cur[key] == null) cur[key] = /^\d+$/.test(parts[k + 1]) ? [] : {};
          cur = cur[key];
        }
        const last = /^\d+$/.test(parts[parts.length - 1]) ? Number(parts[parts.length - 1]) : parts[parts.length - 1];
        if (Array.isArray(cur) && last === cur.length) cur.push(p.value);
        else cur[last] = p.value;
      } else if (p.op === 'append') {
        // 文本流式增量: {op:'append', path:'/contentChunks/N/text', value:'片段'}（字符串拼接；数组则 push）
        const path = p.path.replace(/^\//, '');
        const parts = path ? path.split('/') : [];
        if (!parts.length) continue;
        let cur = obj;
        for (let k = 0; k < parts.length - 1; k++) {
          const key = /^\d+$/.test(parts[k]) ? Number(parts[k]) : parts[k];
          cur = cur?.[key];
        }
        const last = /^\d+$/.test(parts[parts.length - 1]) ? Number(parts[parts.length - 1]) : parts[parts.length - 1];
        if (typeof cur?.[last] === 'string' && typeof p.value === 'string') cur[last] += p.value;
        else if (Array.isArray(cur)) cur.push(p.value);
      } else if (p.op === 'remove') {
        const path = p.path.replace(/^\//, '');
        const parts = path.split('/');
        let cur = obj;
        for (let k = 0; k < parts.length - 1; k++) {
          const key = /^\d+$/.test(parts[k]) ? Number(parts[k]) : parts[k];
          cur = cur?.[key];
        }
        if (Array.isArray(cur)) cur.splice(Number(parts[parts.length - 1]), 1);
        else if (cur) delete cur[parts[parts.length - 1]];
      }
    }
  };
  for (const ev of events) {
    if (!ev) continue;
    if (ev.type === 'end') { finished = true; continue; }
    if (ev.type === 'message') {
      let m = msgs.get(ev.messageId);
      if (!m) { m = {}; msgs.set(ev.messageId, m); }
      applyPatch(m, ev.patches);
    } else if (ev.type === 'chat') {
      applyPatch(chat, ev.patches);
    }
  }
  // 找 assistant 最终消息
  let assistant = null, user = null;
  for (const m of msgs.values()) {
    if (m.role === 'assistant') assistant = m;
    if (m.role === 'user') user = m;
  }
  // contentChunks 中只取纯文本（过滤 reasoning 的 _context）
  const extractText = (m) => {
    if (!m) return '';
    if (typeof m.content === 'string' && m.content) return m.content;
    if (Array.isArray(m.contentChunks)) {
      return m.contentChunks.filter((c) => c && c.type === 'text' && !c._context).map((c) => c.text || c.content || '').join('');
    }
    return '';
  };
  return {
    finished,
    assistantText: extractText(assistant),
    assistantMessage: assistant,
    userMessage: user,
    userMessageId: user?.id,
    assistantMessageId: assistant?.id,
    chat,
    allMessages: [...msgs.values()],
  };
}

// 便捷封装：完整一轮（返回纯文本 + 状态）
export async function chatTurn(cookie, opts) {
  const events = [];
  await sendChat(cookie, { ...opts, onDelta: (e) => events.push(e) });
  return foldStream(events);
}

// ---------- 通用 tRPC query（GET, batch=1；供额度/用量查询等只读端点复用） ----------
// 返回解析后的业务数据（自动解开 {"result":{"data":{"json":...}}} 包装）；业务错误抛 Error（带 httpStatus）
export async function trpcQuery(cookie, proc, input = null, { timeoutMs = 30000 } = {}) {
  const qs = `?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { json: input } }))}`;
  const r = await request(cookie, { path: `/api/trpc/${proc}${qs}` });
  if (r.status !== 200) throw httpError(`trpc ${proc}`, r);
  const j = parseBatchResponse(r.text);
  const item = j.length ? j[0] : null;
  const err = item?.error;
  if (err) {
    const e = new Error(`trpc ${proc} 业务错误: ${err.json?.message || err.message || r.text.slice(0, 200)}`);
    e.status = err.json?.data?.httpStatus || r.status;
    e.rateLimited = r.status === 429 || e.status === 429;
    e.retryAfter = parseInt(r.headers?.['retry-after'] || '0', 10) || 0;
    throw e;
  }
  return item?.result?.data?.json;
}
