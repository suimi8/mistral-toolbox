#!/usr/bin/env node
/**
 * pro_check.mjs — 检测账号是否 Pro 订阅（用于“Pro 才入池”）
 *
 * 原理：带账号会话 cookie 请求 https://admin.mistral.ai/subscription，
 *       解析 “Current plan” 后面的套餐名（实测：Pro / Free，兼容 Team / Business / Enterprise）。
 *
 * 用法：
 *   node pro_check.mjs --all                      # 检测 accounts.json 全部账号并写回 pro 字段
 *   node pro_check.mjs --config test_fresh_config.json
 *   node pro_check.mjs --email a@b.c
 *   node pro_check.mjs --all --concurrency 4
 *   node pro_check.mjs --all --json               # 额外打印 JSON 汇总
 *   node pro_check.mjs --all --proxy http://127.0.0.1:7897
 *
 * 写回字段（accounts.json）：
 *   pro             true / false / null（null = 未检出）
 *   pro_plan        套餐名（Pro / Free / ...）
 *   pro_checked_at  检测时间
 *   in_pool         检测成功即入池（Pro / Free 都入池；只有检测失败才是 false）
 *
 * 产物：pro_report.json（最近一次检测汇总，不含密码 / cookie）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAccounts, upsertAccount } from './mistral_accounts.mjs';

const ADMIN = 'https://admin.mistral.ai';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 Edg/144.0.0.0';
const PLAN_RE = /Current plan[\s\S]{0,800}?text-2xl[^>]*>([^<]{1,40})</;
const PLAN_FALLBACK_RE = /text-2xl font-semibold[^>]*>([^<]{1,40})</;

/** 从订阅页 HTML 中解析当前套餐名 */
export function parsePlanFromHtml(html) {
  const s = String(html || '');
  const m = s.match(PLAN_RE) || s.match(PLAN_FALLBACK_RE);
  return m ? m[1].trim() : null;
}

/** 套餐是否属于 Pro 级别（Pro / Team / Business / Enterprise 都算付费可用） */
export function isProPlan(plan) {
  return /^(pro|team|business|enterprise)$/i.test(String(plan || '').trim());
}

function cookieHeader(cookies) {
  return Object.entries(cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ');
}

/** 运行参数里的代理（batch_register 等透传 --proxy 时，本模块自动复用） */
function globalProxy() {
  const i = process.argv.indexOf('--proxy');
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return process.env.MISTRAL_PROXY || null;
}

let proxyDispatcher = null;
async function proxyFetch(url, opts) {
  const proxy = globalProxy();
  if (!proxy) return fetch(url, opts);
  const { fetch: ufetch, ProxyAgent } = await import('undici');
  if (!proxyDispatcher) proxyDispatcher = new ProxyAgent(proxy);
  return ufetch(url, { ...opts, dispatcher: proxyDispatcher });
}

/**
 * 用一组 cookie 检测 Pro 状态。
 * @returns {Promise<{ok:boolean,status:number,plan:string|null,pro:boolean|null,error:string|null,checked_at:string}>}
 */
export async function checkCookies(cookies, { timeoutMs = 25000 } = {}) {
  const checked_at = new Date().toISOString();
  const cookie = cookieHeader(cookies);
  if (!cookie) return { ok: false, status: 0, plan: null, pro: null, error: '无会话 cookie', checked_at };
  try {
    const r = await proxyFetch(`${ADMIN}/subscription`, {
      headers: {
        cookie,
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml',
        referer: `${ADMIN}/`,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const html = await r.text();
    if (r.status !== 200) {
      const err = r.status >= 300 && r.status < 400
        ? '会话已失效（被重定向到登录页）'
        : `HTTP ${r.status}`;
      return { ok: false, status: r.status, plan: null, pro: null, error: err, checked_at };
    }
    const plan = parsePlanFromHtml(html);
    if (!plan) return { ok: false, status: r.status, plan: null, pro: null, error: '订阅页未找到套餐名', checked_at };
    return { ok: true, status: r.status, plan, pro: isProPlan(plan), error: null, checked_at };
  } catch (e) {
    return { ok: false, status: 0, plan: null, pro: null, error: e.message, checked_at };
  }
}

/** 检测 accounts.json 中的一条账号记录 */
export async function checkAccount(rec) {
  const r = await checkCookies(rec?.session?.cookies);
  return { email: rec?.email || null, ...r };
}

/** 检测一个配置文件（test_*.json / mistral_config.json）里的账号 */
export async function checkConfigFile(file) {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { email: null, ok: false, status: 0, plan: null, pro: null, error: `读取配置失败: ${e.message}`, checked_at: new Date().toISOString() };
  }
  const r = await checkCookies(cfg.session?.cookies);
  return { email: cfg.email || null, ...r };
}

/** 把检测结果写回 accounts.json（含 pro / pro_plan / pro_checked_at / in_pool） */
export function applyProResult(email, result) {
  const all = loadAccounts();
  const rec = email ? all[email] : null;
  if (!rec) return null;
  const pro = result.ok ? result.pro === true : null;
  return upsertAccount({
    ...rec,
    pro,
    pro_plan: result.ok ? result.plan : null,
    pro_checked_at: result.checked_at || new Date().toISOString(),
    // 检测成功就入池：Pro / Free 都能当上游渠道用，只有失败/未检出才排除
    in_pool: result.ok === true,
  }, rec.config_file || null);
}

/** 检测配置并把结果写回 accounts.json（供 batch_register / pipeline 调用） */
export async function checkAndApplyConfig(file) {
  const r = await checkConfigFile(file);
  const applied = r.email ? applyProResult(r.email, r) : null;
  return { ...r, applied: !!applied };
}

/* ============================== CLI ============================== */
function argOf(args, key, def) {
  const i = args.indexOf(key);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const configFile = argOf(args, '--config', null);
  const emailArg = argOf(args, '--email', null);
  const conc = Math.max(1, Math.min(10, parseInt(argOf(args, '--concurrency', '3'), 10) || 3));
  const asJson = args.includes('--json');

  if (!all && !configFile && !emailArg) {
    console.log('用法: node pro_check.mjs --all | --config <配置文件> | --email <邮箱>');
    console.log('示例: node pro_check.mjs --all --concurrency 3');
    process.exit(1);
  }

  const results = [];
  if (all) {
    const acc = loadAccounts();
    const entries = Object.values(acc).filter((a) => a?.session?.cookies && Object.keys(a.session.cookies).length);
    if (!entries.length) {
      console.log('[Pro] accounts.json 里没有带会话的账号');
      process.exit(1);
    }
    console.log(`[Pro] 检测 ${entries.length} 个账号（并发 ${conc}${globalProxy() ? '，代理 ' + globalProxy() : ''}）…`);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(conc, entries.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= entries.length) return;
        const rec = entries[i];
        const r = await checkAccount(rec);
        const pro = r.ok ? r.pro === true : null;
        const applied = applyProResult(rec.email, r);
        results.push({ email: rec.email, ...r, pro, in_pool: r.ok === true, applied: !!applied });
        const label = r.ok
          ? `${r.plan}　${r.pro ? '✓ Pro' : '· Free'}，已入池`
          : `检测失败（${r.error}）`;
        console.log(`[Pro] ${rec.email}  ${label}`);
      }
    });
    await Promise.all(workers);
  } else if (configFile) {
    const r = await checkConfigFile(configFile);
    const pro = r.ok ? r.pro === true : null;
    applyProResult(r.email, r);
    results.push({ ...r, pro, in_pool: r.ok === true, config: configFile });
    console.log(`[Pro] ${r.email || configFile}  ${r.ok ? `${r.plan}　${r.pro ? '✓ Pro' : '· Free'}，已入池` : '检测失败: ' + r.error}`);
  } else {
    const acc = loadAccounts();
    const rec = acc[emailArg];
    if (!rec) { console.log(`[Pro] accounts.json 中不存在: ${emailArg}`); process.exit(1); }
    const r = await checkAccount(rec);
    const pro = r.ok ? r.pro === true : null;
    applyProResult(emailArg, r);
    results.push({ ...r, pro, in_pool: r.ok === true });
    console.log(`[Pro] ${emailArg}  ${r.ok ? `${r.plan}　${r.pro ? '✓ Pro' : '· Free'}，已入池` : '检测失败: ' + r.error}`);
  }

  const summary = {
    checked_at: new Date().toISOString(),
    total: results.length,
    pro: results.filter((r) => r.pro === true).length,
    free: results.filter((r) => r.pro === false).length,
    unknown: results.filter((r) => r.pro === null).length,
    in_pool: results.filter((r) => r.in_pool).length,
    results,
  };
  writeFileSync('pro_report.json', JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\n[Pro] 汇总: 共 ${summary.total} · Pro ${summary.pro} · 非 Pro ${summary.free} · 未检出 ${summary.unknown} · 入池 ${summary.in_pool}`);
  console.log('[Pro] 报告: pro_report.json');
  if (asJson) console.log(JSON.stringify(summary, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => { console.error('[Pro] 失败:', e.message); process.exit(1); });
}
