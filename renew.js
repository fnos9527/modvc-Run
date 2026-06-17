/**
 * ModVC (panel.modvc.org) Free Tier 自动续期脚本
 *
 * 鉴权方式：该站点用 Google 账号登录（Firebase Auth），登录态主要存放在浏览器的
 * IndexedDB 里（而不是 Cookie 或 localStorage）。所以这里：
 *   1. 用 Playwright storageState 还原 Cookie + localStorage
 *   2. 手动把 sessionStorage 写回去
 *   3. 手动把 IndexedDB 的数据库/表/记录原样写回去（这是关键）
 *
 * 流程：
 * 1. 还原登录状态（MODVC_STATE）
 * 2. 打开页面 -> 还原 IndexedDB -> 重新加载页面，确认进入了仪表盘
 * 3. 读取 "FREE TIER until" 的到期时间（续期前）
 * 4. 点击 "Renew Free Tier" 按钮
 * 5. 刷新页面，再次读取到期时间（续期后），对比是否有变化
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

/** 从页面正文中提取 "FREE TIER until xxxx/x/x" 这样的日期 */
async function extractUntilDate(page) {
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

/** 深度遍历整个导出的 state（包括 IndexedDB 记录），找 JWT 和过期时间字段，打印诊断信息 */
function logTokenDiagnostics(state) {
  const jwtPattern = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}$/;
  let jwtFound = false;
  let expFound = false;

  function walk(node, path) {
    if (node == null) return;
    if (typeof node === 'string') {
      if (jwtPattern.test(node)) {
        jwtFound = true;
        const payload = tryDecodeJwt(node);
        console.log(`[Token检测] 在 ${path} 发现一个 JWT`);
        if (payload) {
          console.log(`[Token检测] payload:`, JSON.stringify(payload));
          if (payload.exp) {
            const expDate = new Date(payload.exp * 1000);
            console.log(`[Token检测] exp(秒级): ${expDate.toISOString()} | 是否已过期: ${expDate < new Date()}`);
          }
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
        if (/expir/i.test(key) && (typeof node[key] === 'number' || typeof node[key] === 'string')) {
          expFound = true;
          const raw = node[key];
          const num = Number(raw);
          const expDate = Number.isFinite(num) ? new Date(num > 1e12 ? num : num * 1000) : null;
          console.log(
            `[Token检测] 在 ${path}.${key} 发现过期时间字段，原始值: ${raw}` +
              (expDate ? ` | 解析为: ${expDate.toISOString()} | 是否已过期: ${expDate < new Date()}` : '')
          );
        }
        walk(node[key], `${path}.${key}`);
      }
    }
  }

  walk(state, 'MODVC_STATE');

  if (!jwtFound) console.log('[Token检测] 没有发现明显的 JWT 字符串');
  if (!expFound) console.log('[Token检测] 没有发现明显的过期时间字段（key 包含 expir）');
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
                } catch (e) {
                  /* 索引创建失败忽略 */
                }
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
            } catch (e) {
              /* 单条写入失败忽略，不影响整体 */
            }
          });
          tx.oncomplete = resolve;
          tx.onerror = resolve;
          tx.onabort = resolve;
        });
      }
      db.close();
    } catch (e) {
      /* 某个数据库还原失败，不影响其它数据库 */
    }
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
      } catch (e) {
        /* 忽略注入失败 */
      }
    }, sessionStorageItems);
  }

  const page = await context.newPage();

  page.on('console', (msg) => {
    console.log(`[页面console:${msg.type()}] ${msg.text()}`);
  });
  page.on('response', (response) => {
    try {
      const url = response.url();
      if (url.includes('modvc.org')) {
        const status = response.status();
        if (status >= 400 || /\/(me|user|auth|login|status|logs|api)/i.test(url)) {
          console.log(`[网络] ${status} ${url}`);
        }
      }
    } catch (e) {
      /* 忽略 */
    }
  });

  const beforeShot = 'before.png';
  const afterShot = 'after.png';

  try {
    // ---- 第一次打开页面：此时大概率还是未登录状态，主要目的是站到正确的 origin 上 ----
    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60000 });

    // ---- 还原 IndexedDB（Firebase 登录态主要存在这里） ----
    if (Array.isArray(indexedDBDump) && indexedDBDump.length > 0) {
      const restoreResult = await page.evaluate(restoreIndexedDBInPage, indexedDBDump);
      console.log('[调试] IndexedDB 还原结果:', JSON.stringify(restoreResult));
    } else {
      console.log('[调试] MODVC_STATE 中没有 indexedDB 字段，跳过还原（请确认用的是最新版控制台脚本导出的）');
    }

    // ---- 重新加载页面，让前端的 Firebase SDK 重新读取 IndexedDB 里刚写入的登录态 ----
    await page.reload({ waitUntil: 'networkidle', timeout: 60000 });

    // ---- 诊断：确认实际存储情况 ----
    const debugStorage = await page.evaluate(async () => {
      let dbNames = [];
      try {
        if ('indexedDB' in window && indexedDB.databases) {
          const dbs = await indexedDB.databases();
          dbNames = dbs.map((d) => d.name);
        }
      } catch (e) {}
      return {
        cookie: document.cookie,
        localStorageKeys: Object.keys(window.localStorage || {}),
        sessionStorageKeys: Object.keys(window.sessionStorage || {}),
        indexedDBNames: dbNames,
      };
    });
    console.log('[调试] 页面实际看到的存储情况:', JSON.stringify(debugStorage));

    // ---- 登录状态有效性检测 ----
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

    // ---- 续期前：读取到期时间 ----
    const beforeDate = await extractUntilDate(page);
    await page.screenshot({ path: beforeShot, fullPage: true });
    console.log('续期前到期时间:', beforeDate);

    // ---- 定位并点击 Renew Free Tier 按钮 ----
    const renewBtn = page.getByRole('button', { name: /renew free tier/i }).first();
    const btnVisible = await renewBtn.isVisible().catch(() => false);

    if (!btnVisible) {
      await sendTelegram(
        `⚠️ ModVC 未找到「Renew Free Tier」按钮（可能页面结构变化、已升级为 Pro，或暂不在可续期窗口）。\n当前到期时间：${beforeDate || '未提取到'}`,
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

    const afterDate = await extractUntilDate(page);
    await page.screenshot({ path: afterShot, fullPage: true });
    console.log('续期后到期时间:', afterDate);

    let resultMsg;
    if (beforeDate && afterDate) {
      const beforeMs = new Date(beforeDate.replace(/\//g, '-')).getTime();
      const afterMs = new Date(afterDate.replace(/\//g, '-')).getTime();

      if (afterMs > beforeMs) {
        const diffDays = Math.round((afterMs - beforeMs) / 86400000);
        resultMsg =
          `✅ ModVC 续期成功！\n` +
          `续期前到期时间：${beforeDate}\n` +
          `续期后到期时间：${afterDate}\n` +
          `增加了约 ${diffDays} 天`;
      } else if (afterMs === beforeMs) {
        resultMsg =
          `ℹ️ ModVC 续期未生效（到期时间没有变化）。\n` +
          `到期时间：${beforeDate}\n` +
          `可能尚未到可续期时间窗口，或按钮点击未真正生效，请查看截图核实。`;
      } else {
        resultMsg =
          `⚠️ ModVC 续期后到期时间反而变小，请人工核实。\n` +
          `续期前：${beforeDate}\n续期后：${afterDate}`;
      }
    } else {
      resultMsg =
        `⚠️ ModVC 续期流程已执行，但未能正确提取到期时间。\n` +
        `续期前：${beforeDate || '未提取到'}\n续期后：${afterDate || '未提取到'}\n` +
        `请查看截图核实，可能是页面文案有变化，需要调整提取规则。`;
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
