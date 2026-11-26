#!/usr/bin/env node
/**
 * 交互式终端（Mistral 账号注册 + 配置文件保存 + 可选继续执行地址填充/绑卡/兑换）
 *
 * 流程：
 *   Phase 1 — 交互式注册新账号（Kratos 流程 + 邮箱验证码）
 *   Phase 2 — 保存配置文件：卡号信息、优惠码、身份地址（地址自动从 addresslab.net 抓取）
 *   Phase 3 — 可选：继续执行地址填充（billing.updateInfo）+ 绑卡（Stripe setup intent 确认）
 *              + 优惠码兑换（billing.redeemSubscriptionCoupon）全流程
 *
 * 邮箱获取方式（mistral_mailbox.mjs，自动获取，无需手动输入）：
 *   使用肥猫猫邮箱服务（https://zjkdongao.cn/）的游客临时邮箱 API
 *   （调试抓包：获取邮箱和验证码.devtools + 包内 js 脚本验证）：
 *     1. POST https://zjkdongao.cn/mail-api/v1/mailboxes/temp
 *        header X-Guest-Visitor-Id: <64hex>
 *        -> data.email（临时邮箱地址，注册用）
 *     2. GET https://zjkdongao.cn/mail-api/v1/mailboxes/temp/<id>/emails
 *        header X-Guest-Mailbox-Token: <claim_token>
 *        -> data.emails[]（含 from_addr/subject/content_text/content_html）
 *   注册后轮询邮件列表，从 Mistral 验证邮件
 *   （from_addr 含 mistral.ai、主题含 "verify"）的 content_text/content_html
 *   提取 6 位验证码（自动填）；若自动获取失败，则手动输入。
 *
 * 用法:
 *   node mistral_interactive.mjs                    # 交互式：注册新账号 → 保存配置 → 可选继续
 *   node mistral_interactive.mjs --card-only        # 交互式：仅需输入卡号/CVC/有效期，
 *                                                   #   其余（地址/优惠码）从外部获取
 *   node mistral_interactive.mjs --config f.json    # 读已有配置：跳过注册，直接执行阶段 3
 *   node mistral_interactive.mjs --config f.json --no-continue   # 只读配置不执行
 *   node mistral_interactive.mjs --config f.json --new-account   # 旧账号未验证/不可用时，
 *                                                   #   沿用卡/地址/优惠码重新注册并继续
 *   node mistral_interactive.mjs --config f.json --proxy http://host:port
 *                                                   # 指定代理（只代理 mistral.ai/stripe.com/
 *                                                   #   出口查询；邮箱/地址服务仍直连）。
 *                                                   #   也可用环境变量 MISTRAL_PROXY。
 *
 * 地区与兑换限制（实测结论，详见注册方式Mistral全流程.har）：
 *   1. billing.redeemSubscriptionCoupon 按“请求出口 IP”判定地区：同一账号同一资料，
 *      日本出口返回 country_not_eligible，德国出口通过。兑换前请确保出口在欧洲
 *      （切换代理节点，或用 --proxy 指定欧洲代理）；
 *   2. 同一张卡（同卡+同账单邮编）只能成功兑换一次，重复兑换返回 already_redeemed。
 *
 * --card-only 模式：仅交互式输入卡号/CVC/有效期（4 个输入）；地址自动从
 * addresslab.net 抓取，优惠码取默认 MISTRALVIBE；保存后询问是否继续执行
 * 地址填充 + 绑卡 + 优惠码兑换全流程（需登录已有账号）。
 *
 * 邮箱相关选项：
 *   --auto-email          注册用自动生成邮箱（默认行为）；交互时回车即可
 *   --no-auto-email       不自动生成邮箱，直接提示输入邮箱
 *   --email addr          指定注册邮箱（不自动生成，也不轮询验证码）
 *
 * 配置文件（默认 mistral_config.json）内容：email/password/name、卡号、优惠码、地址。
 * 注意：配置文件包含密码等敏感信息，请注意保管。
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createInterface } from 'node:readline/promises';
import { parseAddress, extractAddressLab, ADDRESSABLAB_UK } from './mistral_address_parser.mjs';
import { createMailbox, waitForVerificationCodes, latestMailReceivedAt } from './mistral_mailbox.mjs';
import { upsertAccount } from './mistral_accounts.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0';
const CONFIG_DEFAULT = 'mistral_config.json';
const KEY_PK = 'pk_live_51O7wyUBYKjiYB8m0Yqxsl4CBynQH6dPe2YRbLJ7852H4lbLFQB6te2KXIFpy3hVZCFUnSVes7cmlUw3kKNkVpHWc00kcFfFqa7';

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
const CONFIG_PATH = opts['config'] && opts['config'] !== 'true' ? opts['config'] : CONFIG_DEFAULT;
const batchAnswers = opts['answers'] && opts['answers'] !== 'true' ? readFileSync(opts['answers'], 'utf8').split('\n').map(s => s.trim()).filter(s => s !== '') : null;
let batchIdx = 0;

// 可选代理：--proxy http://user:pass@host:port（或环境变量 MISTRAL_PROXY）。
// 只有 mistral.ai / stripe.com / 出口 IP 查询走代理——兑换的 country 校验看的是
// 请求出口 IP，而邮箱（zjkdongao.cn）、地址（addresslab.net）是国内服务需直连。
const PROXY_URL = (opts['proxy'] && opts['proxy'] !== 'true') ? opts['proxy'] : process.env.MISTRAL_PROXY;
let ufetch = null;
let proxyAgent = null;
if (PROXY_URL) {
  const undici = await import('undici');
  ufetch = undici.fetch;
  proxyAgent = new undici.ProxyAgent(PROXY_URL);
  console.log(`[PROXY] ${PROXY_URL}（mistral.ai / stripe.com / 出口查询走代理，其余直连）`);
}
const PROXY_HOST_RE = /(^|\.)mistral\.ai$|(^|\.)stripe\.com$|(^|\.)ipinfo\.io$|(^|\.)ipapi\.co$/;

const log = (phase, msg, extra) => console.log(`[${phase}] ${msg}${extra !== undefined ? '\n        ' + extra : ''}`);
const jstr = (o, max = 800) => { const s = JSON.stringify(o); return s && s.length > max ? s.slice(0, max) + '…' : s; };

// ---------------- cookie / HTTP ----------------

const jar = new Map();
function jarFrom(res) {
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of cookies) {
    const pair = c.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
const FETCH_TIMEOUT_MS = 60000;

async function fetchRes(method, url, { body, headers = {}, redirect = 'follow', forceProxy = false } = {}) {
  const h = { accept: 'application/json', 'user-agent': UA, ...headers };
  const ck = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  if (ck && !h['cookie']) h['cookie'] = ck;
  if (body !== undefined && !h['content-type']) h['content-type'] = typeof body === 'string' ? 'application/json' : 'application/x-www-form-urlencoded';
  const init = { method, headers: h, body: body === undefined ? undefined : String(body), redirect, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
  let res;
  if (proxyAgent && (forceProxy || PROXY_HOST_RE.test(new URL(url).hostname))) {
    res = await ufetch(url, { ...init, dispatcher: proxyAgent });
  } else {
    res = await fetch(url, init);
  }
  jarFrom(res);
  return res;
}
const jsonOfText = (text, ...path) => {
  try { let o = JSON.parse(text); for (const k of path) o = o?.[k]; return o; } catch { return undefined; }
};
const jsonOf = async (res, ...path) => jsonOfText(await res.text(), ...path);
function csrfFromPage(text) {
  const m = text.match(/"name":"csrf_token"[\s\S]{0,800}?"value":"([^"]+)"/);
  return m ? m[1] : null;
}

// ---------------- Kratos / admin.mistral.ai 认证 ----------------
// 抓包（注册方式Mistral全流程.har）结论：
//   1. 注册响应 200 里带 session + continue_with[].flow（show_verification_ui），
//      必须用这个 flow 提交验证码，否则邮箱不会被标记为 verified；
//   2. 邮箱未验证时登录会返回 400 "Account not active yet"，
//      admin.mistral.ai 的所有 billing.* 接口随之 401；
//   3. 登录流程是 identifier_first -> password，两步都要带 identifier；
//      identifier_first 本身返回 400 是 Mistral 的 Kratos 配置行为，不代表失败；
//   4. 登录成功后 Kratos 下发 ory_session_* cookie，admin.mistral.ai 用同一 cookie 认证。

const AUTH_BASE = 'https://auth.mistral.ai';
const ADMIN_BASE = 'https://admin.mistral.ai';
const TTRPC_HEADERS = {
  origin: ADMIN_BASE,
  referer: `${ADMIN_BASE}/subscription/upgrade/redeem`,
  'x-trpc-source': 'nextjs-react',
};
const TTRPC_INPUT = encodeURIComponent(JSON.stringify({ json: null, meta: { values: ['undefined'], v: 1 } }));

function kratosMessages(text) {
  try {
    const j = JSON.parse(text);
    const msgs = [...(j.ui?.messages || []), ...(j.ui?.nodes || []).flatMap(n => n.messages || [])];
    return msgs.map(m => m.text).filter(Boolean);
  } catch { return []; }
}

async function whoami() {
  try {
    const r = await fetchRes('GET', `${AUTH_BASE}/sessions/whoami`, { redirect: 'manual' });
    if (r.status !== 200) return null;
    const j = await jsonOf(r);
    return j?.active ? j : null;
  } catch { return null; }
}

function loadSessionCookies(config) {
  const cookies = config?.session?.cookies;
  if (!cookies || typeof cookies !== 'object') return;
  for (const [k, v] of Object.entries(cookies)) if (k && v) jar.set(k, v);
}

function sessionCookies() {
  const out = {};
  for (const [k, v] of jar) if (/^ory_/i.test(k)) out[k] = v;
  return out;
}

async function submitVerification(flowId, csrf, code) {
  const r = await fetchRes('POST', `${AUTH_BASE}/self-service/verification?flow=${flowId}`, {
    body: JSON.stringify({ csrf_token: csrf, method: 'code', code, transient_payload: {} }),
    headers: { origin: 'https://v2.auth.mistral.ai', referer: 'https://v2.auth.mistral.ai/' },
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const msgs = kratosMessages(text);
  const ok = r.status === 200 && (json?.state === 'passed_challenge' || msgs.some(m => /successfully verified/i.test(m)));
  return { ok, status: r.status, json, msgs, text };
}

// 未验证账号的修复路径：/verification/browser -> 提交 email 重新发码 -> 提交 code
async function startVerificationFlow(email, log) {
  const r = await fetchRes('GET', `${AUTH_BASE}/self-service/verification/browser?return_to=${encodeURIComponent('https://chat.mistral.ai/work')}`, { redirect: 'manual' });
  const text = await r.text();
  let flow = null;
  try { flow = JSON.parse(text); } catch {}
  if (!flow?.id) { log('A6', `无法创建验证 flow: ${r.status}`); return null; }
  const csrf = csrfFromPage(text);
  const r2 = await fetchRes('POST', `${AUTH_BASE}/self-service/verification?flow=${flow.id}`, {
    body: JSON.stringify({ csrf_token: csrf, method: 'code', email, transient_payload: {} }),
    headers: { origin: 'https://v2.auth.mistral.ai', referer: 'https://v2.auth.mistral.ai/' },
  });
  const text2 = await r2.text();
  let flow2 = null;
  try { flow2 = JSON.parse(text2); } catch {}
  const csrf2 = csrfFromPage(text2);
  const msgs = kratosMessages(text2);
  const sent = r2.status === 200 && (flow2?.state === 'sent_email' || msgs.some(m => /sent/i.test(m)));
  if (!sent) {
    log('A6', `重新发送验证码失败: ${r2.status} ${msgs.join('；')}`);
    return null;
  }
  log('A6', `已重新发送验证码到 ${email}`);
  return { flowId: flow.id, csrf: csrf2, sentAt: Date.now() };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 等注册验证邮件先落地，再发“重新验证码”，这样新邮件的时间戳一定更大
async function waitForMailboxMail(mailbox, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ts = await latestMailReceivedAt(mailbox);
    if (ts > 0) return ts;
    await sleep(2000);
  }
  return 0;
}

// 验证邮箱：走 /self-service/verification/browser 的独立 code flow。
// 注意：注册响应 continue_with 里的 flow 在脚本环境会返回
// "Could not find a strategy to verify your account with"，不能直接提交；
// 独立 flow（先提交 email 重发验证码）在抓包/实测中稳定可用。
async function verifyEmail({ email, mailbox, log }) {
  // 先等注册邮件到达，避免把注册验证码误当成重发验证码（错码会让 flow 失效）
  const before = mailbox ? await waitForMailboxMail(mailbox, 15000) : 0;
  if (mailbox && !before) log('A6', '注册验证邮件 15 秒内未到达，继续尝试重新发送');
  const repair = await startVerificationFlow(email, log);
  if (!repair) return false;
  const codes = mailbox
    ? await waitForVerificationCodes({ mailbox, timeoutMs: 60000, afterReceivedAtMs: before, log })
    : [(await ask('验证码 (verification code, 6 digits)')).trim()].filter(Boolean);
  if (codes.length === 0) { log('A6', '未收到新的验证码邮件'); return false; }
  for (const code of codes) {
    const res = await submitVerification(repair.flowId, repair.csrf, code);
    if (res.ok) { log('A6', `验证码验证成功（${code}，邮箱已验证）`); return true; }
    log('A6', `验证码 ${code} 不可用: ${res.msgs.join('；')}`);
  }
  return false;
}

async function ensureSession(config, log) {
  loadSessionCookies(config);
  const s = await whoami();
  const sessionEmail = s?.identity?.traits?.email;
  const sameAccount = !config?.email || !sessionEmail || sessionEmail.toLowerCase() === String(config.email).toLowerCase();
  if (s?.active && sameAccount) {
    log('AUTH', `已有有效会话${sessionEmail ? `: ${sessionEmail}` : ''}`);
    return true;
  }
  if (s?.active && !sameAccount) {
    log('AUTH', `当前会话属于 ${sessionEmail}，切换为配置账号 ${config.email}`);
    for (const k of [...jar.keys()]) if (/^ory_/i.test(k)) jar.delete(k);
  }
  if (!config?.email || !config?.password) {
    log('AUTH', '没有有效登录会话，且配置缺少邮箱/密码，无法调用 admin.mistral.ai（请先注册/登录）');
    return false;
  }
  const ok = await kratosLogin(config.email, config.password, { mailbox: config.mailbox });
  if (!ok) {
    log('AUTH', '登录失败，admin.mistral.ai 接口仍会 401；请确认账号已激活，或重新运行注册流程');
    return false;
  }
  const r = await fetchRes('GET', `${ADMIN_BASE}/api/local-trpc/user.meSession?input=${TTRPC_INPUT}`, { headers: TTRPC_HEADERS });
  const text = await r.text();
  if (r.status !== 200) {
    log('AUTH', `admin.mistral.ai 会话校验失败: ${r.status}`, text.slice(0, 300));
    return false;
  }
  log('AUTH', 'admin.mistral.ai 会话校验通过');
  return true;
}

// ---------------- interactive prompts ----------------

const rl = createInterface({ input: process.stdin, output: process.stdout });
async function ask(q, def) {
  if (batchAnswers) {
    if (batchIdx < batchAnswers.length) return batchAnswers[batchIdx++];
    return def !== undefined ? def : '';
  }
  const ans = await rl.question(`${q}${def !== undefined ? ` [${def}]` : ''}: `);
  const v = ans.trim();
  if (v === '' && def !== undefined) return def;
  return v;
}
async function confirm(q, def) {
  if (batchAnswers) {
    if (batchIdx < batchAnswers.length) return batchAnswers[batchIdx++] === 'y';
    return def;
  }
  const ans = await rl.question(`${q}${def ? ' [Y/n]' : ' [y/N]'}: `);
  const v = ans.trim().toLowerCase();
  return def ? v !== 'n' : v === 'y';
}

// ---------------- 手动交互输入（始终用中文；不受 --answers 影响） ----------------
// 只有在真实控制台（TTY）下才提问；自动化/管道运行时直接返回默认值，避免卡住。
function isInteractive() {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}
async function askNow(q, def) {
  if (!isInteractive()) return def !== undefined ? def : '';
  const ans = await rl.question(`${q}${def !== undefined ? ` [${def}]` : ''}: `);
  const v = (ans || '').trim();
  return v === '' && def !== undefined ? def : v;
}
async function confirmNow(q, def) {
  if (!isInteractive()) return def;
  const ans = await rl.question(`${q}${def ? ' [Y/n]' : ' [y/N]'}: `);
  const v = (ans || '').trim().toLowerCase();
  return def ? v !== 'n' : v === 'y';
}
function maskCard(n) {
  const s = String(n || '').replace(/\s/g, '');
  return s.length >= 4 ? `**** **** **** ${s.slice(-4)}` : s;
}
// 交互式输入一张卡：卡号（Luhn 校验）/ 有效期 / CVC，确认后返回 card 对象
async function askCardInteractive() {
  log('C', '请手动输入卡信息（卡号可带空格；有效期如 05/2031；CVC 为卡背面 3 位数字）');
  let number = '';
  for (;;) {
    number = (await askNow('卡号', '')).replace(/[\s-]/g, '');
    if (!number) { log('C', '卡号不能为空，请重新输入'); continue; }
    if (!/^\d{12,19}$/.test(number)) { log('C', '卡号应为 12-19 位数字，请重新输入'); continue; }
    if (!luhn(number)) log('C', '提示：卡号未通过 Luhn 校验，大概率无效（仍可继续试试）');
    break;
  }
  let exp = '';
  for (;;) {
    exp = (await askNow('有效期（格式 月/年，如 05/2031 或 05/31）', '')).trim();
    const m = exp.match(/^(\d{1,2})\s*[\/\-.]\s*(\d{2}|\d{4})$/);
    if (!m) { log('C', '格式不对，请按 月/年 重新输入'); continue; }
    const mm = Number(m[1]);
    if (mm < 1 || mm > 12) { log('C', '月份应为 01-12，请重新输入'); continue; }
    exp = `${m[1].padStart(2, '0')}/${m[2].length === 2 ? '20' + m[2] : m[2]}`;
    break;
  }
  let cvc = '';
  for (;;) {
    cvc = (await askNow('CVC 安全码（卡背面 3 位数字）', '')).trim();
    if (!/^\d{3,4}$/.test(cvc)) { log('C', 'CVC 应为 3-4 位数字，请重新输入'); continue; }
    break;
  }
  const [em, ey] = exp.split('/');
  const card = { number, exp_month: em, exp_year: ey, cvc };
  const ok = await confirmNow(`确认使用卡 ${maskCard(number)}，有效期 ${em}/${ey}？`, true);
  return ok ? card : null;
}
function genEmail() {
  return `mistralbot_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@gmail.com`;
}
function genPassword() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  return [...Array(14)].map(() => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ---------------- Phase 1: interactive registration ----------------

const REG_BROWSER_URL = 'https://auth.mistral.ai/self-service/registration/browser?return_to=' + encodeURIComponent('https://chat.mistral.ai/work') + '&after_verification_return_to=' + encodeURIComponent('https://chat.mistral.ai/work');

async function kratosRegister({ email, password, first, last, mailbox }) {
  // 1. GET registration/browser
  const r1 = await fetchRes('GET', REG_BROWSER_URL);
  const r1Text = await r1.text();
  let flowId = jsonOfText(r1Text, 'id');
  if (!flowId) { const m = r1Text.match(/"id":"([0-9a-f-]{36})"/); flowId = m ? m[1] : await ask('Kratos flow id（浏览器页面读不到时手动填入）'); }
  const csrf = csrfFromPage(r1Text);
  log('A1', `flow id: ${flowId}`);

  // 2. POST registration
  const r2 = await fetchRes('POST', `${AUTH_BASE}/self-service/registration?flow=${flowId}`, {
    body: JSON.stringify({ csrf_token: csrf, method: 'password', password, traits: { email, name: { first, last } }, transient_payload: {} }),
    headers: { origin: 'https://v2.auth.mistral.ai', referer: 'https://v2.auth.mistral.ai/' },
  });
  const r2Text = await r2.text();
  let reg = null;
  try { reg = JSON.parse(r2Text); } catch {}
  if (r2.status !== 200 || !reg?.session) {
    log('A2', `注册返回 ${r2.status}`, kratosMessages(r2Text).join('；'));
    return null;
  }
  log('A2', `注册成功: identity ${reg.session.identity?.id}`);

  // 3. 验证码：必须使用注册响应 continue_with 里的 verification flow（HAR 抓包确认）
  const vflow = (reg.continue_with || []).find(c => c.action === 'show_verification_ui')?.flow;
  if (vflow) log('A6', `注册 verification flow: ${vflow.id} — 邮箱 ${email}`);
  else log('A6', '注册响应没有 verification flow，改用重新发送验证码');
  const verified = await verifyEmail({ email, mailbox, log });
  if (!verified) {
    log('A6', '邮箱验证未完成：账号已创建但未激活，后续登录/admin 接口会 401');
    return null;
  }
  await fetchRes('GET', 'https://chat.mistral.ai/work');
  return { identityId: reg.session.identity?.id, sessionId: reg.session.id };
}

// ---------------- --card-only mode ----------------

async function kratosLogin(email, password, { mailbox, retried = false } = {}) {
  log('LOGIN', '登录已有账号…');
  const r1 = await fetchRes('GET', `${AUTH_BASE}/self-service/login/browser?return_to=${encodeURIComponent('https://chat.mistral.ai/work')}`, { redirect: 'manual' });
  if (r1.status >= 300 && r1.status < 400) {
    const s = await whoami();
    if (s?.active) { log('LOGIN', '已存在有效会话'); return true; }
  }
  const r1Text = await r1.text();
  const flowId = jsonOfText(r1Text, 'id');
  const csrf = csrfFromPage(r1Text);
  if (!flowId) { log('LOGIN', `无法创建登录 flow（${r1.status}）`); return false; }
  log('LOGIN', `flow id: ${flowId}`);

  // 步骤 1：identifier_first。Mistral 的 Kratos 会返回 400，但 flow 会切到 password，这是正常行为。
  const r2 = await fetchRes('POST', `${AUTH_BASE}/self-service/login?flow=${flowId}`, {
    body: JSON.stringify({ csrf_token: csrf, method: 'identifier_first', identifier: email, transient_payload: {} }),
    headers: { origin: 'https://v2.auth.mistral.ai', referer: 'https://v2.auth.mistral.ai/' },
  });
  const r2Text = await r2.text();
  const csrf2 = csrfFromPage(r2Text);
  log('LOGIN', `identifier_first: ${r2.status}${csrf2 ? '' : '（未取到下一步 csrf）'}`);
  if (!csrf2) { log('LOGIN', `登录失败: ${kratosMessages(r2Text).join('；')}`); return false; }

  // 步骤 2：password。抓包确认必须带 identifier，且不要带 traits。
  const r3 = await fetchRes('POST', `${AUTH_BASE}/self-service/login?flow=${flowId}`, {
    body: JSON.stringify({ csrf_token: csrf2, method: 'password', identifier: email, password }),
    headers: { origin: 'https://v2.auth.mistral.ai', referer: 'https://v2.auth.mistral.ai/' },
  });
  const r3Text = await r3.text();
  let r3Json = null;
  try { r3Json = JSON.parse(r3Text); } catch {}
  const msgs = kratosMessages(r3Text);
  if (r3.status === 200 && r3Json?.session?.active) {
    log('LOGIN', `登录成功: identity ${r3Json.session.identity?.id}`);
    return true;
  }
  log('LOGIN', `password login: ${r3.status} ${msgs.join('；')}`);

  // 账号未激活：用临时邮箱重新走验证码流程，然后重试一次登录
  const inactive = msgs.some(m => /not active|verify your email/i.test(m))
    || (r3Json?.ui?.nodes || []).some(n => (n.messages || []).some(m => /not active|verify your email/i.test(m.text || '')));
  if (inactive && mailbox && !retried) {
    log('LOGIN', '账号未激活（邮箱未验证），尝试重新验证邮箱…');
    const verified = await verifyEmail({ email, mailbox, log });
    if (verified) return kratosLogin(email, password, { mailbox, retried: true });
  } else if (inactive) {
    log('LOGIN', '账号未激活（邮箱未验证）；配置里没有可用临时邮箱，无法自动修复。请重新运行注册流程。');
  }
  return false;
}

async function cardOnlyMode() {
  log('C', '--- 卡信息：仅需输入卡号/CVC/有效期，其余（地址/优惠码）自动获取 ---');
  const card = {};
  for (const f of ['number', 'cvc', 'exp_month', 'exp_year']) {
    let v = '';
    for (;;) {
      v = (await ask(`卡号字段 ${f}`)).trim();
      if (!v) { log('C', `${f} 不能为空（卡号需 12-19 位数字）`); continue; }
      break;
    }
    card[f] = f === 'number' ? v.replace(/\s/g, '') : v;
  }
  const errs = validateCard(card);
  if (errs.length) { log('C', '卡号格式校验失败: ' + errs.join('；')); return; }
  if (!luhn(card.number)) log('C', '卡号未通过 Luhn 校验（可能是非测试卡，继续保存仍可）');

  log('ADDR', '从 addresslab.net 获取地址…');
  let address = null;
  try {
    const r = await fetchRes('GET', ADDRESSABLAB_UK);
    address = await extractAddressLab(await r.text());
  } catch (e) {
    log('ADDR', 'AddressLab 不可用: ' + e.message);
  }
  if (!address) {
    log('ADDR', 'AddressLab 页面未提取到地址，请手动输入（格式: "1 Oxford St, London EC1A 1BB"）');
    const s = await ask('地址 (Address): ');
    address = parseAddress(s);
    if (!address) { log('ADDR', '地址无法解析，放弃'); return; }
  }
  log('ADDR', `地址（addresslab）: ${address.address_line1}, ${address.city}, ${address.zipcode}`);

  const promoCode = (await ask('优惠码 (promo code, 默认 MISTRALVIBE)', 'MISTRALVIBE')).trim() || 'MISTRALVIBE';

  const existing = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};
  const config = {
    version: 1,
    card,
    address,
    promo_code: promoCode,
    registered_at: existing.registered_at || new Date().toISOString(),
    email: existing.email || genEmail(),
    password: existing.password,
    first: existing.first,
    last: existing.last,
    identity_id: existing.identity_id || null,
    mailbox: existing.mailbox || null,
    session: existing.session || null,
  };
  await saveConfig(config, CONFIG_PATH);
  log('CFG', `配置已保存到 ${CONFIG_PATH}`);

  if (await confirm('继续执行地址填充 + 绑卡 + 优惠码兑换全流程?', false)) {
    try {
      await continueFlow(config);
    } finally {
      writeConfigWithSession(config);
    }
  } else {
    log('F', '流程结束（配置已保存）。');
  }
}

// ---------------- Phase 2: save config ----------------

function validateCard(card) {
  const num = (card.number || '').replace(/\s/g, '');
  const errs = [];
  if (!/^\d{13,19}$/.test(num)) errs.push('卡号必须是 13-19 位数字');
  if (!/^\d{3,4}$/.test(card.cvc || '')) errs.push('CVC 必须是 3-4 位数字');
  if (!/^\d{2}$/.test(card.exp_month || '')) errs.push('有效期月 必须是 2 位数字 (MM)');
  if (!/^\d{2,4}$/.test(card.exp_year || '')) errs.push('有效期年 必须是 2-4 位数字 (YY 或 YYYY)');
  return errs;
}

function luhn(num) {
  let s = 0, dbl = false;
  for (let i = num.length - 1; i >= 0; i--) { let d = +num[i]; if (dbl) { d *= 2; if (d > 9) d -= 9; } s += d; dbl = !dbl; }
  return s % 10 === 0;
}

async function getAddressInteractive() {
  let addr = null;
  try {
    const r = await fetchRes('GET', ADDRESSABLAB_UK);
    const t = await r.text();
    addr = await extractAddressLab(t);
    log('ADDR', addr ? `AddressLab 自动获取: ${addr.address_line1}, ${addr.city}, ${addr.zipcode}` : '未从 AddressLab 页面提取到地址');
  } catch (e) {
    log('ADDR', 'AddressLab 不可用: ' + e.message);
  }
  while (!addr) {
    const s = await ask('地址 (Address, e.g. "1 Oxford St, London EC1A 1BB")');
    if (!s) { log('ADDR', '地址不能为空'); continue; }
    addr = parseAddress(s);
    if (!addr || !addr.address_line1 || !addr.city) { log('ADDR', '无法解析该地址字符串'); addr = null; }
  }
  const ok = await confirm(`使用地址 ${addr.address_line1}, ${addr.city}, ${addr.zipcode}?`, true);
  if (!ok) {
    const s = await ask('地址 (Address)');
    addr = parseAddress(s);
  }
  return addr;
}

async function saveConfig(config, path) {
  writeFileSync(path, JSON.stringify(config, null, 2));
  log('CFG', `配置已保存到 ${path}（包含密码、卡号、地址、优惠码等敏感信息，请注意保管）`);
  // 同时登记到 accounts.json，并导出浏览器可导入的登录 cookie（cookies/<email>.txt|json）
  try {
    const rec = upsertAccount(config, path);
    if (rec) log('CFG', `账号已登记到 accounts.json，登录 cookie 已导出到 cookies/（可导入浏览器直接打开网页）`);
  } catch (e) {
    log('CFG', 'accounts.json 登记失败: ' + e.message);
  }
}

// 保存会话 cookie 回配置文件，并同步更新 accounts.json 登记表 + cookies/ 导出
function writeConfigWithSession(config) {
  config.session = { ...(config.session || {}), cookies: sessionCookies(), saved_at: new Date().toISOString() };
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  try { upsertAccount(config, CONFIG_PATH); } catch { /* 登记失败不影响主流程 */ }
}

// ---------------- Phase 3: continue flows (address → card → redeem) ----------------

// ---------------- 出口 IP 地区预检（兑换的 country 校验看请求出口 IP） ----------------
// 实测：同一账号同一资料，日本出口 country_not_eligible，德国出口通过。
const EU_CC = new Set(['GB', 'DE', 'FR', 'NL', 'IE', 'BE', 'LU', 'AT', 'CH', 'SE', 'DK', 'FI', 'NO', 'ES', 'IT', 'PT', 'PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'GR', 'SI', 'HR', 'EE', 'LV', 'LT', 'CY', 'MT', 'IS', 'LI', 'MC', 'AD', 'SM', 'VA']);
async function getEgressCountry() {
  for (const url of ['https://ipinfo.io/country', 'https://ipapi.co/country/']) {
    try {
      const r = await fetchRes('GET', url, { forceProxy: true });
      const t = (await r.text()).trim();
      if (/^[A-Z]{2}$/.test(t)) return t;
    } catch { /* try next */ }
  }
  return null;
}

// 命令行可覆盖各阶段：--skip-address / --skip-card / --skip-redeem
// （用于验证「兑换是否强制要求绑卡」等单变量实验）
const SKIP_STAGES = {
  doAddress: opts['skip-address'] === 'true',
  doCard: opts['skip-card'] === 'true',
  doRedeem: opts['skip-redeem'] === 'true',
};

// Stripe 3DS2 第一步：POST /v1/3ds2/authenticate（即 Stripe.js prepare3DS2Authentication 的真实端点）。
// three_ds_method_url 为空时 Stripe.js 不做指纹，上报 fingerprintOutcome=not_supported。
// 响应 ares.transStatus: Y/U/E/A → 摩擦less通过（intent 会被置为 succeeded）；C → 需要发卡行挑战(OTP)；R/N → 被拒。
async function stripe3ds2Authenticate(act) {
  const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
  const width = 1200;
  const browser = {
    fingerprintAttempted: false,
    fingerprintData: null,
    challengeWindowSize: width < 390 ? '01' : width < 500 ? '02' : width < 600 ? '03' : width < 768 ? '04' : '05',
    threeDSCompInd: 'Y',
    browserJavaEnabled: false,
    browserJavascriptEnabled: true,
    browserLanguage: 'en-US',
    browserColorDepth: '24',
    browserScreenHeight: '1080',
    browserScreenWidth: '1920',
    browserTZ: String(new Date().getTimezoneOffset()),
    browserUserAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
  const form = new URLSearchParams();
  form.set('source', act.three_d_secure_2_source);
  form.set('browser', JSON.stringify(browser));
  const ds = { hosted: 'false', same_origin_frame: 'true', spc_eligible: 'false', webauthn_eligible: 'true', publickey_credentials_get_allowed: 'true' };
  for (const [k, v] of Object.entries(ds)) form.set(`one_click_authn_device_support[${k}]`, v);
  form.set('frontend_execution', b64({ fingerprintOutcome: 'not_supported' }));
  const r = await fetchRes('POST', 'https://api.stripe.com/v1/3ds2/authenticate', {
    body: form.toString(),
    headers: { authorization: `Bearer ${KEY_PK}`, origin: 'https://js.stripe.com', 'content-type': 'application/x-www-form-urlencoded', 'stripe-version': '2020-08-27' },
  });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch {}
  if (r.status >= 400) log('D5', `3ds2/authenticate 失败: ${r.status}`, t.slice(0, 400));
  return { status: r.status, body: j || t };
}

async function continueFlow(config, { doAddress = true, doCard = true, doRedeem = true } = {}) {
  if (SKIP_STAGES.doAddress) doAddress = false;
  if (SKIP_STAGES.doCard) doCard = false;
  if (SKIP_STAGES.doRedeem) doRedeem = false;
  const email = config.email;
  const address = config.address;
  const coupon = config.promo_code || 'MISTRALVIBE';

  // 关键：先确保有 Kratos 登录会话，否则 admin.mistral.ai 全部 401
  if (!(await ensureSession(config, log))) {
    throw new Error('没有有效的登录会话（这就是 updateInfo / setup intent 返回 401 的根因）');
  }
  if ((doAddress || doCard) && (!address || !address.address_line1 || !address.city || !address.zipcode)) {
    throw new Error('配置中没有完整地址（address_line1/city/zipcode），无法执行地址填充/绑卡');
  }

  if (doAddress) {
    log('C', '--- 身份地址填充 ---');
    const legalName = config.first && config.last ? `${config.first} ${config.last}` : (email || '').split('@')[0];
    const r = await fetchRes('POST', `${ADMIN_BASE}/api/local-trpc/billing.updateInfo`, {
      body: JSON.stringify({ json: { legal_name: legalName, email, address_line1: address.address_line1, city: address.city, zipcode: address.zipcode, country: address.country, state: null, tax_identification_number: '', customer_type: 'individual' } }),
      headers: TTRPC_HEADERS,
    });
    const text = await r.text();
    if (r.status === 200) log('C', 'updateInfo 成功', jstr(jsonOfText(text, 'result', 'data', 'json'), 400));
    else { log('C', `updateInfo 返回 ${r.status}`, text.slice(0, 300)); throw new Error('地址填充失败'); }
  }

  if (doCard) {
    log('D', '--- 创建 Setup Intent + 绑卡 ---');
    let card = config.card;
    if (!card || !card.number) {
      log('D', '配置中没有卡号');
      if (isInteractive()) {
        const nc = await askCardInteractive();
        if (nc) { card = nc; config.card = nc; }
      }
      if (!card || !card.number) throw new Error('配置中没有卡号，且未手动输入（可在 GUI「单账号流水线」页先设置卡号）');
    }
    // 交互环境：绑卡前可选择手动换卡
    if (isInteractive()) {
      const swap = await confirmNow(`当前配置卡号 ${maskCard(card.number)}（有效期 ${card.exp_month}/${card.exp_year}），要手动输入其它卡号吗？`, false);
      if (swap) {
        const nc = await askCardInteractive();
        if (nc) { card = nc; config.card = nc; log('D', `已改用手动输入的卡 ${maskCard(nc.number)}`); }
        else log('D', '未采用手动输入，继续使用原卡');
      }
    }
    const r = await fetchRes('POST', `${ADMIN_BASE}/api/local-trpc/billing.createPaymentMethodSetupIntent`, {
      body: JSON.stringify({ json: null, meta: { values: ['undefined'], v: 1 } }),
      headers: TTRPC_HEADERS,
    });
    const text = await r.text();
    const intentSecret = jsonOfText(text, 'result', 'data', 'json', 'intent_secret');
    if (!intentSecret) { log('D1', `创建 setup intent 失败: ${r.status}`, text.slice(0, 300)); throw new Error('无法创建 setup intent'); }
    const setupIntentId = intentSecret.split('_secret_')[0];
    log('D1', `intent_secret: ${intentSecret}`, `setup intent: ${setupIntentId}`);

    // 抓包中的 Stripe 预检请求
    await fetchRes('GET', `https://api.stripe.com/v1/elements/sessions?client_secret=${encodeURIComponent(intentSecret)}&key=${KEY_PK}`, { headers: { origin: ADMIN_BASE, referer: `${ADMIN_BASE}/` } });
    const bin = card.number.replace(/\s/g, '').slice(0, 6);
    await fetchRes('GET', `https://api.stripe.com/v1/edge-internal/card-metadata?bin_prefix=${bin}&key=${KEY_PK}`, { headers: { origin: ADMIN_BASE, referer: `${ADMIN_BASE}/` } });
    const consumerBody = new URLSearchParams({
      request_surface: 'web_link_authentication_in_payment_element',
      'transaction_context[link_supported_payment_methods][0]': 'CARD',
      'transaction_context[link_mode]': 'LINK_CARD_BRAND',
      'supported_payment_details_types[0]': 'CARD',
      'supported_payment_details_types[1]': 'BANK_ACCOUNT',
      'supported_payment_details_types[2]': 'KLARNA',
      'supported_payment_details_types[3]': 'BALANCE',
      'supported_payment_details_types[4]': 'PIX',
      'supported_payment_details_types[5]': 'CRYPTO',
      'supported_payment_details_types[6]': 'SEPA_BANK_ACCOUNT',
      'supported_payment_details_types[7]': 'UPI',
      email_address: email,
      email_source: 'no_code_default_value',
      key: KEY_PK,
    });
    await fetchRes('POST', 'https://api.stripe.com/v1/consumers/sessions/lookup', { body: consumerBody.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ADMIN_BASE, referer: `${ADMIN_BASE}/` } });

    const returnUrl = `${ADMIN_BASE}/subscription/upgrade/redeem?redeem_code=${encodeURIComponent(coupon)}&setup_intent_state=${encodeURIComponent(JSON.stringify({ type: 'coupon_redemption' }))}`;

    let bound = false;
    let lastErr = '';
    for (let attempt = 1; attempt <= 6 && !bound; attempt++) {
      if (attempt > 1) {
        log('D', `--- 第 ${attempt} 次绑卡尝试：请手动输入一张新卡 ---`);
        const nc = await askCardInteractive();
        if (nc) {
          card = nc;
          config.card = nc;
          try { writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); upsertAccount(config, CONFIG_PATH); } catch {}
          log('D', `已改用新卡 ${maskCard(nc.number)}，并写入配置`);
          const nb = card.number.replace(/\s/g, '').slice(0, 6);
          await fetchRes('GET', `https://api.stripe.com/v1/edge-internal/card-metadata?bin_prefix=${nb}&key=${KEY_PK}`, { headers: { origin: ADMIN_BASE, referer: `${ADMIN_BASE}/` } });
        } else {
          log('D', '未采用手动输入，将重试同一张卡');
        }
      }

      const formattedCard = card.number.replace(/\s/g, '').replace(/(\d{4})(?=\d)/g, '$1 ');
      // 参数与 HAR 中的 Stripe confirm 保持一致（use_stripe_sdk / client_secret / key / allow_redisplay 位置）
      const params = new URLSearchParams({
        return_url: returnUrl,
        'payment_method_data[type]': 'card',
        'payment_method_data[card][number]': formattedCard,
        'payment_method_data[card][cvc]': card.cvc,
        'payment_method_data[card][exp_year]': card.exp_year,
        'payment_method_data[card][exp_month]': card.exp_month,
        'payment_method_data[allow_redisplay]': 'unspecified',
        'payment_method_data[billing_details][address][postal_code]': address.zipcode,
        'payment_method_data[billing_details][address][country]': address.country,
        'payment_method_data[pasted_fields]': 'zip',
        'payment_method_data[referrer]': ADMIN_BASE,
        'payment_method_data[payment_user_agent]': 'stripe.js/4b3a4bb7b4; stripe-js-v3/4b3a4bb7b4; payment-element',
        expected_payment_method_type: 'card',
        use_stripe_sdk: 'true',
        key: KEY_PK,
        client_secret: intentSecret,
      });
      log('D5', `确认绑卡: number=${formattedCard} cvc=${card.cvc} exp=${card.exp_month}/${card.exp_year} postal=${address.zipcode}`);
      const rc = await fetchRes('POST', `https://api.stripe.com/v1/setup_intents/${setupIntentId}/confirm`, {
        body: params.toString(),
        headers: { accept: 'application/json, text/plain, */*', origin: ADMIN_BASE, referer: `${ADMIN_BASE}/subscription/upgrade/redeem`, 'content-type': 'application/x-www-form-urlencoded' },
      });
      const rcText = await rc.text();
      let rcJson = null;
      try { rcJson = JSON.parse(rcText); } catch {}
      const si = rcJson?.setup_intent || rcJson;
      lastErr = '';
      let needVerify = false;

      if (rc.status >= 400) {
        const code = rcJson?.error?.code || '';
        const dc = rcJson?.error?.decline_code || '';
        const msg = (rcJson?.error?.message || rcText).slice(0, 300);
        const whyZh = code === 'incorrect_number' ? '卡号无效（发卡行不认识这个号）'
          : code === 'card_declined' ? `发卡行拒付${dc ? `（${dc}）` : ''}——卡可能已失效/余额不足/不支持零金额预授权，或需要冷却一段时间再试`
          : code === 'expired_card' ? '卡已过期'
          : code === 'incorrect_cvc' ? 'CVC 安全码错误'
          : code === 'invalid_expiry_month' || code === 'invalid_expiry_year' ? '有效期错误'
          : code === 'processing_error' ? '发卡行处理错误（建议稍后重试）'
          : code === 'card_not_supported' ? '该卡不支持此类交易'
          : (msg || '未知错误');
        lastErr = `绑卡被拒绝：${whyZh}`;
        log('D5', `绑卡确认失败（HTTP ${rc.status}）: ${code}${dc ? '/' + dc : ''} — ${whyZh}`);
      } else if (si?.status === 'requires_action') {
        const na = si.next_action || {};
        const u = na.use_stripe_sdk || {};
        if (na.type === 'use_stripe_sdk' && u.type === 'stripe_3ds2_fingerprint') {
          const a = await stripe3ds2Authenticate(u);
          const body = a.body;
          const ts = body?.ares?.transStatus;
          log('D5', `3DS2 authenticate: http=${a.status} state=${body?.state} transStatus=${ts}${body?.error ? ` error=${JSON.stringify(body.error)}` : ''}`);
          if (ts === 'C' && body?.creq) {
            lastErr = '绑卡需要 3DS 挑战验证（发卡行 OTP/银行 App 确认），脚本无法自动完成，请换一张不需要 3DS 的卡';
          } else if (ts === 'R' || ts === 'N') {
            lastErr = `3DS 认证被发卡行拒绝（transStatus=${ts}），此卡不可用于自动绑卡`;
          } else if (body?.error) {
            lastErr = `3DS 认证出错（${body.error.errorDescription || body.error.errorCode || JSON.stringify(body.error)}），可换卡重试`;
          } else {
            needVerify = true; // Y/U/E/A 等 → 摩擦less通过，走状态校验
          }
        } else {
          log('D5', '绑卡需要额外验证（非 3DS2 指纹类型），无法自动完成', jstr(si.next_action, 300));
          lastErr = '绑卡需要 3DS 验证，暂不支持该类型';
        }
      } else {
        needVerify = true;
      }

      if (needVerify) {
        log('D5', '确认结果', jstr(si, 500));
        // 与 HAR 一样，再查一次 setup intent 确认最终状态
        const rg = await fetchRes('GET', `https://api.stripe.com/v1/setup_intents/${setupIntentId}?client_secret=${encodeURIComponent(intentSecret)}&is_stripe_sdk=false&key=${KEY_PK}`, { headers: { origin: ADMIN_BASE, referer: `${ADMIN_BASE}/` } });
        const gj = await jsonOf(rg);
        if (gj?.status === 'succeeded') {
          log('D5', 'Stripe 校验: setup_intent status=succeeded');
          // 回跳页（模仿 HAR 中的 redirect_status=succeeded）
          await fetchRes('GET', `${returnUrl}&setup_intent=${setupIntentId}&setup_intent_client_secret=${encodeURIComponent(intentSecret)}&redirect_status=succeeded`);
          bound = true;
        } else {
          lastErr = `绑卡未成功（Stripe 状态：${gj?.status || rg.status}）`;
          log('D5', `Stripe 校验失败: ${gj?.status || rg.status}`, jstr(gj, 400));
        }
      }

      if (bound) break;
      if (!isInteractive()) throw new Error(lastErr || '绑卡失败');
      const again = await confirmNow(`${lastErr}。要手动输入一张新卡重试吗？`, true);
      if (!again) throw new Error(lastErr || '绑卡失败');
      lastErr = '';
    }
    if (!bound) throw new Error(lastErr || '绑卡失败');
    log('D', `绑卡完成：${maskCard(card.number)}`);
  }

  if (doRedeem) {
    log('E', '--- 用优惠码兑换订阅 ---');
    const cc = await getEgressCountry();
    log('E', `出口 IP 国家: ${cc || '未知'}${proxyAgent ? '（经 --proxy）' : '（直连）'}`);
    if (cc && !EU_CC.has(cc)) {
      log('E', `注意：Mistral 兑换按请求出口 IP 判定地区，当前 ${cc} 不在欧洲活动范围`);
      log('E', '（实测：日本出口返回 country_not_eligible，德国出口通过）。继续尝试，若失败请切换欧洲节点后重跑。');
    }
    const r1 = await fetchRes('POST', `${ADMIN_BASE}/api/local-trpc/billing.landingCoupon`, {
      body: JSON.stringify({ json: { couponCode: coupon } }),
      headers: TTRPC_HEADERS,
    });
    const t1 = await r1.text();
    const expectedReward = jsonOfText(t1, 'result', 'data', 'json', 'reward');
    if (r1.status !== 200 || !expectedReward) { log('E0', `优惠券信息获取失败: ${r1.status}`, t1.slice(0, 300)); throw new Error('优惠券不可用或登录失效'); }
    const eligibility = jsonOfText(t1, 'result', 'data', 'json', 'eligibility');
    const redemptionStatus = jsonOfText(t1, 'result', 'data', 'json', 'redemption_status');
    log('E0', `优惠券 eligibility: ${eligibility ?? 'null'}，redemption_status: ${redemptionStatus ?? 'null'}`);
    log('E0', '优惠券信息', jstr(expectedReward));
    const r2 = await fetchRes('POST', `${ADMIN_BASE}/api/local-trpc/billing.redeemSubscriptionCoupon`, {
      body: JSON.stringify({ json: { couponCode: coupon, expectedReward } }),
      headers: TTRPC_HEADERS,
    });
    const t2 = await r2.text();
    if (r2.status === 200) {
      log('E1', '兑换成功', jstr(jsonOfText(t2, 'result', 'data', 'json')));
    } else {
      const reason = jsonOfText(t2, 'error', 'json', 'data', 'dashboardErrorReason')
        || jsonOfText(t2, 'error', 'json', 'message')
        || t2.slice(0, 200);
      log('E1', `兑换返回 ${r2.status}${reason ? ' — ' + reason : ''}`);
      if (reason === 'country_not_eligible') {
        log('E1', '地区不合格：Mistral 按请求出口 IP 判定（实测日本出口被拒、德国出口通过）。');
        log('E1', '修复：把代理节点切到欧洲（英国/德国等），或加 --proxy <欧洲代理地址>，然后重跑兑换（地址填充/绑卡已完成）。');
      } else if (reason === 'already_redeemed') {
        log('E1', '该优惠码已被兑换过（按卡片/账单信息去重）：这张卡已在其它账号成功兑换，');
        log('E1', '需要换新卡（或换卡+不同账单邮编）才能再次兑换；地址填充和绑卡本身已完成。');
      }
      throw new Error(`优惠码兑换失败${reason ? ': ' + reason : ''}`);
    }
  }

  log('F', '--- 校验 ---');
  const rf = await fetchRes('GET', `${ADMIN_BASE}/api/local-trpc/billing.info?input=${TTRPC_INPUT}`, { headers: TTRPC_HEADERS });
  log('F', `billing.info: ${rf.status}`);
  await fetchRes('GET', `${ADMIN_BASE}/subscription`);
  log('F', '--- 流程执行结束 ---');
}

// ---------------- 旧账号不可用时：沿用卡/地址/优惠码重新注册 ----------------

async function reRegisterWithConfig(base) {
  log('CFG', '旧账号不可用：沿用当前卡/地址/优惠码注册新账号');
  const mailbox = await createMailbox(log);
  if (!mailbox) { log('A', '无法创建临时邮箱，注册终止'); return; }
  const emailOpt = opts['email'] && opts['email'] !== 'true' ? opts['email'] : '';
  const email = emailOpt || mailbox.email;
  const usedAuto = !emailOpt && email === mailbox.email;
  const pwOpt = opts['password'] && opts['password'] !== 'true' ? opts['password'] : '';
  const password = pwOpt || base.password || genPassword();
  const first = base.first || await ask('名/First name', '');
  const last = base.last || await ask('姓/Last name', '');
  const regResult = await kratosRegister({ email, password, first, last, mailbox: usedAuto ? mailbox : null });
  if (!regResult) { log('A', '注册未完成'); process.exitCode = 1; return; }

  if (!SKIP_STAGES.doCard && (!base.card || !base.card.number)) {
    log('C', '配置中没有卡号，无法继续；请先用 --card-only 保存卡号');
    process.exitCode = 1; // 注册已成功但流程中止：必须非 0，否则上层会误以为成功
    return;
  }
  if (SKIP_STAGES.doCard && (!base.card || !base.card.number)) {
    log('C', '跳过绑卡（--skip-card）：不需要卡号');
  }
  const address = base.address || await getAddressInteractive();
  const config = {
    ...base,
    version: 1,
    registered_at: new Date().toISOString(),
    email,
    password,
    first,
    last,
    card: base.card,
    address,
    promo_code: base.promo_code || 'MISTRALVIBE',
    identity_id: regResult.identityId || null,
    mailbox: usedAuto ? mailbox : null,
    session: { cookies: sessionCookies(), saved_at: new Date().toISOString() },
  };
  await saveConfig(config, CONFIG_PATH);

  if (await confirm('继续执行地址填充 + 绑卡 + 优惠码兑换全流程?', true)) {
    try {
      await continueFlow(config);
    } finally {
      writeConfigWithSession(config);
    }
  } else {
    log('F', '流程结束（配置已保存）。');
  }
}

// ---------------- main ----------------

async function main() {
  if (opts['card-only'] === 'true') { await cardOnlyMode(); rl.close(); return; }
  const loading = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : null;

  if (loading) {
    log('CFG', `读取已有配置: ${CONFIG_PATH}`);
    if (opts['new-account'] === 'true') {
      await reRegisterWithConfig(loading);
      rl.close();
      return;
    }
    if (opts['no-continue'] === 'true') { log('CFG', '--no-continue: 退出。'); rl.close(); return; }

    // 先确认登录会话。旧账号如果未验证且没有临时邮箱，会自动提示重新注册。
    if (!(await ensureSession(loading, log))) {
      if (await confirm('登录失败。是否沿用当前配置的卡/地址/优惠码注册新账号?', true)) {
        await reRegisterWithConfig(loading);
      } else {
        log('CFG', '已取消：账号未验证时无法调用 admin.mistral.ai（updateInfo/绑卡/兑换都会 401）');
        process.exitCode = 1;
      }
      rl.close();
      return;
    }
    loading.session = { ...(loading.session || {}), cookies: sessionCookies(), saved_at: new Date().toISOString() };
    writeFileSync(CONFIG_PATH, JSON.stringify(loading, null, 2));
    try { upsertAccount(loading, CONFIG_PATH); } catch {}

    const doC = await confirm('执行地址填充?', true);
    const doD = await confirm('执行绑卡?', true);
    const doE = await confirm('执行优惠码兑换?', true);
    try {
      await continueFlow(loading, { doAddress: doC, doCard: doD, doRedeem: doE });
    } finally {
      // 保存登录会话，后续运行可直接复用（Kratos session 有效期约 3 个月）
      writeConfigWithSession(loading);
    }
    rl.close();
    return;
  }

  log('INFO', '交互式注册新账号 — 按提示输入信息');

  // Phase 1: registration
  const emailOpt = opts['email'] && opts['email'] !== 'true' ? opts['email'] : '';
  const forceAuto = opts['auto-email'] === 'true';
  const autoMailbox = !emailOpt && (forceAuto || opts['no-auto-email'] !== 'true') ? await createMailbox(log) : null;
  const email = emailOpt
    ? emailOpt
    : (forceAuto && autoMailbox ? autoMailbox.email : await ask('邮箱 (email, 接收验证码)', autoMailbox ? autoMailbox.email : genEmail()));
  const pwOpt = opts['password'] && opts['password'] !== 'true' ? opts['password'] : '';
  const password = pwOpt || await ask('密码 (password)', genPassword());
  const first = await ask('名/First name', '');
  const last = await ask('姓/Last name', '');
  log('A', '--- 注册阶段 ---');
  const usedAuto = !!(autoMailbox && email === autoMailbox.email);
  const regResult = await kratosRegister({ email, password, first, last, mailbox: usedAuto ? autoMailbox : null });
  if (!regResult) { log('A', '注册未完成'); rl.close(); return; }

  // Phase 2: card info + promo + address
  log('C', '--- 配置：卡号信息 ---');
  const card = {};
  for (const f of ['number', 'cvc', 'exp_month', 'exp_year']) {
    let v = '';
    for (;;) {
      v = (await ask(`卡号字段 ${f}`)).trim();
      if (!v) { log('C', `${f} 不能为空（卡号需 12-19 位数字）`); continue; }
      break;
    }
    card[f] = f === 'number' ? v.replace(/\s/g, '') : v;
  }
  const errs = validateCard(card);
  if (errs.length) { log('C', '卡号格式校验失败: ' + errs.join('；')); rl.close(); return; }
  if (!luhn(card.number)) log('C', '卡号未通过 Luhn 校验（可能是非测试卡，继续保存仍可）');

  const promoCode = (await ask('优惠码 (promo code)', 'MISTRALVIBE')).trim() || 'MISTRALVIBE';
  log('C', '--- 配置：身份地址 ---');
  const address = await getAddressInteractive();

  const config = {
    version: 1,
    registered_at: new Date().toISOString(),
    email,
    password,
    first: first || '',
    last: last || '',
    card,
    address,
    promo_code: promoCode,
    identity_id: regResult.identityId || null,
    mailbox: usedAuto ? autoMailbox : null,
    session: { cookies: sessionCookies(), saved_at: new Date().toISOString() },
  };
  await saveConfig(config, CONFIG_PATH);

  // Phase 3: continue
  if (await confirm('继续执行地址填充 + 绑卡 + 优惠码兑换全流程?', true)) {
    try {
      await continueFlow(config);
    } finally {
      writeConfigWithSession(config);
    }
  } else {
    log('F', '流程结束（配置已保存）。');
  }
  rl.close();
}

main().catch(e => { log('ERROR', e.message); rl.close(); process.exitCode = 1; });
