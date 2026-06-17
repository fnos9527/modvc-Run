/**
 * ModVC (panel.modvc.org) Free Tier 自动续期脚本
 *
 * 鉴权方式：站点用 Google 账号登录（Firebase Auth），登录态主要存放在浏览器的
 * IndexedDB 里。所以这里：
 *   1. 用 Playwright storageState 还原 Cookie + localStorage
 *   2. 手动把 sessionStorage 写回去
 *   3. 手动把 IndexedDB 的数据库/表/记录原样写回去（这是关键，已验证有效）
 *
 * 到期时间不再从页面文字里抠（页面布局容易变化、不可靠），改为直接抓
 * /tier、/hosting/orders 这两个接口返回的 JSON，在里面自动找形如
 * expiresAt / until / renewUntil 这类字段。
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

// ------------------------- 工具函数 -------------------------

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

/** 等待仪表盘真正加载出来 */
async function waitForDashboard(page, timeout = 15000) {
  try {
    await page.waitForFunction(
      () => {
        const t = document.body.innerText || '';
        return /free tier/i.test(t) && /renew free tier|runtime|public url/i.test(t);
      },
      { timeout }
    );
    return true;
  } catch (e) {
    return false;
  }
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

/** 发送 Telegram 通知，可选附带一张图片 */
async function sendTelegram(text, screenshotPath) {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.log('[TG] 未配置 TG_TOKEN / TG_CHAT_ID，跳过通知。消息内容：\n' + text);
    return;
  }

  try {
    if (screenshotPath && fs.existsSync(screenshotPath)) {
      const buffer = fs.readFileSync(screenshotPath);
      const form = new FormData();
      form.append('chat_id', TG_CHAT_ID);
      form.append('caption', text);
      form.append('photo', new Blob([buffer]), 'screenshot.png');

      const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, {
        method: 'POST',
        body: form,
      });
      const json = await res.json();
      if (!json.ok) console.error('[TG] 发送图片失败:', json);
    } else {
      const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_CHAT_ID, text }),
      });
      const json = await res.json();
      if (!json.ok) console.error('[TG] 发送消息失败:', json);
    }
  } catch (e) {
    console.error('[TG] 通知发送异常:', e.message);
  }
}

function formatDate(d) {
  if (!d) return '未知';
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

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
    console.log(`[页面console:${msg.type()}] ${msg.text()}`);
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
    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60000 });

    if (Array.isArray(indexedDBDump) && indexedDBDump.length > 0) {
      const restoreResult = await page.evaluate(restoreIndexedDBInPage, indexedDBDump);
      console.log('[调试] IndexedDB 还原结果:', JSON.stringify(restoreResult));
    } else {
      console.log('[调试] MODVC_STATE 中没有 indexedDB 字段，跳过还原');
    }

    await page.reload({ waitUntil: 'networkidle', timeout: 60000 });

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

    await renewBtn.click();
    await page.waitForTimeout(5000);

    const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("OK"), button:has-text("Yes")').first();
    if (await confirmBtn.isVisible().catch(() => false)) {
      await confirmBtn.click();
      await page.waitForTimeout(3000);
    }

    await page.reload({ waitUntil: 'networkidle', timeout: 60000 });

    const dashboardOkAfter = await waitForDashboard(page);
    if (!dashboardOkAfter) {
      await page.screenshot({ path: afterShot, fullPage: true });
      await sendTelegram('⚠️ ModVC 点击续期后登录状态失效（进不去仪表盘），请重新导出并更新 MODVC_STATE。', afterShot);
      await browser.close();
      process.exit(1);
    }

    await page.waitForTimeout(1500);

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
      `❌ ModVC 续期脚本执行异常：${err.message}`,
      fs.existsSync('error.png') ? 'error.png' : undefined
    );
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
