#!/usr/bin/env node
/**
 * vibe_login.mjs — 一键把 Vibe 桌面端切换到指定账号（纯 HTTP，不需要浏览器）
 *
 * 为什么以前"注入 cookie"没用（2026-11-24 逆向 app.asar 实测结论）：
 *   Vibe 桌面端不看浏览器 cookie，它的登录态是 OIDC token，加密存在
 *     %APPDATA%\le-chat-desktop\config.json → authOidcTokens
 *   结构：{ "kind":"encrypted", "value":"<base64>" }
 *   明文：{ "tokens": { accessToken, expiresAt, idToken, idTokenExpiresAt, refreshToken }, "version": 2 }
 *   加密：Electron safeStorage（Windows = "v10" + AES-256-GCM，
 *         密钥由 DPAPI 保护，存放在 数据目录\Local State → os_crypt.encrypted_key）
 *   → 所以往 Chromium 里塞 ory_session cookie 对 Vibe 的账号没有任何影响。
 *
 * 正确做法（本脚本）：
 *   1) 用邮箱 + 密码走 Ory 的 OIDC authorization code + PKCE（纯 HTTP）：
 *        GET  auth.mistral.ai/oauth2/auth                → login_challenge
 *        GET  .../ui/login → .../self-service/login/browser → flow
 *        POST self-service/login (identifier_first → password)
 *        GET  /oauth2/auth?...&login_verifier=...        → consent_challenge
 *        POST v2.auth.mistral.ai/api/consent/accept      → redirect_to
 *        GET  redirect_to                                → http://127.0.0.1:<port>/auth/oidc/callback?code=...
 *        POST auth.mistral.ai/oauth2/token               → access/id/refresh token
 *   2) 用 DPAPI 解出本机 OSCrypt 密钥，把 token 按 Vibe 的格式重新加密写回 config.json
 *   3) （默认 --apply）由 detached 子进程：关掉 Vibe → 写配置 → 重新启动 Vibe
 *      —— Vibe 只在启动时读 authOidcTokens，所以必须重启一次；
 *         子进程是 detached 的，即使本脚本/终端被 Vibe 一起关掉也会继续完成。
 *
 * 用法：
 *   node vibe_login.mjs --check                                  # 查看 Vibe 当前是哪个账号
 *   node vibe_login.mjs --config test_fresh_config.json          # 只登录取 token（不改配置）
 *   node vibe_login.mjs --config test_fresh_config.json --apply  # 切换（Vibe 会自动关闭并重开）
 *   node vibe_login.mjs --email a@b.c [--password xxx] --apply
 *   node vibe_login.mjs --config f.json --apply --no-restart     # 只写配置，稍后自己重开 Vibe
 *   node vibe_login.mjs --config f.json --dry-run                # 只验证登录，什么都不写
 *   node vibe_login.mjs --exe "D:\...\Vibe.exe" --user-data-dir "D:\tmp\profile" --check
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadAccounts } from './mistral_accounts.mjs';

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const argOf = (key, def = null) => {
  const i = argv.indexOf(key);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = (k) => argv.includes(k);

const APPLY = has('--apply');
const DETACHED = has('--apply-detached');
const CHECK = has('--check');
const DRY = has('--dry-run');
const NO_RESTART = has('--no-restart');
const JSON_OUT = has('--json');
const EXE_ARG = argOf('--exe');
const DATA_ARG = argOf('--user-data-dir');
const LOG_FILE = argOf('--log-file', path.join(process.cwd(), 'vibe_login_last.json'));
const TOKENS_FILE = argOf('--tokens-file');

const IMAGE = argOf('--image', 'Vibe.exe');
const OIDC = {
  issuer: 'https://auth.mistral.ai',
  clientId: '88df79e3-3a98-4624-92fe-c607ecf06f1d',
  audience: 'https://api.mistral.ai',
  scope: 'openid email profile offline_access',
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const log = (msg) => { if (!JSON_OUT) console.log(`[Vibe] ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 小工具 ---------------- */
function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function decodeJwt(token) {
  try {
    const p = token.split('.')[1];
    return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch { return null; }
}

/* ---------------- 定位 Vibe ---------------- */
function findExe() {
  if (EXE_ARG) {
    if (!existsSync(EXE_ARG)) throw new Error(`指定的 Vibe.exe 不存在: ${EXE_ARG}`);
    return EXE_ARG;
  }
  const local = process.env.LOCALAPPDATA || '';
  const cands = [
    path.join(local, 'Programs', 'le-chat-desktop', IMAGE),
    path.join(local, 'Programs', 'mistral-vibe', IMAGE),
    path.join(local, 'Programs', 'Vibe', IMAGE),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Vibe', IMAGE),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Vibe', IMAGE),
  ];
  const hit = cands.find((p) => p && existsSync(p));
  if (!hit) throw new Error('找不到 Vibe.exe，请用 --exe 指定路径');
  return hit;
}

function findUserDataDir() {
  if (DATA_ARG) return DATA_ARG;
  const roaming = process.env.APPDATA || '';
  const preferred = path.join(roaming, 'le-chat-desktop');
  if (existsSync(path.join(preferred, 'config.json'))) return preferred;
  // 兜底：扫描 %APPDATA% 下带 config.json + Local State 的目录
  try {
    for (const name of readdirSync(roaming)) {
      const dir = path.join(roaming, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
        const cfg = path.join(dir, 'config.json');
        const ls = path.join(dir, 'Local State');
        if (existsSync(cfg) && existsSync(ls) && readFileSync(cfg, 'utf8').includes('desktopAuthMethod')) return dir;
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  throw new Error('找不到 Vibe 用户数据目录（可用 --user-data-dir 指定）');
}

function pidsOf(image = IMAGE) {
  try {
    const out = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 10000 });
    return (out.stdout || '')
      .split(/\r?\n/)
      .map((l) => (l.match(/^"([^"]+)","(\d+)"/) || [])[2])
      .filter(Boolean)
      .map(Number);
  } catch { return []; }
}

async function waitExit(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pidsOf().length === 0) return true;
    await sleep(400);
  }
  return pidsOf().length === 0;
}

function killImage(force) {
  spawnSync('taskkill', force ? ['/F', '/IM', IMAGE] : ['/IM', IMAGE], { encoding: 'utf8', timeout: 15000 });
}

function launchVibe(exe) {
  const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}

/* ---------------- DPAPI / OSCrypt ---------------- */
function powershellUnprotect(buf) {
  const stamp = `${process.pid}_${Date.now()}`;
  const inFile = path.join(tmpdir(), `vibe_dpapi_in_${stamp}.bin`);
  const outFile = path.join(tmpdir(), `vibe_dpapi_out_${stamp}.bin`);
  writeFileSync(inFile, buf);
  const ps = [
    'Add-Type -AssemblyName System.Security',
    `$b=[IO.File]::ReadAllBytes('${inFile.replace(/'/g, "''")}')`,
    '$d=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    `[IO.File]::WriteAllBytes('${outFile.replace(/'/g, "''")}',$d)`,
  ].join('; ');
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 30000 });
    if (!existsSync(outFile)) {
      throw new Error(`DPAPI 解密失败（${(r.stderr || '').trim().split('\n')[0] || 'no output'}）`);
    }
    return readFileSync(outFile);
  } finally {
    try { rmSync(inFile, { force: true }); } catch { /* ignore */ }
    try { rmSync(outFile, { force: true }); } catch { /* ignore */ }
  }
}

/** 读取本机 OSCrypt 密钥（32 字节，用于 "v10" AES-256-GCM） */
function oscryptKey(userData) {
  const ls = readJson(path.join(userData, 'Local State'));
  const b64 = ls?.os_crypt?.encrypted_key;
  if (!b64) throw new Error('Local State 里没有 os_crypt.encrypted_key');
  const raw = Buffer.from(b64, 'base64');
  if (raw.subarray(0, 5).toString() !== 'DPAPI') throw new Error(`未知的密钥封装: ${raw.subarray(0, 5).toString()}`);
  const key = powershellUnprotect(raw.subarray(5));
  if (key.length !== 32) throw new Error(`OSCrypt 密钥长度异常: ${key.length}`);
  return key;
}

function encryptSecret(key, plaintext) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final()]);
  return Buffer.concat([Buffer.from('v10'), nonce, ct, c.getAuthTag()]).toString('base64');
}

function decryptSecret(key, b64) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.subarray(0, 3).toString() !== 'v10') throw new Error('密文前缀不是 v10');
  const nonce = buf.subarray(3, 15);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(15, buf.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/* ---------------- 读 / 写 Vibe 登录态 ---------------- */
export function readVibeAccount(userData) {
  const cfgPath = path.join(userData, 'config.json');
  const cfg = readJson(cfgPath) || {};
  const stored = cfg.authOidcTokens;
  const out = {
    config: cfgPath,
    method: cfg.desktopAuthMethod || null,
    has_tokens: !!stored,
    email: null,
    sub: null,
    access_exp: null,
    refresh_exp: null,
    error: null,
  };
  if (!stored) { out.error = 'config.json 里没有 authOidcTokens'; return out; }
  try {
    const key = oscryptKey(userData);
    const raw = stored.kind === 'plaintext' ? stored.value : decryptSecret(key, stored.value);
    const parsed = JSON.parse(raw);
    const t = parsed.tokens || {};
    out.access_exp = t.expiresAt ? new Date(t.expiresAt).toISOString() : null;
    out.id_exp = t.idTokenExpiresAt ? new Date(t.idTokenExpiresAt).toISOString() : null;
    if (t.idToken) {
      const p = decodeJwt(t.idToken);
      out.email = p?.email || null;
      out.sub = p?.sub || null;
      out.refresh_exp = p?.exp ? new Date(p.exp * 1000).toISOString() : null;
    }
    out.version = parsed.version ?? null;
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

export function writeVibeTokens(userData, tokens) {
  const cfgPath = path.join(userData, 'config.json');
  if (!existsSync(cfgPath)) throw new Error(`config.json 不存在: ${cfgPath}`);
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const key = oscryptKey(userData);
  const payload = {
    tokens: {
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      idToken: tokens.idToken,
      idTokenExpiresAt: tokens.idTokenExpiresAt,
      refreshToken: tokens.refreshToken,
    },
    version: 2,
  };
  const backup = `${cfgPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(cfgPath, backup);
  cfg.authOidcTokens = { kind: 'encrypted', value: encryptSecret(key, JSON.stringify(payload)) };
  cfg.desktopAuthMethod = 'oidc';
  delete cfg.authSessionToken;          // 旧版 session token 方式，留着会盖掉 OIDC
  delete cfg.desktopAuthLogoutPending;  // 若上次退出登录未完成，会让 App 直接进登录页
  const tmp = `${cfgPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  renameSync(tmp, cfgPath);
  return { backup, email: decodeJwt(tokens.idToken)?.email || null };
}

/* ---------------- OIDC 登录（纯 HTTP） ---------------- */
function makeJar() {
  const jar = new Map();
  return {
    jar,
    cookieHeader() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); },
    absorb(res) {
      const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const c of list) {
        const pair = c.split(';')[0];
        const i = pair.indexOf('=');
        if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    },
  };
}

function makeClient(jar, timeoutMs = 25000) {
  return async function req(url, { method = 'GET', body, accept = 'application/json', headers = {} } = {}) {
    const h = { 'user-agent': UA, accept, ...headers };
    const ck = jar.cookieHeader();
    if (ck) h.cookie = ck;
    if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
    const started = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`请求超时 ${timeoutMs}ms`)), timeoutMs);
    let r;
    try { r = await fetch(url, { method, headers: h, body, redirect: 'manual', signal: ac.signal }); }
    finally { clearTimeout(timer); }
    jar.absorb(r);
    if (process.env.VIBE_DEBUG) console.error(`  [net] ${String(method).padEnd(4)} ${r.status} ${Date.now() - started}ms ${String(url).slice(0, 95)}`);
    return r;
  };
}

const csrfFrom = (text) => (text.match(/"name":"csrf_token"[\s\S]{0,2000}?"value":"([^"]+)"/) || [])[1];
const flowFrom = (text) => (text.match(/"id":"([0-9a-f-]{36})"/) || [])[1];
const errorText = (text) => {
  try {
    const j = JSON.parse(text);
    return [...(j.ui?.messages || []), ...(j.ui?.nodes || []).flatMap((n) => n.messages || [])].map((m) => m.text).filter(Boolean).join('；') || j.error?.message || '';
  } catch { return ''; }
};

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/**
 * 纯 HTTP OIDC 登录：返回 { accessToken, refreshToken, idToken, expiresAt, idTokenExpiresAt, email }
 */
export async function oidcLogin(email, password, onStep = () => {}) {
  const jar = makeJar();
  const req = makeClient(jar);
  const port = await freePort();
  const redirectUri = `http://127.0.0.1:${port}/auth/oidc/callback`;
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  const authUrl = new URL(`${OIDC.issuer}/oauth2/auth`);
  for (const [k, v] of Object.entries({
    audience: OIDC.audience,
    client_id: OIDC.clientId,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    nonce: crypto.randomBytes(16).toString('base64url'),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: OIDC.scope,
    state: crypto.randomBytes(8).toString('hex'),
  })) authUrl.searchParams.set(k, v);

  onStep('authorize');
  let url = authUrl.href;
  let code = null;
  for (let hop = 0; hop < 14 && !code; hop++) {
    const r = await req(url, { accept: 'text/html' });
    const loc = r.headers.get('location');
    if (!loc) {
      const u = new URL(url);
      if (u.pathname === '/consent') {
        onStep('consent');
        const ch = u.searchParams.get('consent_challenge');
        const ar = await req('https://v2.auth.mistral.ai/api/consent/accept', {
          method: 'POST',
          body: JSON.stringify({ consentChallenge: ch, remember: true }),
          headers: { 'content-type': 'application/json', origin: 'https://v2.auth.mistral.ai', referer: u.href },
        });
        const aj = await ar.json().catch(() => ({}));
        if (!aj.redirect_to) throw new Error(`同意授权失败（HTTP ${ar.status}）${aj.error || ''}`);
        url = aj.redirect_to;
        continue;
      }
      const html = await r.text();
      throw new Error(`OIDC 流程卡在 ${u.origin}${u.pathname}（HTTP ${r.status}）：${html.slice(0, 160).replace(/\s+/g, ' ')}`);
    }
    const next = new URL(loc, url);
    if (next.origin === `http://127.0.0.1:${port}`) {
      const err = next.searchParams.get('error');
      if (err) throw new Error(`授权被拒绝: ${err} ${next.searchParams.get('error_description') || ''}`);
      code = next.searchParams.get('code');
      break;
    }
    url = next.href;
    const nu = new URL(url);
    if (nu.pathname === '/login' && nu.searchParams.get('flow')) {
      onStep('login');
      const flow = nu.searchParams.get('flow');
      let t = await (await req(`${OIDC.issuer}/self-service/login?flow=${flow}`)).text();
      const csrf = csrfFrom(t);
      if (!csrf) throw new Error('登录页缺少 csrf_token');
      const post = (payload, csrfToken) => req(`${OIDC.issuer}/self-service/login?flow=${flow}`, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: {
          'content-type': 'application/json',
          origin: 'https://v2.auth.mistral.ai',
          referer: 'https://v2.auth.mistral.ai/',
        },
      });
      let rr = await post({ csrf_token: csrf, method: 'identifier_first', identifier: email, transient_payload: {} }, csrf);
      t = await rr.text();
      const csrf2 = csrfFrom(t);
      if (!csrf2) {
        // identifier_first 阶段拿不到 csrf：403 基本都是上游风控/限流（短时间登录太多次），
        // 而不是密码错误（密码错会走到 password 步骤再报错）。
        if (rr.status === 403 || rr.status === 429) {
          throw new Error(
            `Mistral 登录限流（HTTP ${rr.status}）：短时间内登录太频繁被临时拦截。` +
            `请稍等 10-30 分钟再试；已有的渠道不受影响，可继续用 API 调用。`
          );
        }
        throw new Error(`账号识别失败: ${errorText(t) || `HTTP ${rr.status}`}`);
      }
      rr = await post({ csrf_token: csrf2, method: 'password', identifier: email, password }, csrf2);
      t = await rr.text();
      let j = null;
      try { j = JSON.parse(t); } catch { /* ignore */ }
      let nx = j?.error?.details?.redirect_browser_to || j?.continue_with?.find((x) => x.action === 'redirect_browser_to')?.redirect_browser_to;
      if (!nx && j?.error?.reason) {
        const m = j.error.reason.match(/https:\/\/[^\s]+/);
        if (m) nx = m[0];
      }
      if (!nx) {
        const msg = errorText(t) || `HTTP ${rr.status}`;
        const inactive = /not active|verify your email/i.test(msg);
        throw new Error(`登录失败: ${msg}${inactive ? '（账号未激活，需先验证邮箱）' : ''}`);
      }
      url = nx;
    }
  }
  if (!code) throw new Error('OIDC 流程未拿到授权码');

  onStep('token');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: OIDC.clientId,
    code_verifier: verifier,
  });
  const tr = await fetch(`${OIDC.issuer}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': UA },
    body,
  });
  const tj = await tr.json().catch(() => ({}));
  if (!tj.access_token) throw new Error(`换取 token 失败（HTTP ${tr.status}）：${tj.error_description || tj.error || ''}`);

  const idp = tj.id_token ? decodeJwt(tj.id_token) : null;
  if (idp?.email && idp.email.toLowerCase() !== email.toLowerCase()) {
    throw new Error(`换到的 token 属于 ${idp.email}，与目标 ${email} 不一致`);
  }
  const now = Date.now();
  // jar 里通常已有 ory_session_* —— chat.mistral.ai 的 newChat 需要它来确定组织上下文，
  // 光有 idToken 会 403 "This product surface is not available for your organization"
  const cookieHeader = jar.cookieHeader();
  const cookies = {};
  for (const [k, v] of jar.jar) cookies[k] = v;
  return {
    accessToken: tj.access_token,
    refreshToken: tj.refresh_token || null,
    idToken: tj.id_token || null,
    expiresAt: now + (Number(tj.expires_in || 3600) * 1000),
    idTokenExpiresAt: idp?.exp ? idp.exp * 1000 : now + 3600 * 1000,
    scope: tj.scope || OIDC.scope,
    email: idp?.email || email,
    sub: idp?.sub || null,
    cookie: cookieHeader || null,
    cookies,
  };
}

/* ---------------- 账号解析 ---------------- */
function resolveAccount() {
  const cfgFile = argOf('--config');
  const emailArg = argOf('--email', argOf('--account'));
  let email = emailArg;
  let password = argOf('--password');
  let source = emailArg ? '--email' : null;

  if (cfgFile) {
    if (!existsSync(cfgFile)) throw new Error(`配置文件不存在: ${cfgFile}`);
    const cfg = readJson(cfgFile) || {};
    email = cfg.email || email;
    password = password || cfg.password || null;
    source = cfgFile;
  }
  if (!email) throw new Error('需要 --config <配置文件> 或 --email <邮箱>');
  if (!password) {
    const all = loadAccounts();
    const rec = all[email] || Object.values(all).find((a) => a.email === email);
    password = rec?.password || null;
  }
  if (!password) throw new Error(`账号 ${email} 没有密码（配置/accounts.json 里都没有，可用 --password 指定）`);
  return { email, password, source };
}

/* ---------------- detached 收尾进程 ---------------- */
async function runDetached() {
  const result = {
    started_at: new Date().toISOString(),
    pid: process.pid,
    tokens_file: TOKENS_FILE,
    user_data: DATA_ARG,
    exe: EXE_ARG,
    steps: [],
  };
  const step = (name, extra = {}) => { result.steps.push({ at: new Date().toISOString(), name, ...extra }); };
  try {
    if (!TOKENS_FILE || !existsSync(TOKENS_FILE)) throw new Error('缺少 --tokens-file');
    const tokens = JSON.parse(readFileSync(TOKENS_FILE, 'utf8'));
    const userData = DATA_ARG || findUserDataDir();
    const exe = EXE_ARG || findExe();
    result.user_data = userData;
    result.exe = exe;

    // 1) 等 Vibe 自己退出（用户点关闭/或上一个流程）
    step('wait_exit');
    let exited = await waitExit(Number(argOf('--wait', '12000')));
    if (!exited) { step('kill_graceful'); killImage(false); exited = await waitExit(6000); }
    if (!exited) { step('kill_force'); killImage(true); exited = await waitExit(6000); }
    result.exited = exited;
    if (!exited) throw new Error('Vibe 无法退出，放弃写入（避免退出时被覆盖）');
    await sleep(1200); // 等 Electron 落盘/句柄释放

    // 2) 写配置（先备份）
    step('write_config');
    const w = writeVibeTokens(userData, tokens);
    result.backup = w.backup;
    result.email = w.email;

    // 3) 校验写回
    step('verify');
    const check = readVibeAccount(userData);
    result.verified_email = check.email;
    result.verified_error = check.error;

    // 4) 重新启动
    step('launch');
    launchVibe(exe);
    result.relaunched_at = new Date().toISOString();
    result.ok = check.email && check.email.toLowerCase() === (tokens.email || '').toLowerCase();
    try { rmSync(TOKENS_FILE, { force: true }); } catch { /* ignore */ }
  } catch (e) {
    result.ok = false;
    result.error = e.message;
    step('error', { message: e.message });
  }
  writeFileSync(LOG_FILE, JSON.stringify(result, null, 2));
  if (!JSON_OUT) {
    console.log(`[Vibe] 收尾完成: ${result.ok ? '成功' : '失败'}${result.error ? ' — ' + result.error : ''}`);
    console.log(`[Vibe] 日志: ${LOG_FILE}`);
  }
}

/* ---------------- 主流程 ---------------- */
async function main() {
  if (DETACHED) return runDetached();

  if (CHECK) {
    const exe = (() => { try { return findExe(); } catch { return null; } })();
    const userData = DATA_ARG || (() => { try { return findUserDataDir(); } catch { return null; } })();
    if (!userData) throw new Error('找不到 Vibe 数据目录');
    const info = readVibeAccount(userData);
    if (JSON_OUT) { console.log(JSON.stringify({ exe, data: userData, running_pids: pidsOf(), ...info }, null, 2)); return; }
    log(`安装: ${exe || '(未找到 Vibe.exe)'}`);
    log(`数据: ${userData}`);
    log(`登录方式: ${info.method || '(未设置)'}`);
    if (info.error) log(`读取失败: ${info.error}`);
    else log(`当前账号: ${info.email || '(未知)'}  (access 到期 ${info.access_exp || '?'})`);
    const running = pidsOf();
    log(`运行中: ${running.length ? '是 (PID ' + running.join(',') + ')' : '否'}`);
    return;
  }

  const acc = resolveAccount();
  log(`目标账号: ${acc.email}${acc.source ? `（来源 ${acc.source}）` : ''}`);
  log('纯 HTTP 走 OIDC 授权码流程（约 3-6 秒）…');
  const stepNames = { authorize: '发起 OIDC 授权', login: '邮箱密码登录', consent: '同意授权', token: '换取 token' };
  const tokens = await oidcLogin(acc.email, acc.password, (s) => log(`  · ${stepNames[s] || s}`));
  log(`拿到 token: ${tokens.email}  sub=${tokens.sub || '?'}  access 到期 ${new Date(tokens.expiresAt).toISOString()}`);

  if (DRY) { log('--dry-run：不写任何文件'); return; }

  if (!APPLY) {
    log('未加 --apply，只做了登录验证（配置未修改）。加 --apply 才会写入 Vibe 并重启。');
    return;
  }

  const userData = DATA_ARG || findUserDataDir();
  const exe = EXE_ARG || findExe();

  if (NO_RESTART) {
    const w = writeVibeTokens(userData, tokens);
    log(`已写入 ${userData}\\config.json（备份 ${path.basename(w.backup)}），请手动退出并重新打开 Vibe 生效`);
    return;
  }

  // detached：先落 token 到临时文件，再交给子进程去"关 Vibe → 写配置 → 重开"
  const tmpTokens = path.join(tmpdir(), `vibe_tokens_${Date.now()}.json`);
  writeFileSync(tmpTokens, JSON.stringify(tokens, null, 2));
  const child = spawn(process.execPath, [
    fileURLToPath(import.meta.url),
    '--apply-detached',
    '--tokens-file', tmpTokens,
    '--user-data-dir', userData,
    '--exe', exe,
    '--image', IMAGE,
    '--log-file', LOG_FILE,
  ], { detached: true, stdio: 'ignore', cwd: process.cwd() });
  child.unref();

  log(`即将切换：Vibe 会在 ~2 秒后自动关闭，再用 ${tokens.email} 重新打开（约 5-8 秒）`);
  log(`收尾进程 PID ${child.pid}，结果写入 ${LOG_FILE}`);
  log('提示：当前窗口/Vibe 里的终端会一起关闭，属正常现象；重开后可用 --check 确认账号。');

  await sleep(1200);
  // 若本进程被 Vibe 一起带走也没关系：detached 子进程会继续完成任务
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  // 显式退出：undici 的 keep-alive 连接会让进程挂住（Windows 上尤其明显）
  const done = (code) => process.stdout.write('', () => process.exit(code));
  main().then(() => done(0)).catch((e) => {
    console.error(`[Vibe] 失败: ${e.message}`);
    done(1);
  });
}
