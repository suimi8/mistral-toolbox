/**
 * 账号登记表（accounts.json）+ 浏览器可导入的登录 cookie 导出。
 *
 * - upsertAccount(config, configFile)：把账号信息（邮箱/密码/身份/地址/卡/会话）
 *   合并写入 accounts.json（按 email 为键），并同步导出 cookie 文件。
 * - exportCookieFiles(email, cookies)：导出两种浏览器可直接导入的格式：
 *     cookies/<email>.txt   — Netscape cookies.txt（curl / Get cookies.txt 扩展）
 *     cookies/<email>.json  — Cookie-Editor / EditThisCookie JSON
 *   导入后即可直接打开 chat.mistral.ai / admin.mistral.ai（已登录状态）。
 *
 * 登录会话 cookie（ory_session_*）实测属性：
 *   Path=/; Domain=mistral.ai; Max-Age=7775999（约 90 天）; HttpOnly; Secure; SameSite=Lax
 *   value 为 base64("<签发时间戳>|...")，可据此推算过期时间。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, statSync } from 'fs';

const ACCOUNTS_PATH = 'accounts.json';
const COOKIE_DIR = 'cookies';
const SESSION_MAX_AGE = 7775999; // 与 Kratos Set-Cookie 的 Max-Age 一致（约 90 天）

/** 同步睡眠（并发写 accounts.json 时自旋等待锁） */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) { /* busy wait */ } }
}

/**
 * 跨进程文件锁（防止并发注册时 accounts.json 读-改-写互相覆盖）。
 * 用 O_EXCL 创建锁文件；超过 15s 未释放视为陈旧锁自动清除。
 * 返回释放函数；超时返回 null（调用方应跳过本次写入并告警）。
 */
function acquireLock(timeoutMs = 15000) {
  const lock = `${ACCOUNTS_PATH}.lock`;
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(lock, 'wx');
      closeSync(fd);
      return () => { try { unlinkSync(lock); } catch { /* 已被清理 */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 15000) unlinkSync(lock); // 陈旧锁
      } catch { /* 锁已被别人释放 */ }
      if (Date.now() - start >= timeoutMs) return null;
      sleepSync(40);
    }
  }
}

export function loadAccounts() {
  try {
    return existsSync(ACCOUNTS_PATH) ? JSON.parse(readFileSync(ACCOUNTS_PATH, 'utf8')) : {};
  } catch {
    return {};
  }
}

/** 从 ory_session_* 的 value（base64 首段为签发时间戳）推算 cookie 过期时间（Unix 秒） */
export function cookieExpiry(name, value) {
  if (/^ory_session_/i.test(name)) {
    try {
      const dec = Buffer.from(String(value), 'base64').toString('utf8');
      const ts = Number(dec.split('|')[0]);
      if (Number.isFinite(ts) && ts > 1e9) return ts + SESSION_MAX_AGE;
    } catch { /* fallthrough */ }
  }
  return Math.floor(Date.now() / 1000) + SESSION_MAX_AGE;
}

/**
 * 合并写入 accounts.json（以 email 为键，保留旧字段）。
 * 新会话 cookies 为空时保留旧会话（避免无会话的写入清掉已存登录信息）。
 * 返回该账号记录；email 为空返回 null。
 */
export function upsertAccount(config, configFile) {
  if (!config?.email) return null;
  const release = acquireLock();
  if (!release) {
    // 拿不到锁：退化为直接写（宁可丢一次登记也不阻塞主流程），但给出告警
    console.warn('[WARN] accounts.json 锁获取超时，本次登记可能与其他并发写入冲突');
  }
  try {
    const all = loadAccounts();
    const prev = all[config.email] || {};
    const cookies = config.session?.cookies || {};
    const hasNewCookies = Object.keys(cookies).length > 0;
    const rec = {
      ...prev,
      email: config.email,
      password: config.password ?? prev.password ?? null,
      identity_id: config.identity_id ?? prev.identity_id ?? null,
      first: config.first ?? prev.first ?? null,
      last: config.last ?? prev.last ?? null,
      registered_at: config.registered_at ?? prev.registered_at ?? null,
      mailbox: config.mailbox ?? prev.mailbox ?? null,
      address: config.address ?? prev.address ?? null,
      card: config.card ?? prev.card ?? null,
      promo_code: config.promo_code ?? prev.promo_code ?? null,
      pro: config.pro ?? prev.pro ?? null,
      pro_plan: config.pro_plan ?? prev.pro_plan ?? null,
      pro_checked_at: config.pro_checked_at ?? prev.pro_checked_at ?? null,
      in_pool: config.in_pool ?? prev.in_pool ?? null,
      // 账号体检（account_inspect.mjs）字段：会话有效性 / 额度 / 用量
      valid: config.valid ?? prev.valid ?? null,
      valid_checked_at: config.valid_checked_at ?? prev.valid_checked_at ?? null,
      budget: config.budget ?? prev.budget ?? null,
      library_usage: config.library_usage ?? prev.library_usage ?? null,
      quota_checked_at: config.quota_checked_at ?? prev.quota_checked_at ?? null,
      config_file: configFile ?? prev.config_file ?? null,
      session: hasNewCookies
        ? { cookies, saved_at: config.session?.saved_at || new Date().toISOString() }
        : (prev.session || null),
      updated_at: new Date().toISOString(),
    };
    all[config.email] = rec;
    // 原子写：先写临时文件再改名，避免并发读到半截 JSON
    const tmp = `${ACCOUNTS_PATH}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(all, null, 2));
    try { writeFileSync(ACCOUNTS_PATH, readFileSync(tmp, 'utf8')); unlinkSync(tmp); }
    catch { try { unlinkSync(tmp); } catch { /* ignore */ } }
    if (hasNewCookies) {
      try { exportCookieFiles(config.email, cookies); } catch { /* 导出失败不影响登记 */ }
    }
    return rec;
  } finally {
    if (release) release();
  }
}

/** 导出 Netscape txt + Cookie-Editor json 到 cookies/ 目录，返回两个文件路径 */
export function exportCookieFiles(email, cookies) {
  if (!email || !cookies || !Object.keys(cookies).length) return null;
  mkdirSync(COOKIE_DIR, { recursive: true });
  const safe = String(email).replace(/[^\w.@-]/g, '_');

  // Netscape HTTP Cookie File（tab 分隔：domain includeSubdomain path secure expiry name value）
  const lines = ['# Netscape HTTP Cookie File', `# Mistral session export ${new Date().toISOString()}`];
  for (const [name, value] of Object.entries(cookies)) {
    lines.push(`.mistral.ai\tTRUE\t/\tTRUE\t${cookieExpiry(name, value)}\t${name}\t${value}`);
  }
  const txtPath = `${COOKIE_DIR}/${safe}.txt`;
  writeFileSync(txtPath, lines.join('\n') + '\n');

  // Cookie-Editor / EditThisCookie 兼容 JSON
  const json = Object.entries(cookies).map(([name, value]) => ({
    name,
    value,
    domain: '.mistral.ai',
    path: '/',
    expirationDate: cookieExpiry(name, value),
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    session: false,
  }));
  const jsonPath = `${COOKIE_DIR}/${safe}.json`;
  writeFileSync(jsonPath, JSON.stringify(json, null, 2));
  return { txtPath, jsonPath };
}
