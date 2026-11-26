// 肥猫猫邮箱服务（https://zjkdongao.cn/）——创建临时邮箱、拉取邮件、提取验证码
//
// 两种接入模式（自动选择）：
//  A. Token 池模式（推荐）: `feimao_tokens.txt` 里每行一个站点登录态 token（# 开头为注释）。
//     请求带 `Authorization: Bearer <token>` + `X-Client-Type: web`，用账号态接口在本人账号上生成邮箱
//     （不受游客每访客/每 IP 每天 5 个临时邮箱的限制）。多 token 轮询：
//       - 每次创建轮转到下一个健康 token；
//       - 401/403 记为失效、429/配额耗尽记为冷却，自动换下一个；
//       - 状态落盘 feimao_tokens_state.json（GUI 展示用）。
//  B. 游客模式（兜底）: 无 token 或 token 全部不可用时走原游客流程（X-Guest-Visitor-Id，每天 5 个）。
//
// 游客流程（抓包验证，2026-11）：
//   1. 创建邮箱（游客）：POST /mail-api/v1/mailboxes/temp   header X-Guest-Visitor-Id: <64hex>
//        -> { code: 0, data: { id, email, claim_token, expires_at, daily_limit, used_today, remaining_requests_today } }
//   2. 列出邮件：GET /mail-api/v1/mailboxes/temp/<id>/emails   header X-Guest-Mailbox-Token: <claim_token>
// 账号态接口（从站点前端 bundle 逆向，2026-11-26）：
//   - 鉴权: Authorization: Bearer <token>；GET /mail-api/v1/mailboxes/ 需登录（401 {"code":1,"message":"未登录"}）
//   - 创建邮箱账号: POST /mail-api/v1/mailboxes/（body {}）
//   - 生成系统域名邮箱（备选）: POST /mail-api/v1/mailboxes/system/custom-generate
//   - 收信端点按优先级尝试: /mailboxes/<id>/emails -> /emails/?mailbox_id= -> /emails/?mailbox_email=
//   - 游客额度查询: GET /mail-api/v1/mailboxes/temp/quota（X-Guest-Visitor-Id + X-Guest-Mailbox-Tokens）
//
// 自检: node mistral_mailbox.mjs --selftest [--create]
//   --selftest  打印游客额度与每个 token 的可用性（GET /mailboxes/）
//   --create    额外用第一个健康 token 创建一个邮箱并拉取一次邮件列表（会消耗该账号 1 个邮箱配额）
import { readFileSync, writeFileSync } from 'fs';
import { createHash } from 'node:crypto';

const BASE = 'https://zjkdongao.cn';
const API = BASE + '/mail-api/v1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0';
const FETCH_TIMEOUT_MS = 60000;
const TOKENS_FILE = 'feimao_tokens.txt';
const STATE_FILE = 'feimao_tokens_state.json';

// 游客访客 id（抓包中为 localStorage 的 guest_visitor_id_v1，浏览器端用 32 字节随机 hex）
const randomHex64 = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (r) => r.toString(16).padStart(2, '0')).join('');
const VISITOR_ID = randomHex64();

let tempMailbox = null; // 当前会话最近创建的 { id, email, token, mode, authToken? }

const short = (o, n = 300) => { const s = JSON.stringify(o); return s && s.length > n ? s.slice(0, n) + '…' : s; };
const maskToken = (t) => (t && t.length > 12 ? `${t.slice(0, 6)}…${t.slice(-4)}` : String(t || '').slice(0, 4) + '…');

/* ---------------- token 池（文件热更新 + 轮询/失效切换） ---------------- */

/** 读取 feimao_tokens.txt（# 注释、空行忽略、去重保序）；文件缺失返回 [] */
function loadTokens() {
  let raw = '';
  try { raw = readFileSync(TOKENS_FILE, 'utf8'); } catch { return []; }
  const out = [];
  const seen = new Set();
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// token -> { invalid, cooldownUntil, remaining, lastUsedAt, lastError }（进程内存 + 状态落盘）
const tokenStates = new Map();
const stateOf = (t) => tokenStates.get(t) || (tokenStates.set(t, { invalid: false, cooldownUntil: 0, remaining: null, lastUsedAt: 0, lastError: null }), tokenStates.get(t));
let rrCursor = 0;

/** 健康 token 轮转: 跳过失效/冷却中的 token，返回下一个可用 token（全不可用返回 null） */
function pickToken(tokens) {
  const now = Date.now();
  const healthy = tokens.filter((t) => {
    const s = stateOf(t);
    return !s.invalid && s.cooldownUntil <= now && (s.remaining == null || s.remaining > 0);
  });
  if (!healthy.length) return null;
  const t = healthy[rrCursor % healthy.length];
  rrCursor++;
  return t;
}

function markTokenBad(t, why, status) {
  const s = stateOf(t);
  s.lastError = why;
  const authFail = status === 401 || status === 403 || /401|403|未登录|无效|令牌|invalid|unauthorized/i.test(String(why));
  if (authFail) s.invalid = true;
  else s.cooldownUntil = Date.now() + 10 * 60 * 1000; // 其他错误冷却 10 分钟
}

function persistState() {
  try {
    const tokens = {};
    for (const [t, s] of tokenStates) {
      tokens[maskToken(t)] = { hash: createHash('sha1').update(t).digest('hex').slice(0, 12), invalid: !!s.invalid, cooldownUntil: s.cooldownUntil, remaining: s.remaining, lastUsedAt: s.lastUsedAt, lastError: s.lastError };
    }
    writeFileSync(STATE_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), tokens }, null, 2));
  } catch { /* 状态落盘失败不影响主流程 */ }
}

/* ---------------- HTTP 基础 ---------------- */

async function mbFetch(method, path, { body, headers = {}, auth } = {}) {
  const h = { accept: 'application/json', 'user-agent': UA, 'x-client-type': 'web', ...headers };
  if (auth) h.authorization = `Bearer ${auth}`;
  if (body !== undefined && body !== null) h['content-type'] = 'application/json';
  return fetch(path.startsWith('http') ? path : API + path, {
    method,
    headers: h,
    body: body === undefined || body === null ? undefined : String(body),
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

async function jsonOf(res) {
  try { return JSON.parse(await res.text()); } catch { return null; }
}

const apiError = (j) => (j && (j.message || j.detail || (j.error && (j.error.message || j.error)))) || '';

/* ---------------- 游客流程（兜底） ---------------- */

async function guestCreate(log) {
  try {
    const r = await mbFetch('POST', '/mailboxes/temp', { headers: { 'x-guest-visitor-id': VISITOR_ID } });
    const j = await jsonOf(r);
    const data = j && j.data;
    if (j && j.code === 0 && data && data.email) {
      log && log('MAIL', `肥猫猫[游客]: 已创建临时邮箱 ${data.email}` + (data.remaining_requests_today != null ? `（今日剩余 ${data.remaining_requests_today}/${data.daily_limit ?? '?'}）` : ''));
      return { id: data.id, email: data.email, token: data.claim_token || data.token || null, mode: 'guest' };
    }
    log && log('MAIL', `肥猫猫[游客]未返回邮箱: ${short(j)}`);
  } catch (e) {
    log && log('MAIL', `肥猫猫[游客]请求失败: ${e.message}`);
  }
  return null;
}

/** 游客额度（GET /mailboxes/temp/quota，不消耗创建配额） */
async function guestQuota() {
  try {
    const r = await mbFetch('GET', '/mailboxes/temp/quota', { headers: { 'x-guest-visitor-id': VISITOR_ID, 'x-guest-mailbox-tokens': '' } });
    const j = await jsonOf(r);
    const d = j && j.data;
    return d ? { dailyLimit: d.daily_limit ?? null, usedToday: d.used_today ?? null, remaining: d.remaining_requests_today ?? null } : null;
  } catch { return null; }
}

/* ---------------- 账号态（token 池） ---------------- */

/** 账号态创建邮箱: 依次尝试已知端点，成功返回 { id, email, mode:'token', authToken } */
async function tokenCreateOne(token, log) {
  const attempts = [
    { path: '/mailboxes/', body: '{}', label: 'POST /mailboxes/' },
    { path: '/mailboxes/system/custom-generate', body: '{}', label: 'POST /mailboxes/system/custom-generate' },
  ];
  for (const a of attempts) {
    let r;
    try { r = await mbFetch('POST', a.path, { body: a.body, auth: token }); }
    catch (e) { return { error: `request failed: ${e.message}` }; }
    const j = await jsonOf(r);
    const data = j && (j.data || j);
    const mb = data && (data.mailbox || data);
    const email = mb && (mb.email || mb.address || mb.email_address);
    if (r.ok && j && (j.code === 0 || j.code === undefined) && email) {
      return { id: mb.id ?? mb.mailbox_id ?? null, email, token: mb.claim_token || null, mode: 'token', authToken: token, endpoint: a.label, remaining: (data && data.remaining_requests_today) ?? null };
    }
    const msg = apiError(j) || `HTTP ${r.status}`;
    if (r.status === 401 || r.status === 403) return { error: msg, authError: true, status: r.status };
    if (r.status === 404 || r.status === 405) continue; // 端点不存在，换下一个变体
    return { error: msg, status: r.status };
  }
  return { error: '所有创建端点均不可用' };
}

/** token 模式创建（多 token 轮询，最多尝试 tokens.length 个不同 token） */
async function tokenCreate(log) {
  const tokens = loadTokens();
  if (!tokens.length) return null;
  const tried = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const token = pickToken(tokens.filter((t) => !tried.has(t)));
    if (!token) break;
    tried.add(token);
    const s = stateOf(token);
    const r = await tokenCreateOne(token, log);
    if (r.error) {
      // 仅鉴权失败才判 token 失效；429/5xx 冷却；400/422 属请求格式问题，不惩罚 token、放行尝试下一个
      markTokenBad(token, r.error, r.status);
      log && log('MAIL', `肥猫猫[token ${maskToken(token)}] 创建失败: ${r.error}，轮询下一个 token`);
      continue;
    }
    s.lastUsedAt = Date.now();
    s.lastError = null;
    if (r.remaining != null) s.remaining = r.remaining;
    persistState();
    log && log('MAIL', `肥猫猫[token ${maskToken(token)}]: 已创建邮箱 ${r.email}（${r.endpoint || ''}）`);
    return r;
  }
  persistState();
  log && log('MAIL', '肥猫猫: 全部 token 均不可用（失效/冷却/端点失败），回退游客流程');
  return null;
}

/* ---------------- 收信（自适应端点） ---------------- */

// token 模式收信候选端点（按顺序尝试，记住可用的那个）
const EMAIL_VARIANTS = [
  { path: (mb) => `/mailboxes/${mb.id}/emails`, label: 'GET /mailboxes/<id>/emails' },
  { path: (mb) => `/emails/?mailbox_id=${encodeURIComponent(mb.id)}`, label: 'GET /emails/?mailbox_id=' },
  { path: (mb) => `/emails/?mailbox_email=${encodeURIComponent(mb.email)}`, label: 'GET /emails/?mailbox_email=' },
];
let emailVariantIdx = 0;

function emailsOf(j) {
  const d = j && (j.data || j);
  if (!d) return [];
  if (Array.isArray(d.emails)) return d.emails;
  if (Array.isArray(d.items)) return d.items;
  if (Array.isArray(d.list)) return d.list;
  if (Array.isArray(d.data)) return d.data;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d.emails && d.emails.items)) return d.emails.items;
  return [];
}

async function listEmails(mb) {
  if (!mb) return [];
  if (mb.mode === 'token') {
    for (let i = 0; i < EMAIL_VARIANTS.length; i++) {
      const idx = (emailVariantIdx + i) % EMAIL_VARIANTS.length;
      const v = EMAIL_VARIANTS[idx];
      let r;
      try { r = await mbFetch('GET', v.path(mb), { auth: mb.authToken }); }
      catch { continue; }
      const j = await jsonOf(r);
      if (r.ok && j && (j.code === 0 || j.code === undefined)) {
        if (idx !== emailVariantIdx) { emailVariantIdx = idx; }
        return emailsOf(j);
      }
      if (r.status === 401 || r.status === 403) { markTokenBad(mb.authToken, `收信 ${r.status}`); return []; }
      // 404/405 等: 换下一个变体
    }
    return [];
  }
  // 游客模式
  const r = await mbFetch('GET', `/mailboxes/temp/${mb.id}/emails`, { headers: mb.token ? { 'x-guest-mailbox-token': mb.token } : {} });
  const j = await jsonOf(r);
  return (j && j.code === 0 && j.data && Array.isArray(j.data.emails)) ? j.data.emails : [];
}

/* ---------------- 对外接口 ---------------- */

/** 创建邮箱（token 池优先轮询；全不可用回退游客）。返回 { id, email, token, mode, authToken? } 或 null */
export async function createMailbox(log) {
  const created = (await tokenCreate(log)) || (await guestCreate(log));
  tempMailbox = created || null;
  return tempMailbox;
}

// 从邮件 HTML 提取验证码（"code xxxxxx"/"验证码 xxxxxx" 等模式优先，兜底取第一个 6 位数字）
function extractCodeFromHtml(html) {
  if (!html) return null;
  const text = String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const pick = (re) => { const m = text.match(re); return m ? m[1] : null; };
  return pick(/code[^0-9]{0,20}(\d{6})/i)
    || pick(/验证码[^0-9]{0,20}(\d{6})/)
    || pick(/短信验证码[^0-9]{0,20}(\d{6})/)
    || pick(/verification code[^0-9]{0,20}(\d{6})/i)
    || (text.match(/\d{6}/g) || [])[0] || null;
}

// 获取邮件验证码：列表字段名（verification_code）或兜底抽取
async function emailCode(e) {
  if (e.verification_code) return e.verification_code;
  if (e.verificationCode) return e.verificationCode;
  const html = e.content_html || e.contentHtml || e.content_text || e.content || '';
  return extractCodeFromHtml(html);
}

/** 邮件接收时间（毫秒）：优先 received_at_ms，其次 received_at/created_at 等 ISO/秒级字段 */
const receivedAtMs = (e) => {
  if (e.received_at_ms) return Number(e.received_at_ms) || 0;
  for (const k of ['received_at', 'created_at', 'sent_at', 'date']) {
    const v = e[k];
    if (!v) continue;
    if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
};

// 当前邮箱里最新一封邮件的 received_at_ms（用于重新发码后只认更新的邮件）
export async function latestMailReceivedAt(mailbox) {
  const mb = mailbox || tempMailbox;
  if (!mb) return 0;
  try {
    const emails = await listEmails(mb);
    return emails.reduce((max, e) => Math.max(max, receivedAtMs(e)), 0);
  } catch { return 0; }
}

// 轮询临时邮箱，返回所有新验证码（最新邮件优先）。
// 注册和"重新发码"会各发一封，两个验证码可能同时存在；调用方应逐个尝试。
export async function waitForVerificationCodes({ mailbox, timeoutMs = 60000, afterReceivedAtMs = 0, log } = {}) {
  const mb = mailbox || tempMailbox;
  if (!mb) return [];
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const emails = await listEmails(mb);
      const scored = emails
        .filter((e) => !e.is_spam && /mistral/i.test(e.from_addr || e.from || e.sender || ''))
        .filter((e) => !afterReceivedAtMs || receivedAtMs(e) > afterReceivedAtMs)
        .sort((a, b) => receivedAtMs(b) - receivedAtMs(a)); // 最新邮件优先
      const codes = [];
      for (const e of scored) {
        const code = await emailCode(e);
        if (code && !codes.includes(code)) {
          log && log('MAIL', `自动获取验证码: ${code}（${e.from_addr || e.from || ''} — ${e.subject || ''}）`);
          codes.push(code);
        }
      }
      if (codes.length) return codes;
    } catch (e) {
      log && log('MAIL', `拉取邮件失败: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  return [];
}

export async function waitForVerificationCode(opts = {}) {
  const codes = await waitForVerificationCodes(opts);
  return codes[0] || null;
}

/** GUI / 自检用: token 池与游客额度快照（不创建邮箱、不消耗配额） */
export async function mailboxStatus() {
  const tokens = loadTokens();
  const list = tokens.map((t) => {
    const s = stateOf(t);
    return { token: maskToken(t), invalid: !!s.invalid, cooldownUntil: s.cooldownUntil, remaining: s.remaining, lastUsedAt: s.lastUsedAt, lastError: s.lastError };
  });
  // 廉价快照（不访问网络，避免 GUI 轮询打爆上游）；token 校验请用 CLI 自检 --selftest
  let guest = null;
  if (!tokens.length) guest = await guestQuota();
  persistState();
  return { tokens: list, guest };
}

/* ---------------- CLI 自检 ---------------- */

async function selftest({ create = false } = {}) {
  const tokens = loadTokens();
  const out = { tokens: tokens.length, results: [] };
  console.log(`== 肥猫猫自检 ==  配置文件: ${TOKENS_FILE}（${tokens.length} 个 token）`);
  console.log('== 游客额度 ==', JSON.stringify(await guestQuota()));
  for (const t of tokens) {
    let r;
    try { r = await mbFetch('GET', '/mailboxes/?page=1&page_size=1', { auth: t }); }
    catch (e) { out.results.push({ token: maskToken(t), ok: false, error: e.message }); console.log(` - token ${maskToken(t)}: 请求失败 ${e.message}`); continue; }
    const j = await jsonOf(r);
    const ok = r.ok && j && j.code === 0;
    const s = stateOf(t);
    if (ok) { s.invalid = false; s.lastError = null; }
    else { markTokenBad(t, apiError(j) || `HTTP ${r.status}`, r.status); }
    const total = j && j.data && (j.data.total ?? (Array.isArray(j.data.items) ? j.data.items.length : undefined));
    const rec = { token: maskToken(t), ok, status: r.status, message: ok ? '可用' : (apiError(j) || `HTTP ${r.status}`), total };
    out.results.push(rec);
    console.log(` - token ${maskToken(t)}: ${ok ? '✅ 可用' : '❌ ' + rec.message}${total != null ? `（邮箱总数 ${total}）` : ''}`);
  }
  if (create) {
    const mb = await tokenCreate((tag, msg) => console.log(`[${tag}] ${msg}`));
    console.log('== 创建邮箱 ==', JSON.stringify(mb));
    if (mb) {
      const emails = await listEmails(mb);
      console.log('== 邮件列表 ==', JSON.stringify({ variant: EMAIL_VARIANTS[emailVariantIdx].label, count: emails.length, first: emails[0] ? { from: emails[0].from_addr || emails[0].from, subject: emails[0].subject } : null }));
    }
  }
  persistState();
  console.log('== 状态文件 ==', STATE_FILE);
  return out;
}

// 直接运行: node mistral_mailbox.mjs --selftest [--create]
if (process.argv[1] && /mistral_mailbox\.mjs$/.test(process.argv[1].replace(/\\/g, '/'))) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest') || argv.includes('--create')) {
    selftest({ create: argv.includes('--create') })
      .then(() => process.exit(0))
      .catch((e) => { console.error('自检失败:', e); process.exit(1); });
  } else {
    console.log('用法: node mistral_mailbox.mjs --selftest [--create]');
    console.log(`token 文件: ${TOKENS_FILE}（每行一个肥猫猫站点登录 token，# 开头为注释）`);
  }
}
