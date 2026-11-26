#!/usr/bin/env node
/**
 * mistral_login.mjs — 纯协议（无浏览器）Mistral 登录，保存登录信息供后续直接打开网页。
 *
 * 登录算法（Kratos self-service，纯 HTTP 请求，已实测）：
 *   1. GET  https://auth.mistral.ai/self-service/login/browser?return_to=...
 *      -> 303，Set-Cookie: __Host-ory_kratos_browser_*（流程 cookie）
 *      -> 响应 HTML/JSON 中取 flow id + csrf_token
 *   2. POST https://auth.mistral.ai/self-service/login?flow=<id>
 *      body: { csrf_token, method:"identifier_first", identifier:<email> }
 *      -> 400（Mistral Kratos 配置行为，属正常），flow 切到 password 步骤，
 *         响应里带下一步的 csrf_token
 *   3. POST https://auth.mistral.ai/self-service/login?flow=<id>
 *      body: { csrf_token, method:"password", identifier:<email>, password }
 *      -> 200 { session: { active: true, identity: {...} } }
 *      -> Set-Cookie: ory_session_*; Domain=mistral.ai; Max-Age=7775999; HttpOnly; Secure
 *   4. GET  https://auth.mistral.ai/sessions/whoami 校验会话
 *   会话 cookie 对 *.mistral.ai 全站有效（chat/admin/console），约 90 天。
 *
 * 用法:
 *   node mistral_login.mjs --config test_fresh_config.json   # 用配置里的邮箱/密码登录
 *   node mistral_login.mjs --email a@b.c --password xxx      # 直接指定账密
 *   node mistral_login.mjs --account a@b.c                   # 从 accounts.json 取密码登录
 *   node mistral_login.mjs --list                            # 列出 accounts.json 里的账号
 *   node mistral_login.mjs --config f.json --url https://chat.mistral.ai/work
 *                                                           # 登录后输出可直接打开的 URL 和 cookie
 *   node mistral_login.mjs --config f.json --proxy http://127.0.0.1:7897   # 代理出口（限流时换 IP）
 *   node mistral_login.mjs --config f.json --fresh           # 强制全新登录（默认先试复用有效会话）
 *
 * 登录策略（防限流）：
 *   默认先带已有会话 cookie 探测 /sessions/whoami —— 会话仍有效（约 90 天）就跳过全新登录；
 *   探测也撞 403/429 说明出口 IP 正被限流，直接退出并提示代理，不会白白消耗登录尝试。
 *
 * 登录成功后会：
 *   - 把 session.cookies 写回 --config 指定的配置文件（供 mistral_interactive 复用）
 *   - 更新 accounts.json 登记表
 *   - 导出 cookies/<email>.txt（Netscape）和 cookies/<email>.json（Cookie-Editor）
 *     —— 用浏览器扩展导入即可直接以登录态打开网页
 *   - 打印 Cookie 请求头（可直接贴进 curl / 脚本使用）
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { upsertAccount, exportCookieFiles, loadAccounts, cookieExpiry } from './mistral_accounts.mjs';

const AUTH = 'https://auth.mistral.ai';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0';

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const v = i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true';
      o[key] = v;
      if (v !== 'true') i++;
    }
  }
  return o;
}
const opts = parseArgs(process.argv.slice(2));
const log = (phase, msg, extra) => console.log(`[${phase}] ${msg}${extra !== undefined ? '\n        ' + extra : ''}`);

// ---------------- 可选代理（默认直连；仅在直接运行时由 CLI 开启） ----------------
// 全部请求都去 auth.mistral.ai，开代理即全量走代理出口——登录被限流（403/429）时的主出路。
let ufetch = fetch;
let proxyAgent = null;

/** 设置登录出口代理 http://[user:pass@]host:port；传空恢复直连。与 mistral_interactive 相同的 undici 模式 */
export async function setProxy(proxyUrl) {
  if (!proxyUrl) { proxyAgent = null; return; }
  const undici = await import('undici');
  ufetch = undici.fetch;
  proxyAgent = new undici.ProxyAgent(proxyUrl);
}

// ---------------- 纯协议 HTTP（cookie jar） ----------------
const jar = new Map();
function jarFrom(res) {
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of cookies) {
    const pair = c.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
async function req(method, url, { body, headers = {}, redirect = 'follow' } = {}) {
  const h = { accept: 'application/json', 'user-agent': UA, ...headers };
  if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
  const ck = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  if (ck) h.cookie = ck;
  const init = { method, headers: h, body, redirect, signal: AbortSignal.timeout(60000) };
  const r = proxyAgent ? await ufetch(url, { ...init, dispatcher: proxyAgent }) : await fetch(url, init);
  jarFrom(r);
  return r;
}
const csrfFrom = (text) => (text.match(/"name":"csrf_token"[\s\S]{0,800}?"value":"([^"]+)"/) || [])[1];
const flowFrom = (text) => (text.match(/"id":"([0-9a-f-]{36})"/) || [])[1];
function kratosMessages(text) {
  try {
    const j = JSON.parse(text);
    const msgs = [...(j.ui?.messages || []), ...(j.ui?.nodes || []).flatMap(n => n.messages || [])];
    return msgs.map(m => m.text).filter(Boolean);
  } catch { return []; }
}
function sessionCookies() {
  const out = {};
  for (const [k, v] of jar) if (/^ory_/i.test(k)) out[k] = v;
  return out;
}

// ---------------- 登录核心（纯协议算法） ----------------
export async function pureLogin(email, password) {
  jar.clear();
  // 1. 创建登录 flow
  const r1 = await req('GET', `${AUTH}/self-service/login/browser?return_to=${encodeURIComponent('https://chat.mistral.ai/work')}`, { redirect: 'manual' });
  const t1 = await r1.text();
  const flowId = flowFrom(t1);
  const csrf = csrfFrom(t1);
  if (!flowId || !csrf) throw new Error(`无法创建登录 flow（HTTP ${r1.status}）`);
  log('L1', `flow id: ${flowId}`);

  // 2. identifier_first（返回 400 是正常行为，只要求拿到下一步 csrf）
  const r2 = await req('POST', `${AUTH}/self-service/login?flow=${flowId}`, {
    body: JSON.stringify({ csrf_token: csrf, method: 'identifier_first', identifier: email, transient_payload: {} }),
    headers: { origin: 'https://v2.auth.mistral.ai', referer: 'https://v2.auth.mistral.ai/' },
  });
  const t2 = await r2.text();
  const csrf2 = csrfFrom(t2);
  log('L2', `identifier_first: ${r2.status}`);
  if (!csrf2) {
    // 403/429 是上游风控（短时间登录太频繁），不是密码错误 —— 密码错会走到下一步
    if (r2.status === 403 || r2.status === 429) {
      throw new Error(
        `Mistral 登录限流（HTTP ${r2.status}）：短时间登录太频繁被临时拦截。` +
        `请稍等 10-30 分钟再试，或加 --proxy http://127.0.0.1:7897 换出口 IP；已有渠道不受影响。`
      );
    }
    throw new Error(`identifier_first 未进入密码步骤: ${kratosMessages(t2).join('；') || r2.status}`);
  }

  // 3. password
  const r3 = await req('POST', `${AUTH}/self-service/login?flow=${flowId}`, {
    body: JSON.stringify({ csrf_token: csrf2, method: 'password', identifier: email, password }),
    headers: { origin: 'https://v2.auth.mistral.ai', referer: 'https://v2.auth.mistral.ai/' },
  });
  const t3 = await r3.text();
  let j3 = null;
  try { j3 = JSON.parse(t3); } catch {}
  const msgs = kratosMessages(t3);
  if (r3.status !== 200 || !j3?.session?.active) {
    const inactive = msgs.some(m => /not active|verify your email/i.test(m));
    throw new Error(`登录失败: ${msgs.join('；') || `HTTP ${r3.status}`}${inactive ? '（账号未激活，需先验证邮箱）' : ''}`);
  }
  log('L3', `登录成功: identity ${j3.session.identity?.id}`);

  // 4. whoami 校验
  const r4 = await req('GET', `${AUTH}/sessions/whoami`, { redirect: 'manual' });
  const who = r4.status === 200 ? await r4.json().catch(() => null) : null;
  if (!who?.active) throw new Error('登录后 whoami 校验未通过');
  return { identityId: who.identity?.id, session: who, cookies: sessionCookies() };
}

/**
 * 会话复用校验：带已有 ory cookie 试探 /sessions/whoami（只读，不发登录请求）。
 *   - 会话有效 → 返回与 pureLogin 相同结构（含 reused: true），调用方跳过全新登录
 *   - 校验请求本身被限流 → 返回 { blocked: true, status }（IP 正被风控，别再浪费登录尝试）
 *   - 其余（无 cookie / 过期 / 未激活）→ 返回 null
 */
export async function checkSession(cookies = {}) {
  const entries = Object.entries(cookies || {}).filter(([k]) => /^ory_/i.test(k));
  if (!entries.length) return null;
  const ckStr = entries.map(([k, v]) => `${k}=${v}`).join('; ');
  try {
    const init = {
      headers: { accept: 'application/json', 'user-agent': UA, cookie: ckStr },
      redirect: 'manual',
      signal: AbortSignal.timeout(60000),
    };
    const r = proxyAgent ? await ufetch(`${AUTH}/sessions/whoami`, { ...init, dispatcher: proxyAgent }) : await fetch(`${AUTH}/sessions/whoami`, init);
    if (r.status === 403 || r.status === 429) return { blocked: true, status: r.status };
    if (r.status !== 200) return null;
    const who = await r.json().catch(() => null);
    if (!who?.active) return null;
    return { identityId: who.identity?.id, session: who, cookies: Object.fromEntries(entries), reused: true };
  } catch { /* 网络异常按不可复用处理 */ return null; }
}

// ---------------- 直接打开已登录网页（Edge/Chrome CDP，纯协议） ----------------
// 思路：用独立 user-data-dir 启动浏览器 + 远程调试端口，通过 CDP Network.setCookie
// 注入 ory_session_*（domain=.mistral.ai），再 Page.navigate 到目标页 → 打开即登录态。
// 浏览器已开过（端口存活）时直接复用，只刷新 cookie 并跳转。
const CDP_PORT = 9333;
const CDP_PROFILE = `${process.cwd()}\\cdp_profile`;

function findBrowser() {
  const cands = [
    `${process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.ProgramFiles || 'C:\\Program Files'}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.LOCALAPPDATA || ''}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.ProgramFiles || 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
  ];
  return cands.find(p => p && existsSync(p)) || null;
}

async function cdpFetch(pathname) {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}${pathname}`, { signal: AbortSignal.timeout(3000) });
  return r.json();
}

async function openBrowserWithCookies(cookies, url) {
  // 1. 端口已存活（上次的浏览器还开着）→ 直接复用
  let version = null;
  for (let i = 0; i < 3 && !version; i++) {
    try { version = await cdpFetch('/json/version'); } catch { break; }
  }
  // 2. 否则启动独立 profile 的浏览器
  if (!version) {
    const exe = findBrowser();
    if (!exe) throw new Error('未找到 Edge/Chrome，无法自动打开');
    spawn(exe, [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${CDP_PROFILE}`,
      '--no-first-run', '--no-default-browser-check',
      '--new-window', url,
    ], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 20 && !version; i++) {
      await new Promise(r => setTimeout(r, 500));
      try { version = await cdpFetch('/json/version'); } catch { /* 还没起来 */ }
    }
    if (!version) throw new Error('浏览器调试端口未就绪（可能被策略禁用 remote-debugging）');
  }
  // 3. 找页面 target，连 WebSocket 注入 cookie 并跳转
  const targets = await cdpFetch('/json/list');
  const page = targets.find(t => t.type === 'page');
  if (!page?.webSocketDebuggerUrl) throw new Error('没有可用的页面 target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP WebSocket 连接失败')); });
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ error: { message: 'timeout' } }); } }, 10000);
  });
  await send('Network.enable');
  let ok = 0;
  for (const [name, value] of Object.entries(cookies)) {
    const r = await send('Network.setCookie', {
      name, value, domain: '.mistral.ai', path: '/',
      secure: true, httpOnly: true, sameSite: 'Lax',
      expires: cookieExpiry(name, value),
    });
    if (r.result?.success) ok++;
  }
  await send('Page.navigate', { url });
  ws.close();
  return { ok, total: Object.keys(cookies).length };
}


// 下面是可执行入口。仅在「直接运行本文件」时执行；
// 被 import 时不触发 CLI，避免副作用。
// 判断依据：process.argv[1] 解析后等于本文件路径。
const isDirectRun = (() => {
  try {
    const selfPath = fileURLToPath(import.meta.url);
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return entry === path.resolve(selfPath);
  } catch {
    return false;
  }
})();

if (!isDirectRun) {
  // 作为模块被引用：只导出 pureLogin 等函数，不跑 CLI
} else {

if (opts['list'] === 'true') {
  const all = loadAccounts();
  const emails = Object.keys(all);
  if (!emails.length) { console.log('accounts.json 里还没有账号。'); process.exit(0); }
  console.log(`共 ${emails.length} 个账号：`);
  for (const e of emails) {
    const a = all[e];
    const hasCk = !!(a.session?.cookies && Object.keys(a.session.cookies).length);
    console.log(`  ${e}  identity=${a.identity_id || '?'}  会话=${hasCk ? '已保存(' + (a.session.saved_at || '?') + ')' : '无'}  配置=${a.config_file || '-'}`);
  }
  process.exit(0);
}

// 解析 email/password
let email = opts['email'] && opts['email'] !== 'true' ? opts['email'] : '';
let password = opts['password'] && opts['password'] !== 'true' ? opts['password'] : '';
const configFile = opts['config'] && opts['config'] !== 'true' ? opts['config'] : null;

if ((!email || !password) && opts['account'] && opts['account'] !== 'true') {
  const rec = loadAccounts()[opts['account']];
  if (!rec) { log('ERR', `accounts.json 里没有账号 ${opts['account']}`); process.exit(1); }
  email = email || rec.email;
  password = password || rec.password;
}
if ((!email || !password) && configFile && existsSync(configFile)) {
  const cfg = JSON.parse(readFileSync(configFile, 'utf8'));
  email = email || cfg.email;
  password = password || cfg.password;
}
if (!email || !password) {
  console.log('用法: node mistral_login.mjs --config <配置文件> | --email <邮箱> --password <密码> | --account <邮箱> | --list');
  process.exit(1);
}

// 代理（--proxy / MISTRAL_PROXY）：全新登录与会话校验请求都走代理出口
const PROXY_URL = (opts['proxy'] && opts['proxy'] !== 'true') ? opts['proxy'] : process.env.MISTRAL_PROXY;
if (PROXY_URL) {
  try { await setProxy(PROXY_URL); log('PROXY', `${PROXY_URL}（登录出口走代理）`); }
  catch (e) { log('WARN', `代理初始化失败，退回直连: ${e.message}`); }
}

// 会话复用（默认开启，--fresh 强制全新登录）：
// 90 天会话仍有效 → 不再发登录请求（治「短时间登录太频繁被限流」的根）。
// 已有会话从配置文件取，其次从 accounts.json 取。
let result = null;
let reusedAt = null;
if (opts['fresh'] !== 'true') {
  let oldSession = null;
  if (configFile && existsSync(configFile)) {
    try { oldSession = JSON.parse(readFileSync(configFile, 'utf8'))?.session || null; } catch { /* 半截 JSON 按无会话 */ }
  }
  if (!oldSession?.cookies || !Object.keys(oldSession.cookies).length) {
    oldSession = loadAccounts()[email]?.session || null;
  }
  const oldCk = oldSession?.cookies || {};
  if (Object.keys(oldCk).length) {
    log('L0', `发现已有会话（${oldSession.saved_at || '无时间戳'}），先校验可复用性…`);
    result = await checkSession(oldCk);
    if (result?.blocked) {
      log('ERR', `会话校验也返回 ${result.status}：当前出口 IP 正被限流，全新登录同样会被拒。`
        + `请等 10-30 分钟，或 --proxy <代理地址> 换出口 IP。已有会话/渠道不受影响。`);
      process.exit(1);
    }
    if (result) reusedAt = oldSession.saved_at || null;
  }
}
if (result) {
  log('L0', `会话仍有效（identity ${result.identityId}），跳过全新登录${reusedAt ? `（签发于 ${reusedAt}）` : ''}。需要强刷请加 --fresh`);
} else {
  log('L', `纯协议登录: ${email}${opts['fresh'] === 'true' ? '（--fresh 强制全新登录）' : ''}`);
  try {
    result = await pureLogin(email, password);
  } catch (e) {
    log('ERR', e.message);
    process.exit(1);
  }
}

// 保存登录信息
const session = { cookies: result.cookies, saved_at: new Date().toISOString() };
if (configFile && existsSync(configFile)) {
  const cfg = JSON.parse(readFileSync(configFile, 'utf8'));
  cfg.session = session;
  cfg.identity_id = cfg.identity_id || result.identityId;
  writeFileSync(configFile, JSON.stringify(cfg, null, 2));
  log('SAVE', `会话 cookie 已写回 ${configFile}`);
}
const rec = upsertAccount({ email, password, identity_id: result.identityId, session, config_file: configFile }, configFile);
log('SAVE', `账号已登记到 accounts.json（identity ${result.identityId}）`);
const files = exportCookieFiles(email, result.cookies);
if (files) log('SAVE', `浏览器导入文件: ${files.txtPath}（Netscape） / ${files.jsonPath}（Cookie-Editor）`);

// 输出可直接使用的登录信息
const targetUrl = opts['url'] && opts['url'] !== 'true' ? opts['url'] : 'https://chat.mistral.ai/work';
const ckStr = Object.entries(result.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
console.log('\n================ 登录信息（可直接打开网页 / 脚本使用） ================');
console.log(`账号: ${email}`);
console.log(`身份: ${result.identityId}`);
console.log(`Cookie: ${ckStr}`);
console.log(`目标页面: ${targetUrl}`);
console.log('浏览器直接打开: 用扩展导入 cookies/' + email + '.json（Cookie-Editor）后访问上述 URL 即为登录态');
console.log('====================================================================');

// --open：CDP 注入 cookie 后直接打开已登录网页
if (opts['open'] === 'true') {
  log('OPEN', `正在打开 ${targetUrl}（注入登录 cookie）…`);
  try {
    const { ok, total } = await openBrowserWithCookies(result.cookies, targetUrl);
    log('OPEN', `完成：已注入 ${ok}/${total} 个 cookie，浏览器窗口即为登录态`);
  } catch (e) {
    log('OPEN', `自动打开失败: ${e.message}`);
    log('OPEN', `备用方案：浏览器扩展导入 ${files?.jsonPath || `cookies/${email}.json`} 后访问 ${targetUrl}`);
    process.exitCode = 1;
  }
}

} // end of direct-run block
