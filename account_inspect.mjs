#!/usr/bin/env node
/**
 * account_inspect.mjs — 账号体检：有效性 + 套餐 + 额度查询（全部只读探测，不产生写操作）
 *
 * 检测项（实测 2026-11 于 chat.mistral.ai / auth.mistral.ai / admin.mistral.ai）：
 *   1. 会话有效性  GET  https://auth.mistral.ai/sessions/whoami（ory cookie，会话有效约 90 天）
 *   2. 套餐/Pro    GET  https://admin.mistral.ai/subscription 解析 "Current plan"（复用 pro_check）
 *   3. 月度额度    tRPC https://chat.mistral.ai/api/trpc/billing.budget
 *                  → { usage_percentage, initial_budget, currency, reset_at, payg_enabled }
 *                  例：{ usage_percentage: 0, initial_budget: 255, currency: "EUR", reset_at: "2026-12-01..." }
 *   4. 知识库用量  tRPC https://chat.mistral.ai/api/trpc/library.getCurrentUsage
 *                  → { isExceeded, currentUsage, maxUsage }
 *
 * 用法：
 *   node account_inspect.mjs --all                      # 体检 accounts.json 全部账号
 *   node account_inspect.mjs --email a@b.c              # 单个账号（从 accounts.json 取）
 *   node account_inspect.mjs --config test_x_config.json
 *   node account_inspect.mjs --all --concurrency 4 --proxy http://127.0.0.1:7897
 *   node account_inspect.mjs --all --json               # 额外打印 JSON 汇总
 *
 * 写回 accounts.json 字段（不含密码/cookie，报告里也没有）：
 *   valid / valid_checked_at     会话是否有效（whoami active）
 *   pro / pro_plan / pro_checked_at / in_pool   套餐（与 pro_check 相同口径）
 *   budget                       月度额度 { usage_percentage, initial_budget, currency, reset_at, payg_enabled, used_budget }
 *   library_usage                知识库用量 { isExceeded, currentUsage, maxUsage }
 *   quota_checked_at             额度检测时间
 *
 * 产物：inspect_report.json（最近一次体检汇总）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAccounts, upsertAccount } from './mistral_accounts.mjs';
import { checkCookies } from './pro_check.mjs';            // 套餐检测（admin.mistral.ai/subscription）
import { setProxy, checkSession } from './mistral_login.mjs'; // whoami 会话有效性
import { trpcQuery } from './mistral_chat_api.mjs';         // chat.mistral.ai tRPC（http2 直连）

function cookieHeader(cookies) {
  return Object.entries(cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ');
}

function globalProxy() {
  const i = process.argv.indexOf('--proxy');
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return process.env.MISTRAL_PROXY || null;
}

/**
 * 体检单个账号记录（只读）。
 * @returns {Promise<{email, valid, valid_error, plan, pro, budget, library_usage, checked_at, error}>}
 */
export async function inspectAccount(rec) {
  const checked_at = new Date().toISOString();
  const email = rec?.email || null;
  const cookies = rec?.session?.cookies || {};
  const cookie = cookieHeader(cookies);
  const out = {
    email, checked_at,
    valid: null, valid_error: null,
    plan: null, pro: null,
    budget: null, library_usage: null,
    error: null,
  };
  if (!cookie) {
    out.valid = false; out.valid_error = '无会话 cookie';
    out.error = '无会话 cookie';
    return out;
  }

  // 1) 会话有效性（whoami）；IP 被限流时单独标记，避免误判账号失效
  try {
    const r = await checkSession(cookies);
    if (r && r.blocked) {
      out.valid = null; out.valid_error = `IP 被限流（HTTP ${r.status}），无法判定`;
    } else if (r) {
      out.valid = true;
    } else {
      out.valid = false; out.valid_error = '会话无效或已过期（whoami 未通过）';
    }
  } catch (e) {
    out.valid = null; out.valid_error = e.message;
  }

  // 套餐 + 额度都依赖同一会话；会话明确无效时跳过后续请求（省额度、防风控）
  if (out.valid === false) {
    out.error = out.valid_error;
    return out;
  }

  // 2) 套餐（admin.mistral.ai/subscription）
  try {
    const r = await checkCookies(cookies);
    if (r.ok) { out.plan = r.plan; out.pro = r.pro === true; }
    else out.error = r.error;
  } catch (e) { out.error = e.message; }

  // 3) 月度额度 + 4) 知识库用量（tRPC，并发）
  const [budgetR, libR] = await Promise.allSettled([
    trpcQuery(cookie, 'billing.budget', {}),
    trpcQuery(cookie, 'library.getCurrentUsage', null),
  ]);
  if (budgetR.status === 'fulfilled' && budgetR.value && typeof budgetR.value === 'object') {
    const b = budgetR.value;
    const pct = Number(b.usage_percentage ?? 0);
    const init = Number(b.initial_budget ?? 0);
    out.budget = {
      usage_percentage: pct,
      initial_budget: init,
      used_budget: Math.round(init * pct) / 100,
      currency: b.currency || null,
      reset_at: b.reset_at || null,
      payg_enabled: b.payg_enabled === true,
    };
  } else {
    out.budget = null;
    const reason = budgetR.status === 'rejected' ? budgetR.reason?.message : '无返回';
    out.error = (out.error ? out.error + '；' : '') + `额度查询失败: ${reason}`;
  }
  if (libR.status === 'fulfilled' && libR.value && typeof libR.value === 'object') {
    out.library_usage = {
      isExceeded: libR.value.isExceeded === true,
      currentUsage: Number(libR.value.currentUsage ?? 0),
      maxUsage: Number(libR.value.maxUsage ?? 0),
    };
  }
  return out;
}

/** 把体检结果写回 accounts.json（保留旧字段，含 in_pool 口径：检测成功即入池） */
export function applyInspectResult(email, r) {
  const all = loadAccounts();
  const rec = email ? all[email] : null;
  if (!rec) return null;
  return upsertAccount({
    ...rec,
    valid: r.valid,
    valid_checked_at: r.checked_at,
    pro: r.pro,
    pro_plan: r.plan,
    pro_checked_at: r.checked_at,
    in_pool: r.valid === true,   // 会话有效才入池；检测失败/被限流都不入池
    budget: r.budget,
    library_usage: r.library_usage,
    quota_checked_at: r.checked_at,
  }, rec.config_file || null);
}

/* ============================== CLI ============================== */
function argOf(args, key, def) {
  const i = args.indexOf(key);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const emailArg = argOf(args, '--email', null);
  const configFile = argOf(args, '--config', null);
  const conc = Math.max(1, Math.min(8, parseInt(argOf(args, '--concurrency', '3'), 10) || 3));
  const asJson = args.includes('--json');
  const proxy = globalProxy();
  if (proxy) await setProxy(proxy);

  if (!all && !emailArg && !configFile) {
    console.log('用法: node account_inspect.mjs --all | --email <邮箱> | --config <配置文件>');
    console.log('示例: node account_inspect.mjs --all --concurrency 3');
    process.exit(1);
  }

  let targets = [];
  if (all) {
    const acc = loadAccounts();
    targets = Object.values(acc).filter((a) => a?.session?.cookies && Object.keys(a.session.cookies).length);
    if (!targets.length) { console.log('[体检] accounts.json 里没有带会话的账号'); process.exit(1); }
  } else if (emailArg) {
    const rec = loadAccounts()[emailArg];
    if (!rec) { console.log(`[体检] accounts.json 中不存在: ${emailArg}`); process.exit(1); }
    targets = [rec];
  } else {
    let cfg;
    try { cfg = JSON.parse(readFileSync(configFile, 'utf8')); }
    catch (e) { console.log(`[体检] 读取配置失败: ${e.message}`); process.exit(1); }
    targets = [{ email: cfg.email || configFile, session: cfg.session }];
  }

  console.log(`[体检] ${targets.length} 个账号（并发 ${conc}${proxy ? '，代理 ' + proxy : ''}）：有效性 whoami + 套餐 + 月度额度 billing.budget + 知识库用量`);
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(conc, targets.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= targets.length) return;
      const rec = targets[i];
      const r = await inspectAccount(rec);
      results[i] = r;
      if (r.email) applyInspectResult(r.email, r);
      const budgetTxt = r.budget
        ? `额度 ${r.budget.used_budget}/${r.budget.initial_budget}${r.budget.currency || ''}（${r.budget.usage_percentage}%，${String(r.budget.reset_at || '').slice(0, 10)} 重置）`
        : '额度 ?';
      console.log(`[体检] ${r.email || '(未知)'}  ${r.valid === true ? '✓ 有效' : r.valid === false ? '✗ 失效' : '? ' + (r.valid_error || '')}  ` +
        `${r.plan ? '套餐 ' + r.plan + (r.pro ? '（Pro）' : '') : ''}  ${budgetTxt}` +
        (r.library_usage ? `  知识库 ${r.library_usage.currentUsage}/${r.library_usage.maxUsage}` : '') +
        (r.error && r.valid !== false ? `  [${r.error}]` : ''));
    }
  });
  await Promise.all(workers);

  const summary = {
    checked_at: new Date().toISOString(),
    total: results.length,
    valid: results.filter((r) => r.valid === true).length,
    invalid: results.filter((r) => r.valid === false).length,
    unknown: results.filter((r) => r.valid === null).length,
    pro: results.filter((r) => r.pro === true).length,
    results,
  };
  writeFileSync('inspect_report.json', JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\n[体检] 汇总: 共 ${summary.total} · 有效 ${summary.valid} · 失效 ${summary.invalid} · 未知 ${summary.unknown} · Pro ${summary.pro}`);
  console.log('[体检] 报告: inspect_report.json（已写回 accounts.json 的 valid / budget / library_usage 字段）');
  if (asJson) console.log(JSON.stringify(summary, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => { console.error('[体检] 失败:', e.message); process.exit(1); });
}
