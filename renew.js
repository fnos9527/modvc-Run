/**
 * ModVC (panel.modvc.org) Free Tier 自动续期脚本
 *
 * 【最新修复 2026-10-30】
 * 站点新增了 "Pay with Card & Auto-Renew" 全屏弹窗（按钮：Upgrade to Pro / Dismiss），
 * 它出现在「等待仪表盘」阶段，旧脚本在弹窗被关闭之前就判定登录失效并退出。
 * 现在：
 *   1. 页面一加载就注入一个后台监视器，只要出现文字恰好为 "Dismiss" 的按钮就自动点击
 *   2. waitForDashboard 轮询时，每一轮都会先清弹窗(优先点 Dismiss，绝不点 Upgrade)
 *   3. dismissPopups 不再依赖 div.fixed.inset-0，页面任何位置的 Dismiss 按钮都会被点掉
 *   4. 判定失败时会把页面文字打印到日志，方便排查
 *
 * 【上一次修复】
 * 原脚本使用 waitUntil: 'networkidle'。panel.modvc.org 页面内嵌的 Pocketsflow / Whop /
 * hCaptcha 支付弹窗脚本（2026-10-14 更新后）会持续发请求并反复重试(429/404/401)，
 * 页面永远不会"网络空闲"，导致 page.goto 60 秒超时。
 *
 * 修复方式：
 *   1. 所有 goto / reload 改为 waitUntil: 'domcontentloaded' + 自动重试(3次)
 *   2. 再"尽力"等一下 load / networkidle，但超时只忽略，不报错
 *   3. 屏蔽 pocketsflow / whop / basistheory 等与续期无关的支付第三方请求，减少干扰
 *   4. 过滤页面 console 里的噪音日志
 *   5. 仪表盘等待时间从 15 秒加长到 30 秒
 *
 * 鉴权方式：站点用 Google 账号登录（Firebase Auth），登录态主要存放在浏览器的
 * IndexedDB 里。所以这里：
 *   1. 用 Playwright storageState 还原 Cookie + localStorage
 *   2. 手动把 sessionStorage 写回去
 *   3. 手动把 IndexedDB 的数据库/表/记录原样写回去
 *
 * 流程：
 * 1. 还原登录状态（MODVC_STATE）
 * 2. 打开页面 -> 还原 IndexedDB -> 重新加载页面，确认进入了仪表盘
 * 3. 记录续期前的到期时间（来自 API JSON，文本提取作为兜底参考）
 * 4. 点击 "Renew Free Tier" 按钮
 * 5. 刷新页面，记录续期后的到期时间，对比是否有变化
 * 6. 通过 Telegram 机器人发送结果通知（含截图）
 * 7. 如果登录状态已失效（进不去仪表盘），立即发送告警通知
 */

const { chromium } = require('playwright');
const fs = require('fs');

const TARGET_URL = 'https://panel.modvc.org/#pricing';

const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const STATE_RAW = process.env.MODVC_STATE;

// 设为 'false' 可关闭对第三方支付脚本的屏蔽（默认开启）
const BLOCK_THIRD_PARTY = process.env.BLOCK_THIRD_PARTY !== 'false';

// ------------------------- 工具函数 -------------------------

/**
 * 稳健的页面导航：不依赖 networkidle。
 * mode = 'goto' | 'reload'
 */
async function navigate(page, mode, url, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      if (mode === 'goto') {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      } else {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      }
      // 尽力等一下 load 和网络安静，超时直接忽略（该页面有持续请求，不能强求）
      await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      return;
    } catch (e) {
      lastErr = e;
      console.log(`[导航] ${mode} 第 ${i}/${tries} 次失败: ${String(e.message).split('\n')[0]}`);
      if (i < tries) await page.waitForTimeout(5000);
    }
  }
  throw lastErr;
}

/** 从页面正文里提取 "FREE TIER until xxxx/x/x" 这样的日期，仅作为兜底参考 */
async function extractUntilDateFromText(page) {
  const text = await page.evaluate(() => document.body.innerText);

  let match = text.match(/until\s*\n?\s*(\d{4}\/\d{1,2}\/\d{1,2})/i);
  if (match) return match[1];

  const idx = text.toUpperCase().indexOf('FREE TIER');
  if (idx !== -1) {
    const snippet = text.slice(idx, idx + 120);
    const m2 = snippet.match(/(\d{4}\/\d{1,2}\/\d{1,2})/);
    if (m2) return m2[1];
  }

  return null;
}

/** 等待仪表盘真正加载出来（轮询期间会不断清理弹窗，避免被弹窗挡住） */
async function waitForDashboard(page, timeout = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    // 先清弹窗（不额外等待，轮询本身就是间隔）
    await dismissPopups(page, '-等待仪表盘', { initialWait: 0 }).catch(() => {});

    const ok = await page
      .evaluate(() => {
        const t = document.body.innerText || '';
        return /free tier/i.test(t) && /renew free tier|runtime|public url/i.test(t);
      })
      .catch(() => false);
    if (ok) return true;

    await page.waitForTimeout(1500);
  }

  // 失败时打印页面文字，方便排查到底看到了什么
  try {
    const txt = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 600));
    console.log('[调试] 仪表盘判定失败，当前页面文字(前600字):', txt);
  } catch (e) {}
  return false;
}

/** 尝试 base64url 解码 JWT 的 payload 部分 */
function tryDecodeJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (e) {
    return null;
  }
}

/** 深度遍历整个导出的 state，找 JWT 和过期时间字段，打印诊断信息 */
function logTokenDiagnostics(state) {
  const jwtPattern = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}$/;
  let jwtFound = false;

  function walk(node, path) {
    if (node == null) return;
    if (typeof node === 'string') {
      if (jwtPattern.test(node)) {
        jwtFound = true;
        const payload = tryDecodeJwt(node);
        console.log(`[Token检测] 在 ${path} 发现一个 JWT`);
        if (payload && payload.exp) {
          const expDate = new Date(payload.exp * 1000);
          console.log(`[Token检测] exp: ${expDate.toISOString()} | 是否已过期: ${expDate < new Date()}`);
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (typeof node === 'object') {
      for (const key of Object.keys(node)) {
        walk(node[key], `${path}.${key}`);
      }
    }
  }

  walk(state, 'MODVC_STATE');
  if (!jwtFound) console.log('[Token检测] 没有发现明显的 JWT 字符串');
}

/** 在任意 JSON 对象里深度查找形如 expiresAt / until / renewUntil 的日期字段 */
function findDateCandidates(obj, path = '') {
  const candidates = [];
  function walk(node, p) {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${p}[${i}]`));
      return;
    }
    if (typeof node === 'object') {
      for (const key of Object.keys(node)) {
        const val = node[key];
        const keyLooksRelevant = /expir|until|renew|valid.?(till|thru)|tier.*date/i.test(key);
        if (keyLooksRelevant) {
          if (typeof val === 'string') {
            const d = new Date(val.replace(/\//g, '-'));
            if (!isNaN(d.getTime()) && d.getFullYear() > 2020 && d.getFullYear() < 2035) {
              candidates.push({ path: `${p}.${key}`, raw: val, date: d });
            }
          } else if (typeof val === 'number') {
            const ms = val > 1e12 ? val : val * 1000;
            const d = new Date(ms);
            if (d.getFullYear() > 2020 && d.getFullYear() < 2035) {
              candidates.push({ path: `${p}.${key}`, raw: val, date: d });
            }
          }
        }
        walk(val, `${p}.${key}`);
      }
    }
  }
  walk(obj, path);
  return candidates;
}

/** 从多个接口返回的 JSON 里挑出最可能是「到期时间」的那个字段 */
function pickExpiryDate(jsons) {
  let all = [];
  jsons.forEach((json, idx) => {
    if (!json) return;
    all = all.concat(findDateCandidates(json).map((c) => ({ ...c, source: idx })));
  });
  if (all.length === 0) return null;

  const score = (c) => (/expir/i.test(c.path) ? 3 : /until/i.test(c.path) ? 2 : /renew/i.test(c.path) ? 1 : 0);
  all.sort((a, b) => score(b) - score(a));
  return { ...all[0], all };
}

/**
 * 在页面上下文里运行：把导出的 IndexedDB 数据库/表/记录原样写回去
 * 注意：这个函数会被 Playwright 序列化后直接在浏览器里执行，不能引用外部变量
 */
async function restoreIndexedDBInPage(dump) {
  if (!dump || !dump.length) return { ok: true, restored: 0 };
  let restored = 0;

  for (const dbMeta of dump) {
    try {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(dbMeta.name, dbMeta.version);
        req.onupgradeneeded = (e) => {
          const database = e.target.result;
          for (const store of dbMeta.stores) {
            if (!database.objectStoreNames.contains(store.name)) {
              const os = database.createObjectStore(store.name, {
                keyPath: store.keyPath || undefined,
                autoIncrement: !!store.autoIncrement,
              });
              for (const idx of store.indexes || []) {
                try {
                  os.createIndex(idx.name, idx.keyPath, { unique: idx.unique, multiEntry: idx.multiEntry });
                } catch (e) {}
              }
            }
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => resolve(null);
      });

      if (!db) continue;

      for (const store of dbMeta.stores) {
        if (!db.objectStoreNames.contains(store.name)) continue;
        await new Promise((resolve) => {
          const tx = db.transaction(store.name, 'readwrite');
          const os = tx.objectStore(store.name);
          (store.records || []).forEach((rec) => {
            try {
              if (store.keyPath) {
                os.put(rec.value);
              } else {
                os.put(rec.value, rec.key);
              }
              restored++;
            } catch (e) {}
          });
          tx.oncomplete = resolve;
          tx.onerror = resolve;
          tx.onabort = resolve;
        });
      }
      db.close();
    } catch (e) {}
  }

  return { ok: true, restored };
}

/** 发送 Telegram 通知，可选附带一张图片（caption 上限 1024 字符，超长会自动截断并补发完整文字） */
async function sendTelegram(text, screenshotPath) {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.log('[TG] 未配置 TG_TOKEN / TG_CHAT_ID，跳过通知。消息内容：\n' + text);
    return;
  }

  const sendText = async (msg) => {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: msg.slice(0, 4000) }),
    });
    const json = await res.json();
    if (!json.ok) console.error('[TG] 发送消息失败:', json);
    return json.ok;
  };

  try {
    if (screenshotPath && fs.existsSync(screenshotPath)) {
      const CAPTION_LIMIT = 1000;
      const caption = text.length > CAPTION_LIMIT ? text.slice(0, CAPTION_LIMIT - 1) + '…' : text;

      const buffer = fs.readFileSync(screenshotPath);
      const form = new FormData();
      form.append('chat_id', TG_CHAT_ID);
      form.append('caption', caption);
      form.append('photo', new Blob([buffer]), 'screenshot.png');

      const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, {
        method: 'POST',
        body: form,
      });
      const json = await res.json();
      if (!json.ok) {
        console.error('[TG] 发送图片失败:', json);
        await sendText(text); // 图片失败就退回纯文字
      } else if (text.length > CAPTION_LIMIT) {
        await sendText(text); // 文字被截断了，补发完整版
      }
    } else {
      await sendText(text);
    }
  } catch (e) {
    console.error('[TG] 通知发送异常:', e.message);
  }
}

/** 点击 locator 匹配到的第一个可见元素；常规点击失败 -> force -> JS click */
async function clickFirstVisible(locator) {
  const n = await locator.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = locator.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    try {
      await el.click({ timeout: 3000 });
      return true;
    } catch (e) {
      try {
        await el.click({ force: true, timeout: 2000 });
        return true;
      } catch (e2) {
        const ok = await el.evaluate((x) => { x.click(); return true; }).catch(() => false);
        if (ok) return true;
      }
    }
  }
  return false;
}

// 只点这个词的按钮：页面任何位置都点（例如 "Pay with Card & Auto-Renew" 弹窗里的 Dismiss）
const DISMISS_PRIMARY_RE = /^\s*dismiss\s*$/i;
// 这些词只在遮罩层/对话框里才点，避免误点页面上正常的按钮
const DISMISS_OTHER_RE = /^\s*(close|got it|maybe later|not now|skip|no thanks|关闭|知道了|我知道了)\s*$/i;
const OVERLAY_SELECTOR = 'div.fixed.inset-0, [role="dialog"], [aria-modal="true"]';

/**
 * 关闭站点上各种遮挡页面的弹窗（"What's New"、"Pay with Card & Auto-Renew" 等）。
 * 策略：
 *   1. 优先点击 "Dismiss" 按钮（页面任何位置）。绝不会点 "Upgrade to Pro"
 *   2. 遮罩层里的 Close / Got it / Maybe later 等按钮
 *   3. 按 Escape
 *   4. 实在关不掉，直接用 JS 把高层级全屏遮罩从 DOM 里移除
 * 返回处理了多少个弹窗。
 * options.initialWait：开始前等待毫秒数（弹窗有渐入动画，默认等 1500ms）
 */
async function dismissPopups(page, label = '', { initialWait = 1500 } = {}) {
  let handled = 0;

  if (initialWait > 0) await page.waitForTimeout(initialWait);

  for (let round = 0; round < 6; round++) {
    // 方式 1：Dismiss 按钮（getByRole 找不到就按文字再找一遍）
    let closed = await clickFirstVisible(page.getByRole('button', { name: DISMISS_PRIMARY_RE }));
    if (!closed) {
      closed = await clickFirstVisible(page.locator('button, [role="button"]').filter({ hasText: DISMISS_PRIMARY_RE }));
    }
    if (closed) {
      handled++;
      console.log(`[弹窗${label}] 已点击 Dismiss 按钮`);
      await page.waitForTimeout(800);
      continue;
    }

    // 方式 2：遮罩层/对话框里的其它关闭按钮
    closed = await clickFirstVisible(page.locator(OVERLAY_SELECTOR).getByRole('button', { name: DISMISS_OTHER_RE }));
    if (closed) {
      handled++;
      console.log(`[弹窗${label}] 已点击关闭按钮`);
      await page.waitForTimeout(800);
      continue;
    }

    // 没有可点的按钮：看看是不是还有遮罩层
    const hasOverlay = await page.locator(OVERLAY_SELECTOR).first().isVisible().catch(() => false);
    if (!hasOverlay) break;

    console.log(`[弹窗${label}] 检测到遮罩层但没有关闭按钮，第 ${round + 1} 次尝试 Escape / 移除`);

    // 方式 3：Escape
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(600);

    // 方式 4：还在的话，强制从 DOM 里删掉
    const stillThere = await page.locator(OVERLAY_SELECTOR).first().isVisible().catch(() => false);
    if (stillThere && round >= 2) {
      const removed = await page.evaluate(() => {
        let n = 0;
        document.querySelectorAll('div.fixed.inset-0').forEach((el) => {
          const z = getComputedStyle(el).zIndex;
          // 只删高层级的全屏遮罩（z-[70] 之类的弹窗），不动普通布局元素
          if (parseInt(z, 10) >= 50) {
            el.remove();
            n++;
          }
        });
        return n;
      });
      console.log(`[弹窗${label}] 强制移除遮罩层 ${removed} 个`);
    }

    handled++;
    await page.waitForTimeout(400);
  }

  if (handled === 0) console.log(`[弹窗${label}] 没有发现弹窗`);
  return handled;
}

function formatDate(d) {
  if (!d) return '未知';
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

// 页面 console 里这些都是第三方支付/验证码组件的噪音，不打印
const NOISE_RE =
  /Permissions policy violation|devicemotion|deviceorientation|postMessage|No available adapters|GL Driver Message|allowpaymentrequest|Failed to load resource|EvalError|hcaptcha\.com|^\s*$/i;

// ------------------------- 主流程 -------------------------

(async () => {
  if (!STATE_RAW) {
    console.error('未配置 MODVC_STATE Secret');
    await sendTelegram('❌ ModVC 续期失败：未配置 MODVC_STATE Secret，请先按说明导出登录状态并添加到 GitHub Secrets。');
    process.exit(1);
  }

  let parsedState;
  try {
    parsedState = JSON.parse(STATE_RAW);
  } catch (e) {
    console.error('MODVC_STATE 不是合法 JSON:', e.message);
    await sendTelegram('❌ ModVC 续期失败：MODVC_STATE 内容不是合法 JSON，请检查是否完整复制了控制台脚本输出的内容。');
    process.exit(1);
  }

  const { sessionStorage: sessionStorageItems, indexedDB: indexedDBDump, ...storageState } = parsedState;

  if (!storageState.cookies && !storageState.origins) {
    console.error('MODVC_STATE 缺少 cookies/origins 字段，格式不对');
    await sendTelegram('❌ ModVC 续期失败：MODVC_STATE 缺少 cookies/origins 字段，请重新用控制台脚本导出。');
    process.exit(1);
  }

  console.log(`[调试] IndexedDB 数据库数量: ${Array.isArray(indexedDBDump) ? indexedDBDump.length : 0}`);
  logTokenDiagnostics(parsedState);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState,
    viewport: { width: 1600, height: 1000 },
  });

  // 屏蔽与续期无关的支付第三方（它们会持续发请求并 429 重试，拖垮页面加载）
  // 注意：只屏蔽这几个域名，modvc 自己的接口不受影响
  if (BLOCK_THIRD_PARTY) {
    await context.route(/(pocketsflow\.com|whop\.com|basistheory\.com|hcaptcha\.com)/i, (route) => route.abort());
    console.log('[调试] 已屏蔽第三方支付/验证码脚本 (pocketsflow / whop / basistheory / hcaptcha)');
  }

  // 后台监视器：每次页面加载(含 reload)都会注入。只要出现文字恰好是 "Dismiss" 的可见按钮就点掉，
  // 这样即使弹窗在脚本做别的事情时才弹出来，也不会一直挡住页面。
  await context.addInitScript(() => {
    const tick = () => {
      try {
        document.querySelectorAll('button, [role="button"]').forEach((b) => {
          if (/^\s*dismiss\s*$/i.test(b.textContent || '') && b.getClientRects().length > 0) {
            b.click();
          }
        });
      } catch (e) {}
    };
    setInterval(tick, 500);
  });

  if (Array.isArray(sessionStorageItems) && sessionStorageItems.length > 0) {
    await context.addInitScript((items) => {
      try {
        items.forEach(({ name, value }) => {
          window.sessionStorage.setItem(name, value);
        });
      } catch (e) {}
    }, sessionStorageItems);
  }

  const page = await context.newPage();

  // ---- 被动抓取 /tier、/hosting/orders 接口的 JSON 响应，留到后面找到期时间用 ----
  let latestTierJson = null;
  let latestOrdersJson = null;

  page.on('console', (msg) => {
    const text = msg.text();
    if (NOISE_RE.test(text)) return;
    console.log(`[页面console:${msg.type()}] ${text}`);
  });

  page.on('response', async (response) => {
    let url;
    try {
      url = response.url();
    } catch (e) {
      return;
    }
    if (!url.includes('modvc.org')) return;

    const status = response.status();
    if (status >= 400 || /\/(me|user|auth|login|status|logs|api)/i.test(url)) {
      console.log(`[网络] ${status} ${url}`);
    }

    if (status === 200) {
      try {
        if (/\/tier(\?|$)/.test(url)) {
          latestTierJson = await response.json();
          console.log('[Tier响应]', JSON.stringify(latestTierJson));
        } else if (/\/hosting\/orders(\?|$)/.test(url)) {
          latestOrdersJson = await response.json();
          console.log('[Orders响应]', JSON.stringify(latestOrdersJson));
        }
      } catch (e) {
        /* 不是 JSON 或解析失败，忽略 */
      }
    }
  });

  const beforeShot = 'before.png';
  const afterShot = 'after.png';

  try {
    await navigate(page, 'goto', TARGET_URL);
    // 给前端框架（Firebase 等）初始化留一点时间，再写 IndexedDB
    await page.waitForTimeout(3000);

    if (Array.isArray(indexedDBDump) && indexedDBDump.length > 0) {
      const restoreResult = await page.evaluate(restoreIndexedDBInPage, indexedDBDump);
      console.log('[调试] IndexedDB 还原结果:', JSON.stringify(restoreResult));
    } else {
      console.log('[调试] MODVC_STATE 中没有 indexedDB 字段，跳过还原');
    }

    await navigate(page, 'reload');

    const dashboardOk = await waitForDashboard(page);
    if (!dashboardOk) {
      await page.screenshot({ path: beforeShot, fullPage: true });
      await sendTelegram(
        '⚠️ ModVC 登录状态已失效！打开页面后没能看到仪表盘内容（FREE TIER / Renew Free Tier），自动续期未执行。\n' +
          '请重新登录 panel.modvc.org，用控制台脚本重新导出登录状态，并更新 GitHub Secret：MODVC_STATE。',
        beforeShot
      );
      await browser.close();
      process.exit(1);
    }

    // 给响应监听器一点缓冲时间，确保 /tier 等请求的回调已经处理完
    await page.waitForTimeout(1500);

    // 关掉 "What's New" 等公告弹窗，否则它会挡住后面的按钮点击
    await dismissPopups(page, '-续期前');

    const beforeApiInfo = pickExpiryDate([latestTierJson, latestOrdersJson]);
    const beforeTextDate = await extractUntilDateFromText(page);
    console.log(
      '[调试] 续期前 - API候选:',
      beforeApiInfo ? `${beforeApiInfo.path} = ${beforeApiInfo.raw} (${formatDate(beforeApiInfo.date)})` : '未找到',
      '| 文本兜底:',
      beforeTextDate
    );

    await page.screenshot({ path: beforeShot, fullPage: true });

    const renewBtn = page.getByRole('button', { name: /renew free tier/i }).first();
    const btnVisible = await renewBtn.isVisible().catch(() => false);

    if (!btnVisible) {
      await sendTelegram(
        `⚠️ ModVC 未找到「Renew Free Tier」按钮（可能页面结构变化、已升级为 Pro，或暂不在可续期窗口）。`,
        beforeShot
      );
      await browser.close();
      process.exit(0);
    }

    // 点击前再确认一次没有弹窗；点击失败时再清一次弹窗并重试，最后用 force/JS 兜底
    await dismissPopups(page, '-点击前');
    try {
      await renewBtn.click({ timeout: 10000 });
    } catch (e) {
      console.log('[续期] 常规点击失败，清理弹窗后重试:', e.message.split('\n')[0]);
      await dismissPopups(page, '-重试');
      try {
        await renewBtn.click({ timeout: 10000 });
      } catch (e2) {
        console.log('[续期] 重试仍失败，改用 force 点击:', e2.message.split('\n')[0]);
        await renewBtn.click({ force: true, timeout: 10000 }).catch(async () => {
          await renewBtn.evaluate((el) => el.click());
        });
      }
    }
    await page.waitForTimeout(5000);

    const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("OK"), button:has-text("Yes")').first();
    if (await confirmBtn.isVisible().catch(() => false)) {
      await confirmBtn.click();
      await page.waitForTimeout(3000);
    }

    await navigate(page, 'reload');

    const dashboardOkAfter = await waitForDashboard(page);
    if (!dashboardOkAfter) {
      await page.screenshot({ path: afterShot, fullPage: true });
      await sendTelegram('⚠️ ModVC 点击续期后登录状态失效（进不去仪表盘），请重新导出并更新 MODVC_STATE。', afterShot);
      await browser.close();
      process.exit(1);
    }

    await page.waitForTimeout(1500);
    await dismissPopups(page, '-续期后');

    const afterApiInfo = pickExpiryDate([latestTierJson, latestOrdersJson]);
    const afterTextDate = await extractUntilDateFromText(page);
    console.log(
      '[调试] 续期后 - API候选:',
      afterApiInfo ? `${afterApiInfo.path} = ${afterApiInfo.raw} (${formatDate(afterApiInfo.date)})` : '未找到',
      '| 文本兜底:',
      afterTextDate
    );

    await page.screenshot({ path: afterShot, fullPage: true });

    let resultMsg;
    const beforeDate = beforeApiInfo ? beforeApiInfo.date : beforeTextDate ? new Date(beforeTextDate.replace(/\//g, '-')) : null;
    const afterDate = afterApiInfo ? afterApiInfo.date : afterTextDate ? new Date(afterTextDate.replace(/\//g, '-')) : null;

    if (beforeDate && afterDate) {
      const diffDays = Math.round((afterDate.getTime() - beforeDate.getTime()) / 86400000);
      if (afterDate.getTime() > beforeDate.getTime()) {
        resultMsg =
          `✅ ModVC 续期成功！\n` +
          `续期前到期时间：${formatDate(beforeDate)}\n` +
          `续期后到期时间：${formatDate(afterDate)}\n` +
          `增加了约 ${diffDays} 天`;
      } else if (afterDate.getTime() === beforeDate.getTime()) {
        resultMsg = `ℹ️ ModVC 续期未生效（到期时间没有变化）。\n到期时间：${formatDate(beforeDate)}\n请查看截图核实。`;
      } else {
        resultMsg = `⚠️ ModVC 续期后到期时间反而变小，请人工核实。\n续期前：${formatDate(beforeDate)}\n续期后：${formatDate(afterDate)}`;
      }
    } else {
      resultMsg =
        `⚠️ ModVC 续期流程已执行（点击了按钮，接口已调用），但未能从 /tier、/hosting/orders 接口或页面文字里提取到到期时间。\n` +
        `请查看 Actions 日志里的 [Tier响应] / [Orders响应] 内容，找到实际的日期字段名后告诉我，我再精确调整提取规则。`;
    }

    await sendTelegram(resultMsg, afterShot);
  } catch (err) {
    console.error('执行出错:', err);
    try {
      await page.screenshot({ path: 'error.png', fullPage: true });
    } catch (_) {}
    await sendTelegram(
      `❌ ModVC 续期脚本执行异常：${String(err.message).split('\n')[0]}`,
      fs.existsSync('error.png') ? 'error.png' : undefined
    );
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
