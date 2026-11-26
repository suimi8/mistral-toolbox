#!/usr/bin/env node
/**
 * pipeline.mjs — 注册一条龙（合并版）：
 *   配置准备（无配置时自动取卡+地址） → 注册新账号（自动邮箱+验证码） → 地址填充
 *   → 绑卡 → 兑换 → 保存配置/accounts.json 登记 → 导出登录 cookie → 可选直接打开网页
 *
 * 用法:
 *   node pipeline.mjs --config test_fresh_config.json            # 用已有配置跑一条龙
 *   node pipeline.mjs --config new.json --card "5290...|01|2031|030"   # 无配置：自动建配置
 *   node pipeline.mjs --config x.json --proxy http://127.0.0.1:7897 --open
 *   node pipeline.mjs --config x.json --first Alan --last Smith  # 新建配置时的姓名
 *
 * 说明：
 *   - 每次运行都会注册【新账号】（--new-account），卡/地址/优惠码沿用配置。
 *   - 全程无交互（自动应答 answers_auto.txt），失败时退出码非 0。
 *   - 最后一步（--open）用 CDP 把登录态注入浏览器并打开 chat.mistral.ai。
 */
import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { parseAddress, extractAddressLab, ADDRESSABLAB_UK } from './mistral_address_parser.mjs';
import { checkAndApplyConfig } from './pro_check.mjs';

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
const CONFIG = opts['config'] && opts['config'] !== 'true' ? opts['config'] : 'mistral_config.json';
const SKIP_CARD = opts['skip-card'] === 'true'; // 不绑卡时整个流程不需要卡号
const log = (phase, msg) => console.log(`[PIPE] [${phase}] ${msg}`);

function run(script, args) {
  return new Promise((resolve) => {
    log('RUN', `node ${script} ${args.join(' ')}`);
    const p = spawn(process.execPath, [script, ...args], { stdio: 'inherit' });
    p.on('close', (code) => resolve(code ?? 1));
    p.on('error', (e) => { log('ERR', `${script} 启动失败: ${e.message}`); resolve(1); });
  });
}

function parseCard(str) {
  const p = str.split(/[|,\s]+/).map(s => s.trim()).filter(Boolean);
  if (p.length < 4) return null;
  let [number, mm, yy, cvc] = p;
  number = number.replace(/\s/g, '');
  if (yy.length === 2) yy = '20' + yy;
  if (!/^\d{12,19}$/.test(number) || !/^\d{1,2}$/.test(mm) || !/^\d{4}$/.test(yy) || !/^\d{3,4}$/.test(cvc)) return null;
  return { number, exp_month: mm.padStart(2, '0'), exp_year: yy, cvc };
}

async function fetchAutoAddress() {
  try {
    const r = await fetch(ADDRESSABLAB_UK, { signal: AbortSignal.timeout(30000) });
    const addr = extractAddressLab(await r.text());
    if (addr) return addr;
  } catch (e) { log('ADDR', `addresslab 获取失败: ${e.message}`); }
  // 兜底：手输地址字符串
  if (process.stdin.isTTY) {
    const { createInterface } = await import('readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const s = (await rl.question('地址 (如 "1 Oxford St, London EC1A 1BB"): ')).trim();
    rl.close();
    const addr = parseAddress(s);
    if (addr?.address_line1 && addr?.city) return addr;
  }
  return null;
}

// ---- 1. 配置准备 ----
let config = null;
if (existsSync(CONFIG)) {
  config = JSON.parse(readFileSync(CONFIG, 'utf8'));
  log('CFG', `已有配置: ${CONFIG}（账号 ${config.email || '未注册'}）`);
} else {
  log('CFG', `配置不存在，自动创建: ${CONFIG}`);
  let card = opts['card'] && opts['card'] !== 'true' ? parseCard(opts['card']) : null;
  if (!card && process.stdin.isTTY) {
    const { createInterface } = await import('readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const s = (await rl.question('卡号 (格式: 卡号|MM|YYYY|CVC): ')).trim();
    rl.close();
    card = parseCard(s);
  }
  if (!card && !SKIP_CARD) { log('ERR', '缺少卡号：请加 --card "卡号|MM|YYYY|CVC"，或先在 GUI「单账号流水线」页设置卡号'); process.exit(1); }
  if (SKIP_CARD) log('CFG', '已跳过绑卡（--skip-card）：本次不需要卡号（若未跳过兑换，兑换阶段可能因无支付方式失败）');
  const address = await fetchAutoAddress();
  if (!address) { log('ERR', '无法获取地址（addresslab 不可用且非交互环境）'); process.exit(1); }
  config = {
    version: 1,
    card,
    address,
    promo_code: opts['promo'] && opts['promo'] !== 'true' ? opts['promo'] : 'MISTRALVIBE',
    registered_at: null,
    email: null,
    password: null,
    first: opts['first'] && opts['first'] !== 'true' ? opts['first'] : 'Alan',
    last: opts['last'] && opts['last'] !== 'true' ? opts['last'] : 'Smith',
    identity_id: null,
    mailbox: null,
    session: null,
  };
  writeFileSync(CONFIG, JSON.stringify(config, null, 2));
  log('CFG', `已创建配置（卡 ****${card.number.slice(-4)}，地址 ${address.address_line1}, ${address.city} ${address.zipcode}）`);
}
if (!SKIP_CARD && !config.card?.number) { log('ERR', '配置里没有卡号，请先在 GUI「单账号流水线」页设置卡号'); process.exit(1); }
if (!existsSync('answers_auto.txt')) writeFileSync('answers_auto.txt', 'y\ny\ny\ny\n');

// ---- 2. 注册一条龙主流程（注册 → 地址 → 绑卡 → 兑换 → 保存/登记/导出 cookie） ----
const flowArgs = ['--config', CONFIG, '--new-account', '--answers', 'answers_auto.txt'];
if (opts['proxy'] && opts['proxy'] !== 'true') flowArgs.push('--proxy', opts['proxy']);
for (const f of ['skip-address', 'skip-card', 'skip-redeem']) {
  if (opts[f] === 'true') flowArgs.push(`--${f}`);
}
const rcFlow = await run('mistral_interactive.mjs', flowArgs);

// ---- 3. 刷新登录态 + 导出 cookie（--open 时直接打开已登录网页） ----
const loginArgs = ['--config', CONFIG];
if (opts['open'] === 'true') loginArgs.push('--open');
if (opts['proxy'] && opts['proxy'] !== 'true') loginArgs.push('--proxy', opts['proxy']);
// 注册未产生账号（配置无邮箱/密码）时跳过登录，避免无谓的失败
let rcLogin = 0;
if (rcFlow === 0) {
  let hasAccount = true;
  try {
    const c2 = JSON.parse(readFileSync(CONFIG, 'utf8'));
    hasAccount = !!(c2.email && c2.password);
  } catch { /* 配置读不出就照常尝试登录 */ }
  if (hasAccount) {
    rcLogin = await run('mistral_login.mjs', loginArgs);
  } else {
    log('RUN', '注册未产生账号（配置无邮箱/密码），跳过登录步骤');
  }
}

// ---- 3.5 Pro 检测（只有 Pro 才入池） ----
let proResult = null;
if (rcFlow === 0) {
  proResult = await checkAndApplyConfig(CONFIG);
  log('PRO', proResult.ok
    ? `套餐 ${proResult.plan} → ${proResult.pro ? 'Pro ✓ 已入池' : '非 Pro ✗ 未入池'}`
    : `检测失败: ${proResult.error}（按未入池处理）`);
}

// ---- 4. 总结 ----
try {
  const c = JSON.parse(readFileSync(CONFIG, 'utf8'));
  const accounts = existsSync('accounts.json') ? JSON.parse(readFileSync('accounts.json', 'utf8')) : {};
  const acc = c.email ? accounts[c.email] : null;
  console.log('\n================ 注册一条龙 · 结果总结 ================');
  console.log(`配置文件 : ${CONFIG}`);
  console.log(`账号     : ${c.email || '(未注册成功)'}  密码: ${c.password || '-'}`);
  console.log(`身份 ID  : ${c.identity_id || '-'}`);
  console.log(`地址     : ${c.address ? `${c.address.address_line1}, ${c.address.city} ${c.address.zipcode}, ${c.address.country}` : '-'}`);
  console.log(`卡号     : ****${(c.card?.number || '').slice(-4)}  优惠码: ${c.promo_code || '-'}`);
  console.log(`会话保存 : ${c.session?.saved_at || '无'}${acc ? '（已登记 accounts.json）' : ''}`);
  console.log(`套餐/入池: ${proResult ? (proResult.ok ? `${proResult.plan} → ${proResult.pro ? 'Pro 已入池' : '非 Pro 未入池'}` : `检测失败（${proResult.error}）`) : '未检测'}`);
  console.log(`Cookie   : ${existsSync(`cookies/${c.email}.txt`) ? `cookies/${c.email}.txt / .json 已导出` : '未导出'}`);
  console.log('======================================================');
} catch { /* 总结失败不影响退出码 */ }

const rc = rcFlow || rcLogin || (opts['require-pro'] === 'true' && proResult && proResult.pro !== true ? 1 : 0);
console.log(`\n[PIPE] ${rc === 0 ? '一条龙完成' : `结束（主流程退出码 ${rcFlow}${rcLogin ? `，登录 ${rcLogin}` : ''}）`}`);
process.exit(rc);
