#!/usr/bin/env node
// reverse_proxy.mjs — Mistral Le Chat 对话反代（OpenAI 兼容本地 API，纯协议无浏览器）
//
// 启动: node reverse_proxy.mjs --config test_pipe_config.json [--port 8787]
// 端点:
//   POST /v1/chat/completions   （支持 stream:true/false，多轮会话自动保持；tools 函数调用兼容）
//   GET  /v1/models
//   GET  /health
//   GET  /admin/pool            账号池状态（GUI「用看板」页轮询）
//   POST /admin/reload          手动重读 accounts.json / 配置，热更新账号池
//   GET  /admin/usage           token 用量统计（GUI「用量看板」页展示；落盘 usage_stats.json）
//
// API key 鉴权（/v1/* 必须带；/admin/* 仅限本机回环访问，或带 key）:
//   --api-key <key>             启动参数指定（优先，热更新不覆盖）
//   proxy_key.txt               未指定 --api-key 时读此文件（GUI 自定义保存），mtime 热更新
//   未设置 key 时 /v1/* 不校验（仅限本机 127.0.0.1 使用时的旧行为）
//   客户端传法: Authorization: Bearer <key> 或 x-api-key: <key> 或 ?key=<query>
//
// 账号池热更新: 每 2.5s 轮询 accounts.json / 配置文件 mtime，批量注册完成入池后
// 无需重启反代，新账号自动进入调度池（GUI 也会在任务完成时主动 POST /admin/reload）。
// 调度策略: Pro 账号优先轮换（round-robin 游标），Pro 全部限速冷却或池内无 Pro 时才
// 轮转 Free 账号；已绑定会话的账号未冷却时保持粘性优先，429 迁移换号也按此策略选。
//
// 客户端示例（OpenAI SDK）:
//   const c = new OpenAI({ baseURL: 'http://127.0.0.1:8787/v1', apiKey: 'x' });
//   await c.chat.completions.create({ model: 'mistral-large', messages: [...] });
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync, unlinkSync, mkdirSync, readdirSync, constants as fsConstants } from 'fs';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { newChat, sendChat, foldStream, setClientProfile, getClientProfile } from './mistral_chat_api.mjs';

// ---------- 参数 ----------
const argv = process.argv.slice(2);
function argOf(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const CONFIG = argOf('--config', 'test_pipe_config.json');
const API_KEY_ARG = argOf('--api-key', null);
const PORT = parseInt(argOf('--port', '8899'), 10);
const HOST = argOf('--host', '127.0.0.1');
const ACCOUNTS_FILE = argOf('--accounts', 'accounts.json');
const PRO_ONLY = argv.includes('--pro-only');

// ---------- 账号池（Pro 优先轮换、Free 兜底，429 自动切换；accounts.json 变更自动热更新） ----------
function cookieOf(cfg) {
  const cookies = cfg?.session?.cookies || {};
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}
const pool = []; // { email, cookie, blockedUntil, pro }
let allAccounts = {};
let warnedNoAccounts = false;
let warnedNoConfig = false;

/** 重建账号池：配置账号 + accounts.json 全量（--pro-only 只收 Pro）。同 cookie 保留冷却状态并刷新 pro 标记，供启动与热更新共用 */
function reloadPool(reason) {
  let accounts = {};
  if (existsSync(ACCOUNTS_FILE)) {
    try { accounts = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8')); }
    catch (e) { console.log(`[警告] 读取 ${ACCOUNTS_FILE} 失败: ${e.message}`); return pool.length; }
  } else if (!warnedNoAccounts) {
    warnedNoAccounts = true;
    console.log(`[账号库] 未找到 ${ACCOUNTS_FILE}：仓库不附带账号数据，注册成功后会自动生成`);
  }
  allAccounts = accounts;

  const entries = []; // [email, cookie, pro]
  try {
    if (!existsSync(CONFIG)) { const e = new Error(`ENOENT: no such file or directory, open '${CONFIG}'`); e.code = 'ENOENT'; throw e; }
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    const cfgEmail = cfg.email || cfg.session?.user?.email || CONFIG.replace(/\.json$/i, '');
    // 配置账号的 pro 状态同样以 accounts.json 为准（不在库里视为 Free）
    const cfgPro = allAccounts[cfgEmail]?.pro === true;
    if (!PRO_ONLY || cfgPro) entries.push([cfgEmail, cookieOf(cfg), cfgPro]);
    else console.log(`[池] --pro-only：配置账号 ${cfgEmail} 非 Pro/未检测，已跳过`);
  } catch (e) {
    if (e.code === 'ENOENT' || /ENOENT/.test(String(e.message))) {
      if (!warnedNoConfig) {
        warnedNoConfig = true;
        console.log(`[配置] 未找到 ${CONFIG}（配置文件含会话 cookie，不随仓库分发）：本次仅使用 ${ACCOUNTS_FILE} 里的账号；需要它可在 GUI「批量注册 → 配置编辑」新建，或用 --config 指定文件`);
      }
    } else {
      console.log(`[配置] ${CONFIG} 解析失败: ${e.message}（已跳过该配置文件）`);
    }
  }
  let proSkipped = 0;
  for (const [email, acc] of Object.entries(allAccounts)) {
    const pro = acc?.pro === true;
    if (PRO_ONLY && !pro) { proSkipped++; continue; }
    entries.push([email, cookieOf(acc), pro]);
  }

  const prev = new Map(pool.map((a) => [a.cookie, a]));
  const next = [];
  const seen = new Set();
  for (const [email, cookie, pro] of entries) {
    if (!cookie || seen.has(cookie)) continue;
    seen.add(cookie);
    const old = prev.get(cookie);
    // 热更新同 cookie：保留 blockedUntil，刷新 email / pro（pro 变化即时生效）
    next.push(old
      ? Object.assign(old, { email: email || old.email, pro })
      : { email: email || `acct${next.length + 1}`, cookie, blockedUntil: 0, pro });
  }
  const added = next.filter((a) => !prev.has(a.cookie)).length;
  const removed = pool.length + added - next.length;
  // 被移除账号的存量会话仍持有其 cookie 引用，可正常完成当次请求，429 时按既有逻辑迁移
  pool.length = 0;
  pool.push(...next);
  if (added || removed) {
    const proN = next.filter((a) => a.pro === true).length;
    console.log(`[池] ${reason}: 新增 ${added} / 移除 ${removed}，当前 ${pool.length} 个`
      + `（Pro ${proN} / Free ${pool.length - proN}，调度: Pro 优先轮换，Free 兜底）`
      + (PRO_ONLY ? `；--pro-only 跳过 ${proSkipped} 个非 Pro/未检测账号` : ''));
  }
  return pool.length;
}
reloadPool('启动');
if (!pool.length) {
  console.log(`[错误] 账号池为空：${ACCOUNTS_FILE} 与 ${CONFIG} 里都没有带 session cookie 的账号。`);
  console.log('       请先在 GUI 完成注册（或放置 accounts.json / 用 --config 指定已有配置），再重启反代。');
  process.exit(1);
}

// mtime 轮询：注册完成入池后自动热更新账号池，无需重启反代（GUI 任务完成时还会主动 POST /admin/reload）
const mtimeOf = (f) => { try { return existsSync(f) ? statSync(f).mtimeMs : 0; } catch { return 0; } };
let poolMtime = Math.max(mtimeOf(ACCOUNTS_FILE), mtimeOf(CONFIG));

// ---------- API key（自定义鉴权：--api-key 或 proxy_key.txt，热更新） ----------
const KEY_FILE = 'proxy_key.txt';
let apiKey = API_KEY_ARG;   // --api-key 优先；否则跟随 proxy_key.txt 文件热更新
function loadKeyFile() {
  try { return readFileSync(KEY_FILE, 'utf8').trim() || null; } catch { return null; }
}
function refreshKey(reason) {
  if (API_KEY_ARG) return apiKey;          // 显式 --api-key 指定时不读文件
  const k = loadKeyFile();
  if (k !== apiKey) { apiKey = k; console.log(`[ApiKey] ${reason}: ${apiKey ? '已生效（proxy_key.txt）' : '未设置（/v1/* 不校验）'}`); }
  return apiKey;
}
if (!API_KEY_ARG) apiKey = loadKeyFile();

if (!API_KEY_ARG) apiKey = loadKeyFile();

// ---------- 客户端形态热切换（client_profile.txt: 'desktop' 时 UA 带 LeChat-Desktop/1.6.0 标记） ----------
const PROFILE_FILE = 'client_profile.txt';
function refreshProfile(reason) {
  let p = 'web';
  try { p = readFileSync(PROFILE_FILE, 'utf8').trim() === 'desktop' ? 'desktop' : 'web'; } catch { /* 文件不存在=web */ }
  setClientProfile(p);
  if (reason && reason !== '启动') console.log(`[客户端形态] ${reason}: ${p === 'desktop' ? 'UA 带 LeChat-Desktop 标记' : 'UA 为 web 形态'}`);
}

// 账号池 + API key + 客户端形态 一起做 mtime 轮询
setInterval(() => {
  const m = Math.max(mtimeOf(ACCOUNTS_FILE), mtimeOf(CONFIG), mtimeOf(KEY_FILE), mtimeOf(PROFILE_FILE));
  if (m && m !== poolMtime) {
    const keyChanged = mtimeOf(KEY_FILE) > poolMtime;
    const profileChanged = mtimeOf(PROFILE_FILE) > poolMtime;
    poolMtime = m;
    reloadPool('账号库变更');
    if (keyChanged) refreshKey('文件变更');
    if (profileChanged) refreshProfile('文件变更');
  }
}, 2500).unref();
refreshProfile('启动');

/** 校验请求的 key：Authorization: Bearer / x-api-key / ?key= 三种任一匹配 */
function authOk(req, url) {
  if (!apiKey) return true;
  const auth = req.headers.authorization || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
  const provided = bearer || String(req.headers['x-api-key'] || '').trim() || url.searchParams.get('key') || '';
  return !!provided && provided === apiKey;
}
const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress);
function authFail(res) {
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'API key 缺失或不正确。请在 Authorization: Bearer <key> / x-api-key 头里带上「用量看板」中保存的 key', type: 'invalid_api_key' } }));
}

// 取一个可用账号: 会话绑定账号粘性优先；否则 Pro 优先轮转（round-robin），Free 兜底
let rrCursor = 0; // 轮转游标: 每次选号后前移一格，避免永远压在第一个账号上
function pickAccount(prefer) {
  const now = Date.now();
  if (prefer && prefer.blockedUntil <= now) return prefer;
  for (const wantPro of [true, false]) { // 先在未冷却的 Pro 里轮转，Pro 全冷却/无 Pro 再轮转 Free
    const group = pool.filter((a) => a.pro === wantPro && a.blockedUntil <= now);
    if (!group.length) continue;
    const acc = group[rrCursor % group.length];
    rrCursor++;
    return acc;
  }
  return null;
}
function blockAccount(acc, retryAfter) {
  const secs = retryAfter > 0 ? retryAfter : 3600;
  acc.blockedUntil = Date.now() + secs * 1000;
  console.log(`[限速] 账号 ${acc.email} 被限速，${secs}s 后恢复（切换下一账号）`);
}
function blockedCount() { return pool.filter((a) => a.blockedUntil > Date.now()).length; }

// ---------- token 用量统计 ----------
// 说明：上游 /api/chat 事件流不回传 token 用量（实测 message 补丁无 usage 字段），
// 这里按字符数估算（≈ chars/4），响应里以 usage_estimated 标注；请求级明细落盘 usage_stats.json。
const USAGE_FILE = 'usage_stats.json';
const USAGE_MAX_RECORDS = 5000;
let usageLog = [];
try {
  const j = JSON.parse(readFileSync(USAGE_FILE, 'utf8'));
  if (Array.isArray(j.records)) usageLog = j.records;
} catch { /* 首次运行无文件 */ }
let usageDirty = false;
setInterval(() => {
  if (!usageDirty) return;
  usageDirty = false;
  try {
    const tmp = `${USAGE_FILE}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ records: usageLog }));
    writeFileSync(USAGE_FILE, readFileSync(tmp, 'utf8'));
    try { unlinkSync(tmp); } catch { /* ignore */ }
  } catch { usageDirty = true; }
}, 5000).unref();

// 会话输入增量（新增输入/缓存命中统计）: key=会话 key, value=上次成功请求的消费 promptChars
const usageSeenChars = new Map();

const estTokens = (chars) => Math.max(0, Math.ceil((chars || 0) / 4));

/** 估算闭包: 折一则里的思考（reasoning）字符量 —— contentChunks 里带 _context.reasoning 的分片即上游隐藏思考流 */
function reasoningCharsOf(message) {
  if (!message || !Array.isArray(message.contentChunks)) return 0;
  return message.contentChunks.reduce((s, c) => s + ((c && c._context?.type === 'reasoning' && typeof c.text === 'string') ? c.text.length : 0), 0);
}


function recordUsage(rec) {
  usageLog.push(rec);
  if (usageLog.length > USAGE_MAX_RECORDS) usageLog.splice(0, usageLog.length - USAGE_MAX_RECORDS);
  usageDirty = true;
}

/** 聚合用量：total / today / byAccount / byModel / recent。账号维度带实时状态（Pro/冷却）与额度剩余（accounts.json budget） */
function usageStats() {
  const agg = () => ({
    requests: 0, ok: 0, errors: 0,
    promptChars: 0, completionChars: 0, reasoningChars: 0, newInputChars: 0,
    estPromptTokens: 0, estCompletionTokens: 0, estNewInputTokens: 0, estCachedTokens: 0, estReasoningTokens: 0,
    estTotalTokens: 0, estBilledTokens: 0, // 已用=新增输入+输出（缓存命中不计）
  });
  const accOf = (bucket, key) => bucket[key] || (bucket[key] = agg());
  const add = (t, r) => {
    t.promptChars += r.promptChars || 0;
    t.completionChars += r.completionChars || 0;
    t.reasoningChars += r.reasoningChars || 0;
    t.newInputChars += r.newInputChars || 0; // 老记录无此字段按 0（缓存部分= prompt 全量）
    t.estPromptTokens += r.estPromptTokens || 0;
    t.estCompletionTokens += r.estCompletionTokens || 0;
    t.estNewInputTokens += r.estNewInputTokens || 0;
    t.estCachedTokens += r.estCachedTokens || 0;
    t.estReasoningTokens += r.estReasoningTokens || 0;
    t.estTotalTokens += (r.estPromptTokens || 0) + (r.estCompletionTokens || 0);
    t.estBilledTokens += (r.estNewInputTokens || 0) + (r.estCompletionTokens || 0);
  };
  const total = agg();
  const today = agg();
  const byAccount = {};
  const byModel = {};
  const dayKey = new Date().toISOString().slice(0, 10);
  for (const r of usageLog) {
    for (const t of [total, ...(String(r.ts || '').slice(0, 10) === dayKey ? [today] : [])]) {
      t.requests++;
      if (r.ok) t.ok++; else t.errors++;
      add(t, r);
    }
    const a = accOf(byAccount, r.account || '未知');
    a.requests++; if (r.ok) a.ok++; else a.errors++;
    add(a, r);
    const mv = accOf(byModel, r.model || '未知');
    mv.requests++; if (r.ok) mv.ok++; else mv.errors++;
    add(mv, r);
  }
  // 账号维度附加信息：Pro 标记 / 反代冷却 / 额度剩余（月度 budget 的 initial-used，EUR，accounts.json 体检所得）
  const now = Date.now();
  for (const [email, a] of Object.entries(byAccount)) {
    const meta = allAccounts[email] || null;
    const poolAcc = pool.find((p) => p.email === email) || null;
    a.pro = meta?.pro === true;
    a.blockedFor = poolAcc && poolAcc.blockedUntil > now ? Math.ceil((poolAcc.blockedUntil - now) / 1000) : 0;
    const b = meta?.budget;
    a.budget = b ? {
      remaining: Math.max(0, Number(b.initial_budget || 0) - Number(b.used_budget || 0)),
      currency: b.currency || 'EUR',
      resetAt: b.reset_at || null,
    } : null;
  }
  return { total, today, byAccount, byModel, recent: usageLog.slice(-50), records: usageLog.length };
}

// ---------- 会话映射: key -> { chatId, sentCount, lastText } ----------
const conversations = new Map();
function convKey(messages, explicit) {
  if (explicit) return String(explicit);
  const firstUser = messages.find((m) => m?.role === 'user');
  const txt = typeof firstUser?.content === 'string'
    ? firstUser.content
    : JSON.stringify(firstUser?.content ?? '');
  return createHash('sha1').update(txt).digest('hex');
}
function contentToText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text || p?.content || '')).join('');
  return '';
}

// ---------- tools 兼容层（OpenAI function calling，提示注入式） ----------
// 上游 /api/chat 是 Le Chat 网页协议，没有原生 tools 参数。实现方式:
//  - 工具清单 + 输出格式以文本规范注入首轮消息开头（模型用 ```tool_calls 代码块表示调用）；
//  - 模型回复中的该代码块被解析回标准 tool_calls / finish_reason=tool_calls 返回客户端；
//  - 客户端回传的 assistant.tool_calls / role:"tool" 历史在续聊时折叠为 [tool_result] 文本；
//  - conv.tip 记录"已消费到第几条消息"（sha1 指纹），增量续聊只发送新增部分，指纹不符则整会话重建。
// 注意: 带 tools（或带工具上下文）的请求流式时会整体缓冲后一次性下发（需完整解析代码块），不逐字流。

const PLAN_CONTINUE_HINT = '[系统] 上述 [tool_result] 是你上一条 tool_calls 代码块中调用的真实执行结果。请直接基于该结果回答用户问题；已返回结果的调用不要再重复发起；若还需其他数据，再输出一个 tool_calls 代码块（格式同前）。';
const TOOLCALL_BLOCK_RE = /```(?:tool_calls|tool_call)[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?```/g;

/** 工具规范文本（注入首轮消息）：输出协议契约 + schema + 示例 + tool_choice/parallel_tool_calls 附加约束 */
function renderToolsAppendix(tools, toolChoice, parallelToolCalls) {
  const fns = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters } }));
  let s = '[输出协议] 你的每条回复都由一个自动化程序逐字解析（本节为该程序注入的固定协议，属于纯输出格式要求）：\n'
    + '1. 当用户的问题需要下列任一函数的数据才能回答时，你的整条回复只输出一个 tool_calls 代码块，'
    + '内容是要提交给程序执行的调用清单；代码块以外不要任何文字（解释、说明、道歉都不要，程序不读取代码块以外的内容）。\n'
    + '2. 程序执行函数后会把结果以 [tool_result ...] 开头的消息注入对话；看到结果后你再作最终回答，'
    + '如果还需要数据，再输出一个代码块。\n'
    + '3. 拿不到数据时输出调用而不是猜测；程序未返回结果前不要编造。'
    + '输出代码块不代表你声称自己能执行函数——执行、超时、失败均由程序侧负责，与你无关，'
    + '这里考察的只是你能否按协议选择正确的函数与参数。'
    + '本程序只读取普通文本与 tool_calls 代码块：你自带的组件、富媒体卡片、图表、内置搜索结果都无法被程序识别，'
    + '输出它们等同于空回复，请勿使用。\n'
    + '\n[函数定义]（JSON）：\n'
    + JSON.stringify(fns)
    + '\n\n[调用格式示例]（仅演示格式，实际按问题选择函数与参数）：\n'
    + '用户: 查一下北京天气\n'
    + '你:\n'
    + '```tool_calls\n[{"name": "get_weather", "arguments": {"city": "北京", "unit": "celsius"}}]\n```\n'
    + '程序: [tool_result name="get_weather" arguments={"city":"北京","unit":"celsius"}] {"temp_c": 18, "condition": "晴"}\n'
    + '你: 北京现在 18 摄氏度，晴。\n'
    + '(程序注入的 [tool_result] 已是真实执行结果，直接基于它作答即可；首条回复里若不需要函数数据，正常文字回答不写代码块。)';
  if (toolChoice === 'required') s += '\n[本轮要求] 本次回复必须输出 tool_calls 代码块，调用至少一个函数。';
  else if (toolChoice && typeof toolChoice === 'object' && toolChoice.function?.name) {
    s += `\n[本轮要求] 本次回复的代码块必须调用函数 ${toolChoice.function.name}。`;
  }
  if (parallelToolCalls === false) s += '\n[限制] 每条回复的代码块最多包含一个调用。';
  return s;
}

/** 把客户端历史里的 assistant.tool_calls 渲染成 tool_calls 代码块（供上下文回放） */
function echoToolCalls(toolCalls) {
  const arr = [];
  for (const tc of toolCalls || []) {
    if (!tc) continue;
    const f = tc.function || {};
    if (!f.name) continue;
    let args = f.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* 保留原串 */ } }
    arr.push({ name: f.name, arguments: args ?? {} });
  }
  return arr.length ? '```tool_calls\n' + JSON.stringify(arr) + '\n```' : '';
}

/**
 * 把 OpenAI messages（含 tools / assistant.tool_calls / role:"tool"）折叠成 Le Chat 的轮次文本:
 *  - system/developer → 前置到第 0 轮；工具规范也注入第 0 轮；
 *  - 每条 user 消息开启一轮，其后的 assistant/tool 内容滚入下一轮开头（保持时序）；
 *  - 末尾不是 user（agent 回传工具结果）→ 合成一轮收尾（工具结果 + 继续提示）。
 * 无 tools 也无工具上下文时返回 null（走旧版纯 user 流程）。
 * requireUser=false 供增量续聊折叠新增消息（agent 续轮往往没有新的 user 消息）。
 */
function buildToolsPlan(messages, body, opts = {}) {
  const { requireUser = true } = opts;
  const rawTools = Array.isArray(body?.tools) ? body.tools : [];
  let tools = [];
  if (body?.tool_choice !== 'none') {
    for (const t of rawTools) {
      if (!t || (t.type && t.type !== 'function')) continue;
      const f = t.function || t;
      if (!f?.name) continue;
      tools.push({ name: f.name, description: f.description || '', parameters: f.parameters || f.input_schema || { type: 'object', properties: {} } });
    }
  }
  const hasToolCtx = messages.some((m) => (Array.isArray(m?.tool_calls) && m.tool_calls.length) || m?.role === 'tool' || m?.role === 'function');
  if (requireUser) {
    // 根请求: 只有带 tools 或工具上下文才走 plan 流程（否则旧版纯 user 流程）；
    if (!tools.length && !hasToolCtx) return null;
    if (!messages.some((m) => m?.role === 'user')) return null; // 交给 runTurn 报统一错误
  }
  // requireUser=false（增量续聊）: tools 会话已确立，无条件折叠新增消息；折叠不出任何轮次 → null（调用方回放）
  const spec = tools.length ? renderToolsAppendix(tools, body?.tool_choice, body?.parallel_tool_calls) : '';
  const sys = [];
  const turns = [];
  let pending = [];
  const callIndex = new Map(); // tool_call_id -> {name, arguments}（渲染结果时回显调用参数，便于模型对应）
  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'system' || m.role === 'developer') {
      const t = contentToText(m.content);
      if (t) sys.push(`[系统指令]\n${t}`);
      continue;
    }
    if (m.role === 'user') {
      turns.push([...pending, contentToText(m.content)].filter(Boolean).join('\n\n'));
      pending = [];
      continue;
    }
    if (m.role === 'assistant') {
      const txt = contentToText(m.content);
      const tc = Array.isArray(m.tool_calls) && m.tool_calls.length ? echoToolCalls(m.tool_calls) : '';
      const blk = [txt ? `[助手回复]\n${txt}` : '', tc].filter(Boolean).join('\n\n');
      if (blk) pending.push(blk);
      for (const tc2 of m.tool_calls || []) {
        if (tc2?.id) callIndex.set(tc2.id, { name: tc2.function?.name || '', arguments: tc2.function?.arguments ?? '' });
      }
      continue;
    }
    if (m.role === 'tool' || m.role === 'function') {
      const ref = m.tool_call_id ? callIndex.get(m.tool_call_id) : null;
      const name = m.name || ref?.name || '';
      let argsEcho = '';
      if (ref?.arguments) {
        const a = typeof ref.arguments === 'string' ? ref.arguments : JSON.stringify(ref.arguments);
        if (a && a !== '{}') argsEcho = ` arguments=${a}`;
      }
      const id = m.tool_call_id || '';
      pending.push(`[tool_result name="${name}"${id ? ` id="${id}"` : ''}${argsEcho}]\n${contentToText(m.content)}`);
      continue;
    }
  }
  if (pending.length) turns.push([...pending, PLAN_CONTINUE_HINT].join('\n\n'));
  if (!turns.length) return null;
  turns[0] = [...sys, ...(spec ? [spec] : []), turns[0]].filter(Boolean).join('\n\n');
  return { turns, hasSpec: !!spec };
}

/** 解析模型回复里的 tool_calls 代码块 → { calls:[{id,type,function:{name,arguments}}], content } */
function extractToolCalls(text) {
  const raw = String(text || '');
  const calls = [];
  let content = '';
  let last = 0;
  TOOLCALL_BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = TOOLCALL_BLOCK_RE.exec(raw))) {
    let arr;
    try { arr = JSON.parse(m[1].trim()); } catch { continue; } // 不合法的块当普通文本
    if (!Array.isArray(arr)) arr = [arr];
    const cur = [];
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue;
      const f = it.function || it;
      if (!f?.name) continue;
      let args = f.arguments ?? it.arguments ?? it.parameters ?? {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* 保留原始串 */ } }
      cur.push({
        id: `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'function',
        function: { name: f.name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) },
      });
    }
    if (!cur.length) continue;
    content += raw.slice(last, m.index);
    last = m.index + m[0].length;
    calls.push(...cur);
  }
  if (!calls.length) return { calls, content: raw };
  return { calls, content: (content + raw.slice(last)).trim() };
}

// tools 会话指纹: 记录已消费到第几条客户端消息（增量续聊只发新消息，避免重复回放）
function tipHashOf(messages, upto = messages.length) {
  return createHash('sha1').update(JSON.stringify(messages.slice(0, upto))).digest('hex');
}
/** 续聊去重: 与我们上一条生成完全一致的纯文本 assistant 消息剥掉（上游已有）；tool_calls 消息保留——回显能让模型把参数与结果对应起来 */
function dropEchoIfOurs(conv, suffix) {
  if (!suffix.length) return;
  const m = suffix[0];
  if (m?.role !== 'assistant' || !conv.lastReply) return;
  const parsed = extractToolCalls(conv.lastReply);
  if (parsed.calls.length) return; // 上游生成的是 tool_calls 代码块: 保留 assistant 回显，供 tool_result arguments 对应
  const txt = contentToText(m.content).trim();
  if (!m.tool_calls?.length && txt && txt === parsed.content.trim()) suffix.shift();
}

// ---------- 把事件流折叠成增量文本 ----------
function makeCollector() {
  const state = new Map(); // messageId -> {text, status}
  let lastLen = 0;
  let full = '';
  let status = '';
  let assistantId = null;
  return {
    onEvent(ev) {
      if (!ev || ev.type !== 'message') return '';
      let s = state.get(ev.messageId);
      if (!s) { s = { chunks: [] }; state.set(ev.messageId, s); assistantId = ev.messageId; }
      // 仅处理 assistant（首帧 role=assistant）
      for (const p of ev.patches || []) {
        if (p.op === 'replace' && p.path === '/') {
          s.raw = p.value;
          if (p.value?.role === 'assistant') { s.role = 'assistant'; s.status = p.value.generationStatus; }
        } else if (p.op === 'replace' && p.path === '/generationStatus') {
          s.status = p.value;
        } else if (p.path && p.path.startsWith('/contentChunks')) {
          // 重建 contentChunks（简单起见直接维护数组副本）
          if (!s.chunksArr) s.chunksArr = [];
          const mIdx = /^\/contentChunks\/(\d+)$/.exec(p.path);
          const mText = /^\/contentChunks\/(\d+)\/text$/.exec(p.path);
          if (p.op === 'add' && mIdx) s.chunksArr[Number(mIdx[1])] = p.value;
          else if (p.op === 'replace' && p.path === '/contentChunks') s.chunksArr = p.value || [];
          else if (p.op === 'remove' && mIdx) { s.chunksArr[Number(mIdx[1])] = null; }
          else if (p.op === 'replace' && mIdx) s.chunksArr[Number(mIdx[1])] = p.value;
          else if (p.op === 'replace' && mText) {
            const idx = Number(mText[1]);
            if (!s.chunksArr[idx]) s.chunksArr[idx] = { type: 'text', text: '' };
            s.chunksArr[idx].text = (typeof p.value === 'string' ? p.value : String(p.value ?? ''));
          } else if (p.op === 'append' && mText) {
            // 文本流式增量（上游把字符流以 append 补丁下发，末尾再整理合并）
            const idx = Number(mText[1]);
            const ch = s.chunksArr[idx] || (s.chunksArr[idx] = { type: 'text', text: '' });
            ch.text = (ch.text || '') + (typeof p.value === 'string' ? p.value : String(p.value ?? ''));
          }
        } else if (p.op === 'replace' && p.path === '/content' && typeof p.value === 'string') {
          s.plain = p.value;
        }
      }
      if (s.role !== 'assistant') return '';
      const text = s.plain && s.plain.length >= 0 && s.chunksArr == null
        ? s.plain
        : (s.chunksArr || []).filter((c) => c && c.type === 'text' && !c._context).map((c) => c.text || c.content || '').join('');
      if (text.length > lastLen) {
        const delta = text.slice(lastLen);
        lastLen = text.length;
        full = text;
        return delta;
      }
      full = text;
      return '';
    },
    get full() { return full; },
    get status() { return status; },
    get assistantId() { return assistantId; },
  };
}

// ---------- 一轮对话（多账号轮换 / 建会话 / 续聊 / 历史回放） ----------
// m（可选）= 计量袋: { ttftMs, reasoningChars }，live 轮首包到达耗时 / 思考字符数（供用量记录）
async function executeTurn({ messages, conv, acc, onDelta, m }) {
  const lastUser = [...messages].reverse().find((m0) => m0?.role === 'user');
  if (!lastUser) throw new Error('messages 里没有 user 消息');
  const lastText = contentToText(lastUser.content);
  const cookie = acc.cookie;

  if (!conv) {
    // 新会话: 用第一条 user 消息建会话
    const firstUser = messages.find((msg) => msg.role === 'user');
    const firstText = contentToText(firstUser.content);
    const created = await newChat(cookie, firstText);
    conv = { chatId: created.chatId, acc };
    const single = firstText === lastText && messages.filter((msg) => msg.role === 'user').length === 1;

    if (single) {
      // 单条消息: start 直接生成
      const col = makeCollector();
      const evs = [];
      const t0 = Date.now();
      await sendChat(cookie, {
        chatId: conv.chatId, messageInput: firstText, mode: 'start',
        onDelta: (e) => { if (m && !m.ttftAt) m.ttftAt = Date.now() - t0; evs.push(e); const d = col.onEvent(e); if (d && onDelta) onDelta(d); },
      });
      const f = foldStream(evs);
      const text = col.full || f.assistantText;
      conv.started = true;
      conv.lastSentUser = firstText;
      conv.replied = true;
      conv.lastReply = text;
      if (m) m.reasoningChars = reasoningCharsOf(f.assistantMessage);
      return { conv, text };
    }
    // 有历史: 回放中间的 user 消息（丢弃回复），最后一条正常生成
    const userMsgs = messages.filter((msg) => msg.role === 'user');
    for (let i = 0; i < userMsgs.length - 1; i++) {
      const t = contentToText(userMsgs[i].content);
      const evs = [];
      await sendChat(cookie, {
        chatId: conv.chatId, messageInput: t, mode: i === 0 ? 'start' : 'append',
        onDelta: (e) => evs.push(e),
      });
    }
    conv.started = true;
  } else if (conv.lastSentUser === lastText && conv.replied) {
    // 已有会话且客户端重发同一轮（取流失败重试）→ 重放已存回复
    return { conv, text: conv.lastReply || '', replay: true };
  }

  const col = makeCollector();
  const evs = [];
  const t0 = Date.now();
  await sendChat(cookie, {
    chatId: conv.chatId, messageInput: lastText,
    mode: conv.started ? 'append' : 'start',
    onDelta: (e) => { if (m && !m.ttftAt) m.ttftAt = Date.now() - t0; evs.push(e); const d = col.onEvent(e); if (d && onDelta) onDelta(d); },
  });
  conv.started = true;
  conv.lastSentUser = lastText;
  conv.replied = true;
  const f = foldStream(evs);
  const text = col.full || f.assistantText;
  conv.lastReply = text;
  if (m) m.reasoningChars = reasoningCharsOf(f.assistantMessage);
  return { conv, text };
}

// ---------- tools 轮次执行 ----------
/** plan 轮次终态文本重组: text 分片直取、code 分片按围栏还原（上游 chunker 会把 ```tool_calls 块拆进 code 分片），忽略 reasoning/内置工具分片 */
function planTextOf(message) {
  if (!message) return '';
  if (typeof message.content === 'string' && message.content) return message.content;
  if (!Array.isArray(message.contentChunks)) return '';
  const parts = [];
  for (const c of message.contentChunks) {
    if (!c || c._context) continue;
    if (typeof c.text === 'string') parts.push(c.text);
    else if (c.type === 'code') {
      const code = c.code ?? c.content ?? '';
      if (code) parts.push('```' + (c.language || '') + '\n' + code + '\n```');
    }
  }
  return parts.join('');
}
/** 单轮发送（tools 请求整体缓冲，不需要增量透传）；m 计量袋可选 */
async function sendPlanTurn(cookie, conv, text, m) {
  const evs = [];
  const t0 = Date.now();
  await sendChat(cookie, {
    chatId: conv.chatId, messageInput: text,
    mode: conv.started ? 'append' : 'start',
    onDelta: (e) => { if (m && !m.ttftAt) m.ttftAt = Date.now() - t0; evs.push(e); },
  });
  conv.started = true;
  const f = foldStream(evs);
  if (m) m.reasoningChars = reasoningCharsOf(f.assistantMessage);
  return planTextOf(f.assistantMessage) || f.assistantText;
}
/** 回复里有 tool_calls 围栏但没有完整闭合块（上游截断/chunker 拆散） */
function looksLikeBrokenToolCall(text) {
  const t = String(text || '');
  if (!/```(?:tool_calls|tool_call)/.test(t)) return false;
  TOOLCALL_BLOCK_RE.lastIndex = 0;
  return TOOLCALL_BLOCK_RE.exec(t) === null;
}
/** live 轮兜底: 空 / 块不完整时补一条催促轮重试一次 */
async function liveSendWithNudge(cookie, conv, liveText, m) {
  let text = await sendPlanTurn(cookie, conv, liveText, m);
  if ((!text || !String(text).trim()) || looksLikeBrokenToolCall(text)) {
    if (text === undefined || !text) text = '';
    m && (m.ttftAt = 0); // 催促轮重新计首字
    text = await sendPlanTurn(
      cookie, conv,
      '[系统] 你上一条回复为空或 tool_calls 代码块不完整，程序无法解析。请重新输出：需要函数数据就只输出一个完整的 tool_calls 代码块；否则用普通纯文本回答（不要使用组件、富媒体或图表）。',
      m,
    );
  }
  return text;
}
function commitPlanTurn(conv, messages, text) {
  conv.lastReply = text;
  conv.replied = true;
  conv.tip = { index: messages.length, hash: tipHashOf(messages) }; // 已消费到第几条客户端消息
  return { conv, text };
}
/** tools 全量新建会话: turns[0] 建会话(start)，中间轮回放（生成丢弃），最后轮 live 生成 */
async function executeTurnPlanFresh({ plan, messages, acc, m }) {
  const cookie = acc.cookie;
  const turns = plan.turns;
  const created = await newChat(cookie, turns[0]);
  const conv = { chatId: created.chatId, acc };
  if (turns.length > 1) {
    await sendPlanTurn(cookie, conv, turns[0]); // start 轮生成丢弃
    for (let i = 1; i < turns.length - 1; i++) await sendPlanTurn(cookie, conv, turns[i]);
  }
  const text = await liveSendWithNudge(cookie, conv, turns[turns.length - 1], m);
  console.log(`[tools] 全量回放: ${turns.length} 轮，live 第 ${turns.length} 轮 → ${JSON.stringify(turns[turns.length - 1].slice(0, 120))}...`);
  return commitPlanTurn(conv, messages, text);
}
/**
 * tools 轮次调度:
 *  - conv.tip 指纹匹配且本轮无新增 → 回放已存回复（客户端重试）；
 *  - 指纹匹配且有新增 → 增量续聊（只折叠新增消息，剥掉与我们上条生成重复的 assistant 消息）；
 *  - 无指纹/指纹不符/增量折叠出多轮 → 整会话重建（全量回放 + 最后轮 live 生成）。
 */
async function executeTurnPlan({ plan, messages, conv, acc, m }) {
  if (conv?.tip) {
    const tip = conv.tip;
    const cut = Math.min(tip.index, messages.length);
    if (cut > 0 && tipHashOf(messages, cut) === tip.hash) {
      if (cut === messages.length) return { conv, text: conv.lastReply || '', replay: true };
      const suffix = messages.slice(tip.index);
      dropEchoIfOurs(conv, suffix);
      const p2 = buildToolsPlan(suffix, {}, { requireUser: false }); // spec 不重发（上游会话里已有）
      if (p2 && p2.turns.length === 1) {
        console.log(`[tools] 增量续聊: ${messages.length - tip.index} 条新消息折叠 1 轮 → ${JSON.stringify(p2.turns[0].slice(0, 120))}...`);
        const text = await liveSendWithNudge(acc.cookie, conv, p2.turns[0], m);
        return commitPlanTurn(conv, messages, text);
      }
      if (!p2) return { conv, text: conv.lastReply || '', replay: true }; // 新增部分只剩我们自己的回复 → 回放
    }
  }
  return executeTurnPlanFresh({ plan, messages, acc, m });
}

async function runTurn({ messages, convId, plan = null, onDelta }) {
  const key = convKey(messages, convId);
  let conv = conversations.get(key);
  if (!messages.some((m) => m?.role === 'user')) throw new Error('messages 里没有 user 消息');
  const promptChars = messages.reduce((s, m) => s + contentToText(m?.content).length, 0);

  // tools 会话必须带 tip 指纹；旧会话（纯文本流程）升级成 tools 请求时丢弃重建，保证上下文完整回放
  if (plan && conv && !conv.tip) { conversations.delete(key); conv = null; }

  // 选账号: 会话绑定账号粘性优先（未冷却），否则 Pro 优先轮换、Free 兜底
  const acc = conv?.acc && conv.acc.blockedUntil <= Date.now() ? conv.acc : pickAccount(conv?.acc);
  if (!acc) {
    const wait = Math.max(...pool.map((a) => a.blockedUntil)) - Date.now();
    const err = new Error(`所有账号都在限速冷却中，请 ${Math.ceil(wait / 1000)}s 后重试`);
    err.status = 429; err.allBlocked = true; err.retryAfter = Math.ceil(wait / 1000);
    throw err;
  }

  const usage = { promptChars, completionChars: 0, reasoningChars: 0, ttftMs: 0, newInputChars: promptChars, cachedChars: 0 };
  // 会话输入增量: 同一会话相对上次成功请求新增的 prompt 字符 = 新增输入，其余视为缓存命中（上下文已消费过）
  const prevSeen = usageSeenChars.get(key);
  usage.newInputChars = prevSeen == null || promptChars <= prevSeen ? promptChars : promptChars - prevSeen;
  usage.cachedChars = Math.max(0, promptChars - usage.newInputChars);
  const m = {}; // 计量袋: { ttftAt, reasoningChars } → 汇入 usage
  try {
    const r = plan
      ? await executeTurnPlan({ plan, messages, conv, acc, m })
      : await executeTurn({ messages, conv, acc, onDelta, m });
    conversations.set(key, r.conv);
    usage.completionChars = (r.text || '').length;
    usage.reasoningChars = m.reasoningChars || 0;
    usage.ttftMs = m.ttftAt || 0;
    usageSeenChars.set(key, promptChars);
    return { text: r.text, chatId: r.conv.chatId, account: acc.email, usage };
  } catch (e) {
    if (e.rateLimited || e.status === 429) {
      blockAccount(acc, e.retryAfter);
      // 换账号重建会话（重放历史）
      const next = pickAccount(null);
      if (!next) throw e;
      conversations.delete(key);
      console.log(`[切换] 会话迁移到账号 ${next.email}，重放历史消息...`);
      const r = plan
        ? await executeTurnPlanFresh({ plan, messages, acc: next, m })
        : await executeTurn({ messages, conv: null, acc: next, onDelta, m });
      conversations.set(key, r.conv);
      usage.completionChars = (r.text || '').length;
      usage.reasoningChars = m.reasoningChars || 0;
      usage.ttftMs = m.ttftAt || 0;
      usageSeenChars.set(key, promptChars);
      return { text: r.text, chatId: r.conv.chatId, account: next.email, usage };
    }
    throw e;
  }
}

// ---------- OpenAI 响应组装 ----------
function sse(obj) { return `data: ${JSON.stringify(obj)}\n\n`; }
function completionChunk(model, delta, finish = null, id) {
  return {
    id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}
// 对外模型清单：对齐上游真实目录（2026-11-24 从 user.session.vcw_model_catalog 实测）。
// 注意：上游 /api/chat 不接受 model 参数（实测），实际模型由服务端决定（默认 mistral-large-4-0）；
// 请求里的 model 只在响应中原样回显，不会改变上游实际使用的模型。
const MODELS = [
  'mistral-large-4-0',
  'mistral-medium-latest',
  'zai-glm-5-3',
  'zai-glm-5-3-flash',
  'deepseek-v4.1-flash',
];

// ---------- HTTP 服务 ----------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  // CORS
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  // 鉴权门：/v1/* 必须带正确 key（未设置 key 时不拦截）；/admin/* 本机回环免验，外部访问需带 key
  if (path.startsWith('/v1/') && !authOk(req, url)) return authFail(res);
  if (path.startsWith('/admin/') && !isLoopback(req) && !authOk(req, url)) return authFail(res);

  if (req.method === 'GET' && (path === '/' || path === '/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'mistral-reverse-proxy', conversations: conversations.size, config: existsSync(CONFIG) ? CONFIG : null }));
    return;
  }
  // 账号池状态（GUI 轮询用；pro 字段与 Pro/Free 计数对应「Pro 优先轮换」调度观测）
  if (req.method === 'GET' && (path === '/admin/pool' || path === '/admin/status')) {
    const now = Date.now();
    const proCount = pool.filter((a) => a.pro === true).length;
    const availOf = (pro) => pool.filter((a) => a.pro === pro && a.blockedUntil <= now).length;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      total: pool.length,               // 总数（字段名向后兼容）
      blocked: blockedCount(),          // 冷却中数量（字段名向后兼容）
      proOnly: PRO_ONLY,
      proCount,                         // Pro 总数
      freeCount: pool.length - proCount, // Free 总数
      proAvailable: availOf(true),      // 未冷却可调度的 Pro
      freeAvailable: availOf(false),    // 未冷却可调度的 Free
      accounts: pool.map((a) => ({
        email: a.email,
        pro: a.pro === true,
        blockedFor: a.blockedUntil > now ? Math.ceil((a.blockedUntil - now) / 1000) : 0,
      })),
    }));
    return;
  }
  // 手动热更新账号池 + API key + 客户端形态（重读 accounts.json / 配置 / proxy_key.txt / client_profile.txt）
  if (req.method === 'POST' && path === '/admin/reload') {
    const total = reloadPool('手动刷新');
    refreshKey('手动刷新');
    refreshProfile('手动刷新');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, total, proOnly: PRO_ONLY }));
    return;
  }
  // 当前客户端形态（GUI 看板显示/测试用）
  if (req.method === 'GET' && path === '/admin/profile') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ profile: getClientProfile() }));
    return;
  }
  // token 用量统计（估算值；落盘 usage_stats.json）
  if (req.method === 'GET' && path === '/admin/usage') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ estimated: true, ...usageStats() }));
    return;
  }
  if (req.method === 'GET' && path === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: MODELS.map((id) => ({ id, object: 'model', owned_by: 'mistral', created: 1700000000 })),
    }));
    return;
  }
  if (req.method !== 'POST' || path !== '/v1/chat/completions') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `未知端点: ${req.method} ${path}`, type: 'invalid_request_error' } }));
    return;
  }

  // 读取请求体
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 8 * 1024 * 1024) break; }
  let body;
  try { body = JSON.parse(raw || '{}'); } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '请求体不是合法 JSON', type: 'invalid_request_error' } }));
    return;
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const model = body.model || 'mistral-large-latest';
  const stream = !!body.stream;
  const convId = body.conversation_id ?? body.conversationId ?? body.user ?? null;
  const cid = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const plan = buildToolsPlan(messages, body); // tools / 工具上下文 请求 → 提示注入式函数调用；null = 旧流程

  const tReq = Date.now(); // 请求开始（成功/失败/流式各路径共用，耗时分母）
  const record = (ok, account, r, errMsg) => {
    const promptChars = messages.reduce((s, m) => s + contentToText(m?.content).length, 0);
    const newInputChars = ok ? (r?.usage?.newInputChars ?? promptChars) : 0; // 失败轮不计新增（重试会重算）
    const completionChars = ok ? (r?.usage?.completionChars || 0) : 0;
    const reasoningChars = ok ? (r?.usage?.reasoningChars || 0) : 0;
    recordUsage({
      ts: new Date().toISOString(),
      account: account || null,
      model,
      stream,
      ok,
      promptChars,
      completionChars,
      reasoningChars,
      newInputChars,
      estPromptTokens: estTokens(promptChars),
      estCompletionTokens: estTokens(completionChars),
      estNewInputTokens: estTokens(newInputChars),
      estCachedTokens: Math.max(0, estTokens(promptChars) - estTokens(newInputChars)),
      estReasoningTokens: estTokens(reasoningChars),
      ttftMs: ok ? (r?.usage?.ttftMs || 0) : 0, // live 轮上游首投递 message 事件的耗时
      elapsedMs: Date.now() - tReq,
      error: ok ? null : (errMsg || null),
    });
  };

  try {
    if (!stream) {
      const r = await runTurn({ messages, convId, ...(plan ? { plan } : {}) });
      record(true, r.account, r);
      const usage = {
        prompt_tokens: estTokens(r.usage.promptChars),
        completion_tokens: estTokens(r.usage.completionChars),
        total_tokens: estTokens(r.usage.promptChars) + estTokens(r.usage.completionChars),
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      // tools 请求: 解析 tool_calls 代码块 → 标准 tool_calls 响应
      if (plan) {
        const parsed = extractToolCalls(r.text);
        const hasCalls = parsed.calls.length > 0;
        const message = { role: 'assistant', content: hasCalls ? (parsed.content || null) : (parsed.content || '') };
        if (hasCalls) message.tool_calls = parsed.calls;
        res.end(JSON.stringify({
          id: cid, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, message, finish_reason: hasCalls ? 'tool_calls' : 'stop' }],
          usage,
          usage_estimated: true,
          chat_id: r.chatId,
          account: r.account,
        }));
        return;
      }
      res.end(JSON.stringify({
        id: cid, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: { role: 'assistant', content: r.text }, finish_reason: 'stop' }],
        usage,
        usage_estimated: true,   // 上游不回传 token 数，此处为字符估算值
        chat_id: r.chatId,
        account: r.account,
      }));
      return;
    }

    // 流式
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no',
    });
    res.write(sse(completionChunk(model, { role: 'assistant', content: '' }, null, cid)));
    let sent = 0;
    // tools 请求整体缓冲（需完整解析代码块），不下发增量；普通请求照旧逐字流
    const r = await runTurn({
      messages, convId,
      ...(plan ? { plan } : {}),
      onDelta: plan ? undefined : (d) => { sent++; res.write(sse(completionChunk(model, { content: d }, null, cid))); },
    });
    record(true, r.account, r);
    let finishReason = 'stop';
    if (plan) {
      const parsed = extractToolCalls(r.text);
      if (parsed.content) { sent++; res.write(sse(completionChunk(model, { content: parsed.content }, null, cid))); }
      if (parsed.calls.length) {
        parsed.calls.forEach((c, i) => res.write(sse(completionChunk(
          model,
          { tool_calls: [{ index: i, id: c.id, type: 'function', function: c.function }] },
          null, cid,
        ))));
        finishReason = 'tool_calls';
      } else if (!parsed.content) {
        res.write(sse(completionChunk(model, { content: r.text || '' }, null, cid)));
      }
    } else if (!r.text && !sent) {
      res.write(sse(completionChunk(model, { content: r.text || '' }, null, cid)));
    }
    res.write(sse(completionChunk(model, {}, finishReason, cid)));
    // 客户端要求 stream_options.include_usage 时，末尾补一个带 usage 的空 choices 帧（OpenAI 惯例）
    if (body.stream_options?.include_usage) {
      const usage = {
        prompt_tokens: estTokens(r.usage.promptChars),
        completion_tokens: estTokens(r.usage.completionChars),
        total_tokens: estTokens(r.usage.promptChars) + estTokens(r.usage.completionChars),
      };
      res.write(sse({ id: cid, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [], usage, usage_estimated: true }));
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    console.log(`[反代错误] ${e.message}`);
    record(false, null, null, e.message);
    const code = e.status === 429 ? 429 : e.status === 403 ? 403 : 500;
    const type = e.status === 429 ? 'rate_limit_error' : e.status === 403 ? 'upstream_forbidden' : 'server_error';
    const payload = JSON.stringify({ error: { message: e.message, type, cf_challenged: e.cfChallenged === true } });
    if (stream) {
      if (!res.headersSent) res.writeHead(code, { 'content-type': 'text/event-stream; charset=utf-8', 'retry-after': String(e.retryAfter || 60) });
      res.write(`data: ${payload}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.writeHead(code, { 'content-type': 'application/json', 'retry-after': String(e.retryAfter || 60) });
      res.end(payload);
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log('============================================================');
  console.log('  Mistral 对话反代已启动（OpenAI 兼容，纯协议无浏览器）');
  console.log(`  地址:    http://${HOST}:${PORT}/v1`);
  console.log(`  端点:    POST /v1/chat/completions   GET /v1/models`);
  console.log('  账号池:  accounts.json 变更自动热更新（约 2.5s 轮询；GUI 注册完成后自动入池）');
  console.log(`  配置:    ${existsSync(CONFIG) ? CONFIG : '未使用（仅 accounts.json 的账号池）'}`);
  console.log(`  API key: ${API_KEY_ARG ? '已设置（--api-key 参数）' : apiKey ? '已设置（proxy_key.txt，可在 GUI「用量看板」修改，热更新）' : '未设置（/v1/* 不校验；GUI 首次启动会自动生成）'}`);
  const bannerPro = pool.filter((a) => a.pro === true).length;
  console.log(`  账号池:  ${pool.length} 个（Pro ${bannerPro} / Free ${pool.length - bannerPro}；调度: Pro 优先轮换，Free 兜底，429 自动切换）`);
  for (const a of pool) console.log(`           - ${a.email}${a.pro === true ? ' [Pro]' : ''}`);
  console.log('------------------------------------------------------------');
  const keyQ = apiKey ? `-H "Authorization: Bearer <你的key>" ` : '';
  console.log(`  测试: curl -s ${keyQ}http://${HOST}:${PORT}/v1/models`);
  console.log('  停止: Ctrl+C');
  console.log('============================================================');
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.log(`[错误] 端口 ${PORT} 已被占用，请加 --port 换端口。`);
  else console.log(`[错误] ${e.message}`);
  process.exit(1);
});
