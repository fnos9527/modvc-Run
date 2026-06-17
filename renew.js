/**
 * ModVC (panel.modvc.org) Free Tier 自动续期脚本
 *
 * 鉴权方式：该站点用的是 localStorage 里存的 JWT（Authorization: Bearer ...），
 * 不是传统 Cookie Session，所以这里用 Playwright 的 storageState 整体还原登录态
 * （Cookie + localStorage），并额外手动注入 sessionStorage（标准 storageState 不含）。
 *
 * 流程：
 * 1. 还原登录状态（MODVC_STATE）
 * 2. 打开 Overview 页面，确认确实进入了仪表盘（而不是被打回首页/登录页）
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

  // 优先匹配 "until" 紧跟的日期
  let match = text.match(/until\s*\n?\s*(\d{4}\/\d{1,2}\/\d{1,2})/i);
  if (match) return match[1];

  // 兜底：在 "FREE TIER" 附近 120 字符内找日期
  const idx = text.toUpperCase().indexOf('FREE TIER');
  if (idx !== -1) {
    const snippet = text.slice(idx, idx + 120);
    const m2 = snippet.match(/(\d{4}\/\d{1,2}\/\d{1,2})/);
    if (m2) return m2[1];
  }

  return null;
}

/** 等待仪表盘真正加载出来（看到 FREE TIER / Renew Free Tier 等关键字） */
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

  // sessionStorage 是我们自定义加进去的字段，标准 Playwright storageState 不认识，要单独摘出来
  const { sessionStorage: sessionStorageItems, ...storageState } = parsedState;

  if (!storageState.cookies && !storageState.origins) {
    console.error('MODVC_STATE 缺少 cookies/origins 字段，格式不对');
    await sendTelegram('❌ ModVC 续期失败：MODVC_STATE 缺少 cookies/origins 字段，请重新用控制台脚本导出。');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState,
    viewport: { width: 1600, height: 1000 },
  });

  // 手动把 sessionStorage 注入到每个新打开的页面里（在脚本运行前执行）
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

  const beforeShot = 'before.png';
  const afterShot = 'after.png';

  try {
    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60000 });

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

    // 部分站点点击后会弹出二次确认框，尝试自动确认
    const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("OK"), button:has-text("Yes")').first();
    if (await confirmBtn.isVisible().catch(() => false)) {
      await confirmBtn.click();
      await page.waitForTimeout(3000);
    }

    // 刷新页面，确保从服务端拿到最新数据
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

    // ---- 对比续期前后的到期时间 ----
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
