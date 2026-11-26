#!/usr/bin/env node
/**
 * gui.mjs — Mistral 控制台（本地 Web GUI，零额外依赖，只用 Node 内置模块）
 *
 * 用法:
 *   node gui.mjs                 # 启动并自动打开浏览器（默认 http://127.0.0.1:8890）
 *   node gui.mjs --port 9000     # 自定义端口
 *   node gui.mjs --no-open       # 不自动打开浏览器
 *   node gui.mjs --no-autostart  # 启动时不自动拉起反代（默认自动拉起 8899）
 *
 * 端口约定: 8899 = reverse_proxy.mjs，8890 = 本 GUI（与其它本地服务错开）。
 *
 * 功能:
 *   - 批量注册（batch_register.mjs）：数量 / 并发 / 优惠码 / 代理 / 跳过项 / 演练 + 实时日志 + 进度
 *   - 卡池管理（cards.txt）：粘贴卡号、Luhn 校验、去重、保存（batch_register 自动收集 cards*.txt）
 *   - 账号库（accounts.json）：只读展示（密码 / CVC 不下发浏览器）+ 账号体检
 *     （account_inspect.mjs：会话有效性 whoami + 套餐 + 月度额度 billing.budget + 知识库用量）
 *   - token 用量统计：反代按请求记录（字符估算，落盘 usage_stats.json），GUI /api/usage 聚合展示
 *   - 单账号流水线 / 登录导出 / 重测冷却卡
 *   - 对话反代（reverse_proxy.mjs）启动 / 停止；账号池状态与热更新联动
 *   - 注册、反代一体：batch / pipeline / login / procheck 任务成功收尾后，
 *     自动通知运行中的反代重读 accounts.json（reverse_proxy 自身另有 mtime 轮询兜底）
 *   - 运行日志（batch_logs/*.log）与 batch_results.json 历史
 *
 * 说明:
 *   - 仅监听 127.0.0.1，不对外网开放。
 *   - 所有子进程 cwd 为本项目目录；停止任务时用 taskkill /T 杀进程树。
 */
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
process.chdir(ROOT);

const argv = process.argv.slice(2);
const argOf = (key, def) => {
  const i = argv.indexOf(key);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const PORT = Math.max(1, parseInt(argOf('--port', '8890'), 10) || 8890);
const HOST = '127.0.0.1';
const AUTO_OPEN = !argv.includes('--no-open');
// 默认启动即自动拉起反代（8899）；--no-autostart 关闭
const AUTO_START_PROXY = !argv.includes('--no-autostart');

/* ============================== 通用工具 ============================== */
const json = (res, code, obj) => {
  if (res.writableEnded) return;
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
};

const readBody = (req, limit = 2 * 1024 * 1024) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on('data', (d) => {
    size += d.length;
    if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
    chunks.push(d);
  });
  req.on('end', () => {
    try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
    catch { reject(new Error('JSON 解析失败')); }
  });
  req.on('error', reject);
});

/* ============================== 卡号解析 ============================== */
const luhn = (num) => {
  let sum = 0;
  let alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = Number(num[i]);
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
};

/**
 * 兼容 batch_register 的卡行格式：
 *   卡号|MM|YYYY|CVC
 *   卡号|MM/YY|CVC
 *   卡号（可含空格/短横线分组） MM YY CVC
 */
function parseCardLine(raw) {
  const s = String(raw || '').trim();
  if (!s || s.startsWith('#')) return { skip: true };
  const tokens = s.split(/[|,;\t]+|\s+/).filter(Boolean);
  // 合并前导纯数字段作为卡号（支持 "卡号 按 4 位 分 组" 写法）
  let number = '';
  while (tokens.length && /^[\d-]+$/.test(tokens[0])) {
    number += tokens[0].replace(/-/g, '');
    tokens.shift();
    if (number.length >= 12) break;
  }
  number = number.replace(/\D/g, '');
  if (!/^\d{12,19}$/.test(number)) return { error: '卡号需为 12-19 位数字' };
  if (tokens.length < 2) return { error: '缺少有效期 / CVC' };
  let mm, yy, cvc;
  const t1 = tokens[0] || '';
  if (t1.includes('/')) {
    const [a, b] = t1.split('/');
    mm = a; yy = b; cvc = tokens[1];
  } else {
    mm = t1; yy = tokens[1]; cvc = tokens[2];
  }
  // 先报字段格式错误，最后才报 Luhn——错误更直接
  if (!/^\d{1,2}$/.test(mm || '') || Number(mm) < 1 || Number(mm) > 12) return { error: '月份无效（须为 01-12）' };
  if (!/^\d{2,4}$/.test(yy || '')) return { error: '年份无效（YY 或 YYYY）' };
  if (!/^\d{3,4}$/.test(cvc || '')) return { error: 'CVC 无效（3-4 位数字）' };
  if (!luhn(number)) return { error: 'Luhn 校验失败（卡号校验位不对）' };
  yy = yy.length === 2 ? '20' + yy : yy;
  return { card: { number, exp_month: String(mm).padStart(2, '0'), exp_year: yy, cvc } };
}

function parseCardsText(text) {
  const valid = [];
  const invalid = [];
  const seen = new Set();
  let dup = 0;
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const r = parseCardLine(line);
    if (r.error) { invalid.push({ line: i + 1, text: line.slice(0, 80), why: r.error }); return; }
    if (seen.has(r.card.number)) { dup++; return; }
    seen.add(r.card.number);
    valid.push(r.card);
  });
  return { valid, invalid, dup };
}

/* ============================== 数据读取 ============================== */
function readAccounts() {
  try { return JSON.parse(readFileSync('accounts.json', 'utf8')); } catch { return {}; }
}

function accountsView() {
  const acc = readAccounts();
  return Object.values(acc)
    .map((a) => ({
      email: a.email || null,
      first: a.first || null,
      last: a.last || null,
      registered_at: a.registered_at || null,
      updated_at: a.updated_at || null,
      cardLast4: a.card?.number ? String(a.card.number).slice(-4) : null,
      config_file: a.config_file || null,
      session: !!a.session?.saved_at,
      session_at: a.session?.saved_at || null,
      pro: a.pro === true ? true : a.pro === false ? false : null,
      pro_plan: a.pro_plan || null,
      pro_checked_at: a.pro_checked_at || null,
      in_pool: a.in_pool === true,
      valid: a.valid === true ? true : a.valid === false ? false : null,
      valid_checked_at: a.valid_checked_at || null,
      budget: a.budget || null,
      library_usage: a.library_usage || null,
      quota_checked_at: a.quota_checked_at || null,
    }))
    .sort((x, y) => String(y.registered_at || '').localeCompare(String(x.registered_at || '')));
}

function configList() {
  try {
    return readdirSync(ROOT)
      .filter((f) => /^(mistral_config\.json|test_.*_config\.json)$/.test(f))
      .sort()
      .map((f) => {
        let email = null;
        let registered_at = null;
        try {
          const j = JSON.parse(readFileSync(f, 'utf8'));
          email = j.email || null;
          registered_at = j.registered_at || null;
        } catch { /* ignore */ }
        return { file: f, email, registered_at };
      });
  } catch { return []; }
}

function cardFiles() {
  try { return readdirSync(ROOT).filter((f) => /^cards.*\.(txt|csv)$/i.test(f)).sort(); }
  catch { return []; }
}

/** 与 batch_register.mjs 相同的卡池口径：排除 accounts.json 已用卡 + 池内去重 */
function computePool() {
  const used = new Set();
  for (const r of Object.values(readAccounts())) {
    if (r?.card?.number) used.add(String(r.card.number));
  }
  const seen = new Set();
  const pool = [];
  const files = cardFiles();
  for (const f of files) {
    let txt = '';
    try { txt = readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    for (const line of txt.split(/\r?\n/)) {
      const r = parseCardLine(line);
      if (r.skip || r.error) continue;
      const n = r.card.number;
      if (used.has(n) || seen.has(n)) continue;
      seen.add(n);
      pool.push(r.card);
    }
  }
  return { files, pool, used };
}

function cardsState() {
  let content = '';
  try { content = readFileSync('cards.txt', 'utf8'); } catch { /* ignore */ }
  const p = parseCardsText(content);
  const cp = computePool();
  // 已用卡：只读、脱敏（只下发尾号），来自 accounts.json
  const usedCards = Object.values(readAccounts())
    .filter((a) => a?.card?.number)
    .map((a) => ({
      email: a.email || null,
      cardLast4: String(a.card.number).slice(-4),
      exp: `${a.card.exp_month}/${a.card.exp_year}`,
      registered_at: a.registered_at || null,
      pro: a.pro === true ? true : a.pro === false ? false : null,
      in_pool: a.in_pool === true,
    }))
    .sort((x, y) => String(y.registered_at || '').localeCompare(String(x.registered_at || '')));
  return {
    content,
    valid: p.valid.length,
    invalid: p.invalid.length,
    dup: p.dup,
    errors: p.invalid.slice(0, 20),
    pool: cp.pool.length,   // 扣除已用卡后的可用数
    used: cp.used.size,     // 已在 accounts.json 使用、被排除的去重卡数
    usedCards,              // 按账号展示的已用卡明细（脱敏，只含尾号）
  };
}

function resultsView() {
  if (!existsSync('batch_results.json')) return { data: null };
  try {
    const d = JSON.parse(readFileSync('batch_results.json', 'utf8'));
    // 不把明文密码下发到浏览器
    if (Array.isArray(d.results)) d.results = d.results.map(({ password, ...rest }) => rest);
    return { data: d };
  } catch { return { data: null }; }
}

/** token 用量统计：聚合 usage_stats.json（反代落盘），并附运行中反代的实时 /admin/usage。
 *  字段口径与 reverse_proxy.mjs usageStats() 一致：新增输入（会话输入增量）/ 缓存命中 / 思考（reasoning 估算）/
 *  首字 / 耗时；byAccount 附 Pro 标记与月度额度剩余（accounts.json 体检所得 budget）。 */
function usageView() {
  let file = null;
  try {
    const j = JSON.parse(readFileSync('usage_stats.json', 'utf8'));
    if (Array.isArray(j.records)) file = j.records;
  } catch { /* 无文件 */ }
  const agg = () => ({
    requests: 0, ok: 0, errors: 0,
    promptChars: 0, completionChars: 0, reasoningChars: 0, newInputChars: 0,
    estPromptTokens: 0, estCompletionTokens: 0, estNewInputTokens: 0, estCachedTokens: 0, estReasoningTokens: 0,
    estTotalTokens: 0, estBilledTokens: 0, // 已用=新增输入+输出（缓存命中不计）
  });
  const add = (t, r) => {
    t.promptChars += r.promptChars || 0;
    t.completionChars += r.completionChars || 0;
    t.reasoningChars += r.reasoningChars || 0;
    t.newInputChars += r.newInputChars || 0;
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
  const dayKey = new Date().toISOString().slice(0, 10);
  for (const r of file || []) {
    for (const t of [total, ...(String(r.ts || '').slice(0, 10) === dayKey ? [today] : [])]) {
      t.requests++;
      if (r.ok) t.ok++; else t.errors++;
      add(t, r);
    }
    const email = r.account || '未知';
    const a = byAccount[email] || (byAccount[email] = agg());
    a.requests++; if (r.ok) a.ok++; else a.errors++;
    add(a, r);
  }
  const accountsMeta = readAccounts();
  for (const [email, a] of Object.entries(byAccount)) {
    const meta = accountsMeta[email] || null;
    a.pro = meta?.pro === true;
    a.blockedFor = 0; // 文件侧无实况冷却；运行中反代优先采用其实时数据
    const b = meta?.budget;
    a.budget = b ? {
      remaining: Math.max(0, Number(b.initial_budget || 0) - Number(b.used_budget || 0)),
      currency: b.currency || 'EUR',
      resetAt: b.reset_at || null,
    } : null;
  }
  return {
    estimated: true,
    source: file ? 'usage_stats.json' : null,
    records: file ? file.length : 0,
    total, today, byAccount,
    recent: (file || []).slice(-50),
  };
}

/** 运行中反代的实时用量（/admin/usage） */
async function proxyUsageStatus() {
  const list = actionTasks('proxy').map((t) => ({ t, port: taskPort(t) }));
  const proxies = await Promise.all(list.map(async ({ t, port }) => {
    try {
      const r = await localFetch(`http://127.0.0.1:${port}/admin/usage`);
      return { taskId: t.id, port, reachable: true, ...(await r.json()) };
    } catch {
      return { taskId: t.id, port, reachable: false };
    }
  }));
  return { proxies };
}

function inspectReport() {
  try { return { data: JSON.parse(readFileSync('inspect_report.json', 'utf8')) }; }
  catch { return { data: null }; }
}

function logsView() {
  const dir = 'batch_logs';
  if (!existsSync(dir)) return { logs: [] };
  const logs = readdirSync(dir)
    .filter((f) => /^reg_\d+\.log$/.test(f))
    .map((f) => {
      const st = statSync(path.join(dir, f));
      return { name: f, size: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
  return { logs };
}

/* ============================== 任务管理 ============================== */
const tasks = new Map();
let taskSeq = 0;
const MAX_LINES = 5000;
const KEEP_FINISHED = 30;

function createTask(action) {
  pruneTasks();
  const id = `t${++taskSeq}-${Date.now().toString(36)}`;
  const t = {
    id,
    action,
    status: 'running',
    exitCode: null,
    startedAt: Date.now(),
    endedAt: null,
    lines: [],
    partial: '',
    listeners: new Set(),
    child: null,
    stopped: false,
  };
  tasks.set(id, t);
  return t;
}

function pruneTasks() {
  const finished = [...tasks.values()].filter((t) => t.status !== 'running');
  if (finished.length <= KEEP_FINISHED) return;
  finished.sort((a, b) => a.startedAt - b.startedAt);
  for (const t of finished.slice(0, finished.length - KEEP_FINISHED)) tasks.delete(t.id);
}

function broadcast(t, msg) {
  const s = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of t.listeners) {
    try { res.write(s); } catch { /* ignore */ }
  }
}

function pushLine(t, line) {
  t.lines.push(line);
  if (t.lines.length > MAX_LINES) t.lines.splice(0, t.lines.length - MAX_LINES);
  broadcast(t, { type: 'line', text: line });
}

function pushChunk(t, chunk) {
  t.partial += chunk;
  let i;
  while ((i = t.partial.indexOf('\n')) >= 0) {
    const line = t.partial.slice(0, i).replace(/\r$/, '');
    t.partial = t.partial.slice(i + 1);
    pushLine(t, line);
  }
}

function flushPartial(t) {
  if (t.partial) {
    pushLine(t, t.partial.replace(/\r$/, ''));
    t.partial = '';
  }
}

function finishTask(t, code) {
  if (t.status !== 'running') return;
  t.exitCode = code;
  t.status = t.stopped ? 'stopped' : (code === 0 ? 'done' : 'failed');
  t.endedAt = Date.now();
  broadcast(t, { type: 'status', status: t.status, exitCode: code });
  // 注册、反代一体：登记/会话类任务成功收尾后，通知运行中的反代热更新账号池（无需重启）
  if (code === 0 && ['batch', 'pipeline', 'login', 'procheck', 'inspect'].includes(t.action)) {
    reloadProxyPools().catch(() => {});
  }
}

function spawnTask(action, script, args) {
  const t = createTask(action);
  const child = spawn(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  t.child = child;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => pushChunk(t, d));
  child.stderr.on('data', (d) => pushChunk(t, d));
  child.on('error', (e) => {
    pushLine(t, `[GUI] 启动失败: ${e.message}`);
    finishTask(t, -1);
  });
  child.on('close', (code) => {
    flushPartial(t);
    finishTask(t, code ?? -1);
  });
  return t;
}

function killTask(t) {
  if (!t.child || t.status !== 'running') return false;
  t.stopped = true;
  try {
    spawn('taskkill', ['/pid', String(t.child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    try { t.child.kill('SIGKILL'); } catch { /* ignore */ }
  }
  return true;
}

function tasksView() {
  return [...tasks.values()]
    .map((t) => ({
      id: t.id,
      action: t.action,
      status: t.status,
      exitCode: t.exitCode,
      startedAt: new Date(t.startedAt).toISOString(),
      endedAt: t.endedAt ? new Date(t.endedAt).toISOString() : null,
    }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/* ============================== 运行参数 ============================== */
function assertConfig(name) {
  const list = configList().map((c) => c.file);
  if (!name || !list.includes(name)) throw new Error('配置文件不存在或未选择');
  return name;
}

function buildRun(action, p) {
  if (action === 'batch') {
    const count = Math.max(1, parseInt(p.count || '5', 10) || 5);
    const conc = Math.min(10, Math.max(1, parseInt(p.concurrency || '3', 10) || 3));
    const { pool, used } = computePool();
    if (!p.skipCard && pool.length < count) {
      throw new Error(`卡池不足：需要 ${count} 张，可用 ${pool.length} 张（另有 ${used.size} 张已在账号库使用、被自动跳过）。请到『卡池管理』粘贴并保存卡号；不绑卡可勾选「跳过绑卡」。`);
    }
    const args = [
      '--count', String(count),
      '--concurrency', String(conc),
      '--promo', String(p.promo || 'MISTRALVIBE').trim() || 'MISTRALVIBE',
      '--timeout', String(Math.max(60, parseInt(p.timeout || '1500', 10) || 1500)),
    ];
    if (p.proxy) args.push('--proxy', String(p.proxy).trim());
    if (p.skipAddress) args.push('--skip-address');
    if (p.skipCard) args.push('--skip-card');
    if (p.skipRedeem) args.push('--skip-redeem');
    if (p.dryRun) args.push('--dry-run');
    return { script: 'batch_register.mjs', args, meta: { count, conc } };
  }
  if (action === 'pipeline') {
    const args = ['--config', assertConfig(p.config)];
    if (p.proxy) args.push('--proxy', String(p.proxy).trim());
    if (p.open) args.push('--open');
    return { script: 'pipeline.mjs', args };
  }
  if (action === 'login') {
    // 优先按邮箱从 accounts.json 取账密（--account）；否则走配置文件
    const args = [];
    if (p.email) args.push('--account', String(p.email));
    else args.push('--config', assertConfig(p.config));
    if (p.proxy) args.push('--proxy', String(p.proxy).trim());
    if (p.fresh) args.push('--fresh');
    if (p.open) args.push('--open');
    return { script: 'mistral_login.mjs', args };
  }
  if (action === 'retest') {
    return { script: 'retest_pending.mjs', args: ['--config', assertConfig(p.config)] };
  }
  if (action === 'proxy') {
    const port = Math.min(65535, Math.max(1024, parseInt(p.port || '8899', 10) || 8899));
    const cfg = p.config && configList().some((c) => c.file === p.config) ? p.config : 'test_pipe_config.json';
    const args = ['--config', cfg, '--port', String(port)];
    if (p.proOnly) args.push('--pro-only');
    // 客户端形态：client_profile.txt = 'desktop' 时 UA 带 LeChat-Desktop 标记（运行中也可热切换）
    try { if (readFileSync('client_profile.txt', 'utf8').trim() === 'desktop') args.push('--client-profile', 'desktop'); } catch { /* 默认 web */ }
    return { script: 'reverse_proxy.mjs', args, meta: { port } };
  }
  if (action === 'vibelogin') {
    // --apply：写入 OIDC token 后由 detached 子进程关闭并重开 Vibe（换号必须重启才会生效）
    const args = ['--apply'];
    if (p.email) args.push('--email', String(p.email));
    else args.push('--config', assertConfig(p.config));
    if (p.noRestart) args.push('--no-restart');
    return { script: 'vibe_login.mjs', args, meta: { restartsApp: !p.noRestart } };
  }
  if (action === 'vibecheck') {
    return { script: 'vibe_login.mjs', args: ['--check'] };
  }
  if (action === 'procheck') {
    const scope = String(p.scope || 'all');
    const args = [];
    if (scope === 'config') args.push('--config', assertConfig(p.config));
    else if (scope === 'account' && p.email) args.push('--email', String(p.email)); // 从 accounts.json 取
    else args.push('--all');
    if (p.proxy) args.push('--proxy', String(p.proxy).trim());
    return { script: 'pro_check.mjs', args };
  }
  if (action === 'inspect') {
    // 账号体检：有效性(whoami) + 套餐 + 月度额度(billing.budget) + 知识库用量
    const scope = String(p.scope || 'all');
    const args = [];
    if (scope === 'config') args.push('--config', assertConfig(p.config));
    else if (scope === 'account' && p.email) args.push('--email', String(p.email)); // 从 accounts.json 取
    else args.push('--all', '--concurrency', String(Math.min(8, Math.max(1, parseInt(p.concurrency || '3', 10) || 3))));
    if (p.proxy) args.push('--proxy', String(p.proxy).trim());
    return { script: 'account_inspect.mjs', args };
  }
  throw new Error('未知操作: ' + action);
}

async function handleRun(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return json(res, 400, { error: e.message }); }
  const action = String(body.action || '');
  const p = body.params || {};
  try {
    const running = [...tasks.values()].filter((t) => t.status === 'running');
    if (action === 'batch' && running.some((t) => t.action === 'batch')) throw new Error('已有批量任务在运行');
    if (action === 'proxy' && running.some((t) => t.action === 'proxy')) throw new Error('反代已在运行，请先停止');
    const built = buildRun(action, p);
    const t = spawnTask(action, built.script, built.args);
    t.meta = built.meta || null;
    json(res, 200, { ok: true, taskId: t.id, args: built.args });
  } catch (e) {
    json(res, 400, { error: e.message });
  }
}

function handleStop(res, id) {
  const t = tasks.get(id);
  if (!t) return json(res, 404, { error: '任务不存在' });
  if (!killTask(t)) return json(res, 400, { error: '任务已结束' });
  json(res, 200, { ok: true });
}

function handleStream(req, res, id) {
  const t = tasks.get(id);
  if (!t) return json(res, 404, { error: '任务不存在' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write(`data: ${JSON.stringify({ type: 'init', status: t.status, lines: t.lines.slice(-3000) })}\n\n`);
  if (t.status !== 'running') { res.end(); return; }
  t.listeners.add(res);
  req.on('close', () => t.listeners.delete(res));
  // 竞态兜底：订阅瞬间任务刚好结束，补发一次状态
  if (t.status !== 'running') {
    try { res.write(`data: ${JSON.stringify({ type: 'status', status: t.status, exitCode: t.exitCode })}\n\n`); } catch { /* ignore */ }
    t.listeners.delete(res);
    res.end();
  }
}

/* ============================== 页面与日志 ============================== */
function serveHtml(res) {
  const fp = path.join(ROOT, 'gui.html');
  if (!existsSync(fp)) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('gui.html 不存在');
  }
  const html = readFileSync(fp, 'utf8').replaceAll('__PORT__', String(PORT));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(html);
}

function handleLog(res, name) {
  if (!/^reg_\d{1,4}\.log$/.test(name)) return json(res, 400, { error: '非法日志名' });
  const fp = path.join('batch_logs', name);
  if (!existsSync(fp)) return json(res, 404, { error: '日志不存在' });
  json(res, 200, { name, content: readFileSync(fp, 'utf8') });
}

async function handleCardsSave(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return json(res, 400, { error: e.message }); }
  const parsed = parseCardsText(typeof body.text === 'string' ? body.text : '');
  const normalized = [
    '# cards.txt — 由 GUI 卡池管理保存（格式: 卡号|月|年|CVC；batch_register 自动收集 cards*.txt）',
    ...parsed.valid.map((c) => `${c.number}|${c.exp_month}|${c.exp_year}|${c.cvc}`),
  ].join('\n') + '\n';
  writeFileSync('cards.txt', normalized, 'utf8');
  json(res, 200, {
    content: normalized,
    valid: parsed.valid.length,
    invalid: parsed.invalid.length,
    dup: parsed.dup,
    errors: parsed.invalid.slice(0, 20),
  });
}

/* ============================== 肥猫猫 Token 池（feimao_tokens.txt） ============================== */
// 批量注册的临时邮箱来源（mistral_mailbox.mjs）：每行一个站点登录 token，# 注释；多个 token 轮询
const MAIL_TOKENS_FILE = 'feimao_tokens.txt';
const MAIL_TOKENS_STATE = 'feimao_tokens_state.json';
const maskMailToken = (t) => (t && t.length > 12 ? `${t.slice(0, 6)}…${t.slice(-4)}` : String(t || '').slice(0, 4) + '…');

function parseMailTokens(text) {
  const lines = String(text || '').split(/\r?\n/);
  const tokens = [];
  const seen = new Set();
  const invalid = [];
  let dup = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith('#')) continue;
    if (!/^[\x21-\x7e]{8,4096}$/.test(t)) { invalid.push({ line: i + 1, text: maskMailToken(t), why: 'token 应为 8-4096 位可见 ASCII 字符（无空格）' }); continue; }
    if (seen.has(t)) { dup++; continue; }
    seen.add(t);
    tokens.push(t);
  }
  return { tokens, invalid, dup };
}

function mailTokensState() {
  let content = '';
  try { content = readFileSync(MAIL_TOKENS_FILE, 'utf8'); } catch { /* 未配置 */ }
  const p = parseMailTokens(content);
  let state = {};
  try { state = JSON.parse(readFileSync(MAIL_TOKENS_STATE, 'utf8')).tokens || {}; } catch { /* 未运行过 */ }
  return {
    content,
    count: p.tokens.length,
    invalid: p.invalid.length,
    dup: p.dup,
    errors: p.invalid.slice(0, 20),
    tokens: p.tokens.map((t) => ({ mask: maskMailToken(t), ...(state[maskMailToken(t)] || { invalid: false, cooldownUntil: 0, remaining: null, lastUsedAt: 0, lastError: null }) })),
  };
}

async function handleMailTokensSave(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return json(res, 400, { error: e.message }); }
  const p = parseMailTokens(typeof body.content === 'string' ? body.content : '');
  const normalized = [
    '# feimao_tokens.txt — 肥猫猫邮箱服务登录 token（每行一个，# 注释；GUI「卡池管理」保存；mistral_mailbox.mjs 轮询使用）',
    ...p.tokens,
  ].join('\n') + '\n';
  writeFileSync(MAIL_TOKENS_FILE, normalized, 'utf8');
  json(res, 200, { ok: true, saved: p.tokens.length, ...mailTokensState() });
}

/* ============================== 配置读写 ============================== */
/** 读取单个配置文件的完整内容（含卡号/密码，仅本地 127.0.0.1 可访问） */
/** 下发给浏览器的配置视图：剔除密码、会话 cookie、邮箱 token 等敏感字段 */
function configPublicView(cfg) {
  return {
    email: cfg.email || null,
    first: cfg.first || '',
    last: cfg.last || '',
    promo_code: cfg.promo_code || '',
    card: cfg.card || null,
  };
}

function readConfigFull(file) {
  if (!configList().some((c) => c.file === file)) throw new Error('配置文件不存在: ' + file);
  try { return JSON.parse(readFileSync(path.join(ROOT, file), 'utf8')); }
  catch { throw new Error('配置文件解析失败: ' + file); }
}

/** 原子写配置文件：先写临时文件再改名，避免中途崩溃写坏 JSON */
function writeConfigFull(file, obj) {
  const fp = path.join(ROOT, file);
  const tmp = `${fp}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  writeFileSync(fp, readFileSync(tmp, 'utf8'));
  try { unlinkSync(tmp); } catch { /* ignore */ }
}

/**
 * 保存配置：可更新卡号 / 有效期 / CVC / 姓名 / 优惠码。
 * 卡号留空表示保持原值不变。
 */
async function handleConfigSave(req, res) {
  let body;
  try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
  const file = String(body.file || '').trim();
  if (!file) return json(res, 400, { error: '缺少配置文件名' });
  let cfg;
  try { cfg = readConfigFull(file); }
  catch (e) { return json(res, 400, { error: e.message }); }

  const patch = body.patch || {};
  const card = patch.card || {};
  const num = String(card.number || '').replace(/\s|-/g, '');
  if (num) {
    if (!/^\d{12,19}$/.test(num)) return json(res, 400, { error: '卡号需为 12-19 位数字' });
    if (!luhn(num)) return json(res, 400, { error: 'Luhn 校验失败，请核对卡号' });
    const mm = String(card.exp_month || '').padStart(2, '0');
    let yy = String(card.exp_year || '');
    const cvc = String(card.cvc || '');
    if (!/^\d{2}$/.test(mm) || Number(mm) < 1 || Number(mm) > 12) return json(res, 400, { error: '有效期月份无效（1-12）' });
    // 与 mistral_interactive.validateCard 保持一致：年份接受 2-4 位（YY 或 YYYY）
    // 原样透传，不擅自补全成 4 位——避免改动用户已有配置
    if (!/^\d{2,4}$/.test(yy)) return json(res, 400, { error: '有效期年份需为 2-4 位（YY 或 YYYY）' });
    if (!/^\d{3,4}$/.test(cvc)) return json(res, 400, { error: 'CVC 无效（3-4 位）' });
    cfg.card = { number: num, exp_month: mm, exp_year: yy, cvc };
  }
  if (patch.first !== undefined) cfg.first = String(patch.first);
  if (patch.last !== undefined) cfg.last = String(patch.last);
  if (patch.promo_code !== undefined) cfg.promo_code = String(patch.promo_code).trim() || 'MISTRALVIBE';

  try { writeConfigFull(file, cfg); }
  catch (e) { return json(res, 500, { error: '写入失败: ' + e.message }); }
  json(res, 200, { ok: true, file, config: configPublicView(cfg) });
}

/* ============================== 总览 ============================== */
function overview() {
  const acc = readAccounts();
  const { pool, files, used } = computePool();
  const running = [...tasks.values()]
    .filter((t) => t.status === 'running')
    .map((t) => ({ id: t.id, action: t.action, startedAt: t.startedAt, port: taskPort(t) }));
  return {
    accounts: Object.keys(acc).length,
    proAccounts: Object.values(acc).filter((a) => a.pro === true).length,
    validAccounts: Object.values(acc).filter((a) => a.valid === true).length,
    cards: { pool: pool.length, files, used: used.size },
    running,
    batch: running.find((t) => t.action === 'batch') || null,
    proxy: running.find((t) => t.action === 'proxy') || null,
    lastResults: resultsView().data
      ? {
          started_at: resultsView().data.started_at,
          success: resultsView().data.success,
          failed: resultsView().data.failed,
        }
      : null,
    env: { node: process.version, platform: process.platform },
  };
}

/** 读取 Vibe 桌面端当前登录账号（解密 config.json 的 authOidcTokens） */
function vibeStatus() {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'vibe_login.mjs'), '--check', '--json'], {
      encoding: 'utf8',
      timeout: 30000,
      cwd: ROOT,
    });
    const info = JSON.parse(out);
    return {
      ok: !info.error,
      exe: info.exe,
      data_dir: info.data,
      method: info.method,
      email: info.email,
      access_exp: info.access_exp,
      running: (info.running_pids || []).length > 0,
      error: info.error || null,
    };
  } catch (e) {
    return { ok: false, error: String((e.stdout || e.message || e)).slice(0, 300) };
  }
}

/* ============================== 服务联动（反代账号池热更新） ============================== */
const taskPort = (t) => t?.meta?.port || (t?.action === 'proxy' ? 8899 : null);
const actionTasks = (action) => [...tasks.values()].filter((t) => t.status === 'running' && t.action === action);

async function localFetch(url, opts = {}, timeoutMs = 2500) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(timer); }
}

/** 运行中反代的账号池快照（来自 /admin/pool） */
async function proxyPoolStatus() {
  const list = actionTasks('proxy').map((t) => ({ t, port: taskPort(t) }));
  const proxies = await Promise.all(list.map(async ({ t, port }) => {
    try {
      const r = await localFetch(`http://127.0.0.1:${port}/admin/pool`);
      return { taskId: t.id, port, reachable: true, ...(await r.json()) };
    } catch {
      return { taskId: t.id, port, reachable: false };
    }
  }));
  return { proxies };
}

/** 通知运行中的反代重读 accounts.json（reverse_proxy 自身另有 mtime 轮询兜底） */
async function reloadProxyPools() {
  const ports = actionTasks('proxy').map((t) => taskPort(t)).filter(Boolean);
  await Promise.allSettled(ports.map((port) =>
    localFetch(`http://127.0.0.1:${port}/admin/reload`, { method: 'POST' }).catch(() => {})
  ));
  return ports.length;
}

/* ============================== HTTP 服务 ============================== */
const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || HOST}`);
    const p = u.pathname;
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveHtml(res);
    if (req.method === 'GET' && p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && p === '/api/overview') return json(res, 200, overview());
    if (req.method === 'GET' && p === '/api/accounts') return json(res, 200, { accounts: accountsView() });
    if (req.method === 'GET' && p === '/api/vibe') return json(res, 200, vibeStatus());
    if (req.method === 'GET' && p === '/api/configs') return json(res, 200, { configs: configList() });
    if (req.method === 'GET' && p === '/api/config/detail') {
      const file = u.searchParams.get('file') || '';
      try { return json(res, 200, { ok: true, config: configPublicView(readConfigFull(file)) }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && p === '/api/config/save') return await handleConfigSave(req, res);
    if (req.method === 'GET' && p === '/api/cards') return json(res, 200, cardsState());
    if (req.method === 'POST' && p === '/api/cards') return await handleCardsSave(req, res);
    if (req.method === 'GET' && p === '/api/mail/tokens') return json(res, 200, mailTokensState());
    if (req.method === 'POST' && p === '/api/mail/tokens') return await handleMailTokensSave(req, res);
    if (req.method === 'POST' && p === '/api/run') return await handleRun(req, res);
    if (req.method === 'GET' && p === '/api/proxy/pool') return json(res, 200, await proxyPoolStatus());
    if (req.method === 'POST' && p === '/api/proxy/reload') return json(res, 200, { ok: true, updated: await reloadProxyPools() });
    if (req.method === 'GET' && p === '/api/proxy/key') return handleProxyKeyGet(res);
    if (req.method === 'POST' && p === '/api/proxy/key') return await handleProxyKeySave(req, res);
    if (req.method === 'GET' && p === '/api/proxy/profile') return handleProfileGet(res);
    if (req.method === 'POST' && p === '/api/proxy/profile') return await handleProfileSave(req, res);
    if (req.method === 'GET' && p === '/api/proxy/usage') return json(res, 200, await proxyUsageStatus());
    if (req.method === 'GET' && p === '/api/usage') return json(res, 200, { file: usageView(), live: await proxyUsageStatus() });
    if (req.method === 'GET' && p === '/api/inspect/report') return json(res, 200, inspectReport());
    if (req.method === 'GET' && p === '/api/tasks') return json(res, 200, { tasks: tasksView() });
    let m;
    if (req.method === 'GET' && (m = p.match(/^\/api\/tasks\/([^/]+)\/stream$/))) {
      return handleStream(req, res, decodeURIComponent(m[1]));
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/tasks\/([^/]+)\/stop$/))) {
      return handleStop(res, decodeURIComponent(m[1]));
    }
    if (req.method === 'GET' && p === '/api/results') return json(res, 200, resultsView());
    if (req.method === 'GET' && p === '/api/logs') return json(res, 200, logsView());
    if (req.method === 'GET' && (m = p.match(/^\/api\/logs\/([^/]+)$/))) {
      return handleLog(res, decodeURIComponent(m[1]));
    }
    json(res, 404, { error: '未找到: ' + p });
  } catch (e) {
    try { json(res, 500, { error: e.message }); } catch { try { res.end(); } catch { /* ignore */ } }
  }
});

function openBrowser(url) {
  try {
    const edge = [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    ].find((p) => existsSync(p));
    if (edge) {
      // Edge 应用模式：无地址栏，接近原生窗口
      spawn(edge, [`--app=${url}`, '--window-size=1440,920'], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch { /* ignore */ }
}

/* ============================== 反代 API key（proxy_key.txt；GUI 可自定义） ============================== */
const PROXY_KEY_FILE = 'proxy_key.txt';

function readProxyKey() {
  try { return readFileSync(PROXY_KEY_FILE, 'utf8').trim() || null; } catch { return null; }
}

/** 校验自定义 key：8-64 位，字母数字与 . _ - */
function validProxyKey(k) {
  return typeof k === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(k.trim());
}

/**
 * 确保 API key 存在（幂等）：文件缺失时生成随机 key 落盘。
 * GUI 启动自动拉起反代前调用，保证反代从一开始就带鉴权。
 */
function ensureProxyKey() {
  if (readProxyKey()) return readProxyKey();
  const key = `sk-mistral-${randomUUID().replace(/-/g, '')}`;
  writeFileSync(PROXY_KEY_FILE, key + '\n', 'utf8');
  console.log(`[APIkey] 已生成反代访问 key: ${key}（GUI「用量看板」可自定义修改）`);
  return key;
}

function handleProxyKeyGet(res) {
  json(res, 200, { key: readProxyKey() || '' });
}

async function handleProxyKeySave(req, res) {
  let body;
  try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
  const raw = typeof body.key === 'string' ? body.key.trim() : '';
  if (body.generate || !raw) {
    // 留空 / 点「随机生成」：生成新 key
    const key = `sk-mistral-${randomUUID().replace(/-/g, '')}`;
    writeFileSync(PROXY_KEY_FILE, key + '\n', 'utf8');
    await reloadProxyPools().catch(() => {});   // 立即通知反代重读 key 文件（另有 2.5s 轮询兜底）
    console.log(`[APIkey] 反代 key 已更新（随机生成）`);
    return json(res, 200, { ok: true, key, generated: true });
  }
  if (!validProxyKey(raw)) {
    return json(res, 400, { error: 'key 需为 8-64 位，仅限字母、数字和 . _ - 字符' });
  }
  writeFileSync(PROXY_KEY_FILE, raw + '\n', 'utf8');
  await reloadProxyPools().catch(() => {});
  console.log(`[APIkey] 反代 key 已更新（自定义）`);
  json(res, 200, { ok: true, key: raw, generated: false });
}

/* ============================== 反代客户端形态（web / desktop UA 标记） ============================== */
const CLIENT_PROFILE_FILE = 'client_profile.txt';

function readClientProfile() {
  try { return readFileSync(CLIENT_PROFILE_FILE, 'utf8').trim() === 'desktop' ? 'desktop' : 'web'; }
  catch { return 'web'; }
}

function handleProfileGet(res) {
  json(res, 200, { profile: readClientProfile() });
}

async function handleProfileSave(req, res) {
  let body;
  try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
  const profile = body.profile === 'desktop' ? 'desktop' : 'web';
  writeFileSync(CLIENT_PROFILE_FILE, profile + '\n', 'utf8');
  await reloadProxyPools().catch(() => {});   // 反代 mtime 轮询 + /admin/reload 都会热应用
  console.log(`[客户端形态] 反代 UA 标记切换为 ${profile === 'desktop' ? 'LeChat-Desktop（已热生效）' : 'web（已热生效）'}`);
  json(res, 200, { ok: true, profile });
}

/* ============================== 启动即自动开启反代 ============================== */
const AUTO_PROXY_PORT = 8899;

/**
 * GUI 启动即自动拉起反代（server.listen 回调里异步调用，不阻塞 openBrowser）。
 * 边界：若 8899 已有本项目反代（外部启动，非本 GUI 任务），只打日志跳过——
 * 该外部实例不在本 GUI 的任务列表里，前端 /api/proxy/pool 看不到它，属预期行为。
 * 任何失败（含 8899 被非本项目进程占用导致反代子进程 EADDRINUSE 退出）
 * 只记为 failed 任务，绝不拖垮 GUI。
 */
async function autoStartProxy() {
  const log = (...a) => console.log('[GUI]', ...a);
  try {
    // 0) 确保 API key 存在（文件缺失生成随机 key；反代读 proxy_key.txt 实现鉴权与热更新）
    try { ensureProxyKey(); } catch { /* 生成失败不阻塞自动启动 */ }
    // 1) 先探测 127.0.0.1:8899 是否已有本项目反代在跑
    try {
      const r = await localFetch(`http://127.0.0.1:${AUTO_PROXY_PORT}/health`, {}, 2000);
      const j = await r.json().catch(() => null);
      if (j && j.service === 'mistral-reverse-proxy') {
        log(`已检测到反代在 ${AUTO_PROXY_PORT} 运行，跳过自动启动（该实例非本 GUI 启动，前端任务列表看不到它，属正常）`);
        return;
      }
    } catch { /* 8899 空闲或占用者非本项目反代，继续尝试自动启动 */ }
    // 2) 复用现有 buildRun('proxy') + spawnTask 管线：config 优先 test_pipe_config.json
    const configs = configList();
    const cfg = configs.some((c) => c.file === 'test_pipe_config.json')
      ? 'test_pipe_config.json'
      : (configs[0]?.file || null);
    if (!cfg) {
      log('未发现配置文件（mistral_config.json / test_*_config.json），跳过自动启动反代');
      return;
    }
    const built = buildRun('proxy', { config: cfg, port: String(AUTO_PROXY_PORT), proOnly: false });
    const t = spawnTask('proxy', built.script, built.args);
    t.meta = built.meta || null;
    log(`自动启动反代: 端口 ${AUTO_PROXY_PORT}（任务 ${t.id}，config=${cfg}）`);
  } catch (e) {
    log('自动启动反代失败:', e.message);
  }
}

server.on('error', async (e) => {
  if (e.code === 'EADDRINUSE') {
    // 端口已被占用：探测是否是本项目的另一个 GUI 实例，是则直接开浏览器复用
    try {
      const r = await fetch(`http://${HOST}:${PORT}/api/overview`, { signal: AbortSignal.timeout(2500) });
      const j = await r.json();
      if (j && j.env && j.env.node) {
        console.error(`[GUI] 端口 ${PORT} 已被本项目的另一个实例占用（accounts=${j.accounts}），直接打开浏览器复用该实例。`);
        if (AUTO_OPEN) openBrowser(`http://${HOST}:${PORT}`);
        else console.error(`[GUI] 复用地址: http://${HOST}:${PORT}`);
        process.exit(0);
      }
    } catch { /* 占用者不是我们的实例 */ }
    console.error(`[GUI] 端口 ${PORT} 已被占用（占用者不是本项目实例），请换端口：node gui.mjs --port 8792`);
    console.error(`[GUI] 或双击 启动GUI.bat，由启动器提供「关闭旧进程并重启 / 直接退出 / 打开当前服务」菜单`);
    process.exit(1);
  }
  console.error('[GUI] 服务错误:', e.message);
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log('============================================================');
  console.log('  Mistral 控制台 · GUI');
  console.log(`  地址: ${url}`);
  console.log('  提示: 关闭此窗口即停止服务（Ctrl+C）');
  console.log('============================================================');
  // 启动即自动开启反代：异步执行，不阻塞打开浏览器；失败只记为 failed 任务，不影响 GUI
  if (AUTO_START_PROXY) autoStartProxy().catch(() => {});
  if (AUTO_OPEN) openBrowser(url);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const t of tasks.values()) if (t.status === 'running') killTask(t);
    setTimeout(() => process.exit(0), 300);
  });
}
