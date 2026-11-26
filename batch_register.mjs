#!/usr/bin/env node
/**
 * batch_register.mjs — 批量并发注册（注册数量 + 并发数量 可配）
 *
 * 用法:
 *   node batch_register.mjs --count 10 --concurrency 3
 *   node batch_register.mjs --count 20 --concurrency 5 --cards cards_batch5.txt
 *   node batch_register.mjs --count 5 --concurrency 2 --promo MISTRALVIBE --proxy http://127.0.0.1:7897
 *   node batch_register.mjs --count 5 --skip-redeem          # 只注册不兑换
 *
 * 参数:
 *   --count N         注册数量（必填）
 *   --concurrency C   并发数量（默认 3）
 *   --cards 文件      卡池文件（默认自动收集 cards*.txt），每行: 卡号|月|年|CVC
 *   --promo 代码      优惠码（默认 MISTRALVIBE）
 *   --proxy URL       代理（透传给子进程）
 *   --config-dir 目录 每个任务的配置目录（默认 batch_configs）
 *   --log-dir 目录    日志目录（默认 batch_logs）
 *   --skip-address / --skip-card / --skip-redeem   透传给 pipeline
 *
 * 说明:
 *   - 每个任务独立配置文件 + 独立日志，互不干扰；卡按池顺序分配（每卡只用一次，
 *     自动跳过 accounts.json 里已用过的卡）。
 *   - accounts.json 已加跨进程文件锁，并发登记不会互相覆盖。
 *   - 结果汇总写入 batch_results.json。
 */
import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { parseAddress, extractAddressLab, ADDRESSABLAB_UK } from './mistral_address_parser.mjs';
import { checkAndApplyConfig } from './pro_check.mjs';

// ---------------- 参数 ----------------
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

const COUNT = parseInt(opts['count'] || '0', 10);
const CONC = Math.max(1, parseInt(opts['concurrency'] || '3', 10));
const PROMO = opts['promo'] && opts['promo'] !== 'true' ? opts['promo'] : 'MISTRALVIBE';
const CONFIG_DIR = opts['config-dir'] && opts['config-dir'] !== 'true' ? opts['config-dir'] : 'batch_configs';
const LOG_DIR = opts['log-dir'] && opts['log-dir'] !== 'true' ? opts['log-dir'] : 'batch_logs';
const PROXY = opts['proxy'] && opts['proxy'] !== 'true' ? opts['proxy'] : null;
const CARDS_FILE = opts['cards'] && opts['cards'] !== 'true' ? opts['cards'] : null;
const TASK_TIMEOUT = parseInt(opts['timeout'] || '1500', 10) * 1000; // 单任务超时（毫秒），默认 25 分钟
const DRY_RUN = opts['dry-run'] === 'true'; // 只验证调度/分卡逻辑，不真实注册
const SKIP_CARD = opts['skip-card'] === 'true'; // 跳过绑卡时不需要卡，也不检查卡池

if (!COUNT || COUNT < 1) {
  console.log('[批量] 用法: node batch_register.mjs --count 注册数量 [--concurrency 并发数] [--cards 卡池文件]');
  console.log('[批量] 示例: node batch_register.mjs --count 10 --concurrency 3');
  process.exit(1);
}

const log = (msg) => console.log(`[批量] ${msg}`);
const pad = (n, w = 2) => String(n).padStart(w, '0');

// ---------------- 卡池 ----------------
function luhn(num) {
  let sum = 0, alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = num.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return sum % 10 === 0;
}

/** 解析一行卡信息，支持:
 *   卡号|05|2031|249
 *   卡号|05/31|249
 *   卡号<TAB>05/30<TAB>603<TAB>Mastercard
 *   卡号 05 2031 249
 */
function parseCardLine(line) {
  const parts = line.split(/[|\t,]+|\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const number = parts[0].replace(/\s/g, '');
  if (!/^\d{12,19}$/.test(number)) return null;
  let mm, yy, cvc;
  const m = /^(\d{1,2})[/-](\d{2,4})$/.exec(parts[1]);
  if (m) { mm = m[1]; yy = m[2]; cvc = parts[2]; }
  else { mm = parts[1]; yy = parts[2]; cvc = parts[3]; }
  if (!mm || !yy || !cvc) return null;
  if (yy.length === 2) yy = '20' + yy;
  if (!/^\d{1,2}$/.test(mm) || !/^\d{4}$/.test(yy) || !/^\d{3,4}$/.test(cvc)) return null;
  if (!luhn(number)) return null;
  return { number, exp_month: mm.padStart(2, '0'), exp_year: yy, cvc };
}

function collectCardFiles() {
  if (CARDS_FILE) return [CARDS_FILE];
  return readdirSync('.').filter((f) => /^cards.*\.(txt|csv)$/i.test(f)).sort();
}

function loadCardPool() {
  // 已用过的卡（accounts.json + 本次之前的登记）
  const used = new Set();
  try {
    const acc = existsSync('accounts.json') ? JSON.parse(readFileSync('accounts.json', 'utf8')) : {};
    for (const r of Object.values(acc)) if (r?.card?.number) used.add(String(r.card.number));
  } catch { /* ignore */ }

  const pool = [];
  const seen = new Set();
  const files = collectCardFiles();
  for (const f of files) {
    if (!existsSync(f)) { log(`卡池文件不存在，跳过: ${f}`); continue; }
    for (const raw of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const card = parseCardLine(line);
      if (!card) continue;
      if (used.has(card.number)) continue;   // 已用过
      if (seen.has(card.number)) continue;   // 池内去重
      seen.add(card.number);
      pool.push(card);
    }
  }
  log(`卡池: ${files.length} 个文件，可用卡 ${pool.length} 张（已跳过已用/重复/非法卡）`);
  return { pool, files };
}

// ---------------- 地址 ----------------
async function fetchAddress() {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(ADDRESSABLAB_UK, { signal: AbortSignal.timeout(30000) });
      const addr = extractAddressLab(await r.text());
      if (addr?.address_line1 && addr?.city) return addr;
    } catch (e) { log(`地址获取失败(第${i + 1}次): ${e.message}`); }
    await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  return null;
}

// ---------------- 姓名 ----------------
const FIRST = ['Alan', 'David', 'James', 'John', 'Robert', 'Michael', 'William', 'Richard', 'Joseph', 'Thomas', 'Emma', 'Olivia', 'Sophie', 'Alice', 'Laura'];
const LAST = ['Smith', 'Johnson', 'Brown', 'Taylor', 'Wilson', 'Anderson', 'Thomas', 'Moore', 'Martin', 'White', 'Hall', 'Young', 'King', 'Wright', 'Green'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// ---------------- 任务执行 ----------------
function runPipeline(configFile, logFile, taskIdx) {
  return new Promise((resolve) => {
    const args = ['pipeline.mjs', '--config', configFile, '--answers', 'answers_auto.txt'];
    if (PROXY) args.push('--proxy', PROXY);
    for (const f of ['skip-address', 'skip-card', 'skip-redeem']) {
      if (opts[f] === 'true') args.push(`--${f}`);
    }
    const out = [];
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    // 子任务输出同时回显到自身 stdout（带任务标签），GUI 实时日志能直接看到；完整内容仍写 logFile
    const tag = `[任务${String(taskIdx).padStart(3, '0')}] `;
    let pending = '';
    const cap = (buf) => {
      const s = buf.toString('utf8');
      out.push(s);
      if (out.join('').length > 400000) out.splice(0, 100); // 日志截断，防内存膨胀
      pending += s;
      let i;
      while ((i = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, i).replace(/\r$/, '');
        pending = pending.slice(i + 1);
        if (line) process.stdout.write(`${tag}${line}\n`);
      }
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* ignore */ }
    }, TASK_TIMEOUT);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (pending.trim()) process.stdout.write(`${tag}${pending.trim()}\n`);
      pending = '';
      try { writeFileSync(logFile, out.join(''), 'utf8'); } catch { /* ignore */ }
      resolve({ code: timedOut ? -9 : (code ?? 1), timedOut });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      try { writeFileSync(logFile, `启动失败: ${e.message}\n` + out.join(''), 'utf8'); } catch { /* ignore */ }
      resolve({ code: -1, timedOut: false, error: e.message });
    });
  });
}

// ---------------- 主流程 ----------------
if (!existsSync('answers_auto.txt')) writeFileSync('answers_auto.txt', 'y\ny\ny\ny\n');
mkdirSync(CONFIG_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });

const { pool, files } = loadCardPool();
if (SKIP_CARD) {
  log('跳过绑卡（--skip-card）：不检查卡池，任务不分配卡');
} else if (pool.length < COUNT) {
  log(`[错误] 卡不足：需要 ${COUNT} 张，可用 ${pool.length} 张。`);
  log(`       请补充卡池（当前文件: ${files.join(', ') || '无'}），或降低 --count，或加 --skip-card 不绑卡。`);
  process.exit(1);
}

// 用一个已有配置的地址做兜底（addresslab 挂了也能跑）
let baseAddress = null;
for (const f of ['mistral_config.json', 'test_fresh_config.json', 'test_pipe_config.json']) {
  try {
    const a = JSON.parse(readFileSync(f, 'utf8')).address;
    if (a?.address_line1 && a?.city) { baseAddress = a; break; }
  } catch { /* ignore */ }
}

log(`开始: 注册 ${COUNT} 个，并发 ${CONC}，促销码 ${PROMO}${PROXY ? `，代理 ${PROXY}` : ''}`);

// 预创建任务（每个任务独立配置 + 独立卡）
const tasks = [];
for (let i = 0; i < COUNT; i++) {
  const id = pad(i + 1, 3);
  const card = SKIP_CARD ? null : pool[i];
  tasks.push({
    id,
    card,
    configFile: `${CONFIG_DIR}/reg_${id}.json`,
    logFile: `${LOG_DIR}/reg_${id}.log`,
    status: 'pending',
    email: null,
    code: null,
    error: null,
    addressFrom: null,
  });
}

// 逐个准备配置（地址获取加信号量限流，避免打爆 addresslab）
let addrActive = 0;
const ADDR_MAX = 2;
function addrSlot() {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (addrActive < ADDR_MAX) { addrActive++; resolve(); }
      else setTimeout(tryAcquire, 200);
    };
    tryAcquire();
  });
}
async function prepareTask(t) {
  await addrSlot();
  let address = null;
  try {
    address = await fetchAddress();
  } finally {
    addrActive--;
  }
  let from = 'addresslab';
  if (!address) { address = baseAddress; from = 'base-config'; }
  if (!address) { t.status = 'failed'; t.error = '无法获取地址'; return false; }
  t.addressFrom = from;

  const cfg = {
    version: 1,
    card: t.card,
    address,
    promo_code: PROMO,
    registered_at: null,
    email: null,
    password: null,
    first: pick(FIRST),
    last: pick(LAST),
    identity_id: null,
    mailbox: null,
    session: null,
  };
  writeFileSync(t.configFile, JSON.stringify(cfg, null, 2));
  return true;
}

// 并发池
const results = [];
let cursor = 0;
async function worker(workerId) {
  for (;;) {
    const i = cursor++;
    if (i >= tasks.length) return;
    const t = tasks[i];
    const tag = `[任务${t.id}/W${workerId}]`;
    t.status = 'running';
    t.startedAt = new Date().toISOString();
    log(`${tag} 开始 → ${t.card ? '卡 ****' + t.card.number.slice(-4) : '无卡（--skip-card 跳过绑卡）'}，配置 ${t.configFile}`);

    const ok = await prepareTask(t);
    if (!ok) {
      t.status = 'failed';
      log(`${tag} ✗ ${t.error}`);
      results.push(t);
      continue;
    }

    const r = DRY_RUN
      ? await new Promise((res) => setTimeout(() => res({ code: 0, timedOut: false }), 300 + Math.random() * 700))
      : await runPipeline(t.configFile, t.logFile, t.id);
    t.code = r.code;
    t.finishedAt = new Date().toISOString();

    if (DRY_RUN) {
      t.status = 'success';
      t.email = `dryrun-${t.id}@example.test`;
      t.sessionSaved = true;
      log(`${tag} ✓ [演练] ${t.card ? '分配卡 ****' + t.card.number.slice(-4) : '不分配卡（--skip-card）'} → ${t.configFile}（${t.addressFrom}）`);
      results.push(t);
      continue;
    }

    // 读回配置拿账号信息
    try {
      const c = JSON.parse(readFileSync(t.configFile, 'utf8'));
      t.email = c.email;
      t.password = c.password;
      t.identityId = c.identity_id;
      t.sessionSaved = !!c.session?.saved_at;
    } catch { /* ignore */ }

    // Pro 检测：只有 Pro 才入池（结果写回 accounts.json 的 pro / in_pool 字段）
    let pro = null;
    let proPlan = null;
    if (r.code === 0 && t.email && t.sessionSaved) {
      const pr = await checkAndApplyConfig(t.configFile);
      pro = pr.ok ? pr.pro === true : null;
      proPlan = pr.ok ? pr.plan : null;
      log(`${tag} Pro 检测: ${pr.ok ? `${proPlan}（${pro ? '✓ 已入池' : '✗ 未入池'}）` : `失败: ${pr.error}（按未入池处理）`}`);
    }
    t.pro = pro;
    t.proPlan = proPlan;
    t.inPool = pro === true;

    if (r.code === 0 && t.email) {
      t.status = 'success';
      const poolTag = pro === true ? ' · Pro 已入池' : pro === false ? ' · 非 Pro 未入池' : '';
      log(`${tag} ✓ 成功: ${t.email}${t.sessionSaved ? `（cookie 已保存${poolTag}）` : ''}`);
    } else {
      t.status = 'failed';
      t.error = r.timedOut ? `超时(${TASK_TIMEOUT / 1000}s)` : `退出码 ${r.code}`;
      // 从日志里抓一行关键错误
      try {
        const lg = readFileSync(t.logFile, 'utf8');
        const m = lg.split(/\r?\n/).find((l) => /\[ERR\]|错误|失败|decline|3DS|Error/i.test(l));
        if (m) t.error += ` | ${m.trim().slice(0, 160)}`;
      } catch { /* ignore */ }
      log(`${tag} ✗ 失败: ${t.error}`);
    }
    results.push(t);
  }
}

const t0 = Date.now();
await Promise.all(Array.from({ length: Math.min(CONC, tasks.length) }, (_, i) => worker(i + 1)));
const elapsed = Math.round((Date.now() - t0) / 1000);

// ---------------- 汇总 ----------------
const okList = results.filter((r) => r.status === 'success');
const failList = results.filter((r) => r.status !== 'success');

writeFileSync('batch_results.json', JSON.stringify({
  started_at: new Date(t0).toISOString(),
  elapsed_seconds: elapsed,
  count: COUNT, concurrency: CONC, promo: PROMO,
  success: okList.length, failed: failList.length,
  results: results.map((r) => ({
    id: r.id, status: r.status, email: r.email, password: r.password,
    card: r.card ? '****' + r.card.number.slice(-4) : null, config_file: r.configFile, log_file: r.logFile,
    pro: r.pro ?? null, pro_plan: r.proPlan ?? null, in_pool: r.inPool === true,
    error: r.error, code: r.code,
  })),
}, null, 2), 'utf8');

console.log('\n================ 批量并发注册 · 结果汇总 ================');
console.log(`注册数量 : ${COUNT}   并发数 : ${CONC}   耗时 : ${elapsed}s`);
console.log(`成功     : ${okList.length}   失败 : ${failList.length}`);
console.log(`入池(Pro): ${okList.filter((r) => r.inPool === true).length}   非 Pro 未入池 : ${okList.filter((r) => r.pro === false).length}`);
console.log(`账号表   : accounts.json（共 ${Object.keys((() => { try { return JSON.parse(readFileSync('accounts.json', 'utf8')); } catch { return {}; } })()).length} 个账号）`);
console.log(`明细     : batch_results.json   日志: ${LOG_DIR}/`);
if (okList.length) {
  console.log('--------------------------------------------------------');
  for (const r of okList) console.log(`  ✓ ${r.email}  卡 ${r.card ? (typeof r.card === 'string' ? r.card : '****' + r.card.number.slice(-4)) : '无（--skip-card）'}  ${r.pro === true ? 'Pro 已入池' : r.pro === false ? 'Free 未入池' : 'Pro 未检出'}  配置 ${r.configFile}`);
}
if (failList.length) {
  console.log('--------------------------------------------------------');
  for (const r of failList) console.log(`  ✗ 任务${r.id}  ${r.error || '未知错误'}  日志 ${r.logFile}`);
}
console.log('========================================================');

process.exit(failList.length ? 1 : 0);
