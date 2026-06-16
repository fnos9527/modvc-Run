/**
 * ModVC (panel.modvc.org) Free Tier 自动续期脚本
 *
 * 流程：
 * 1. 用 Cookie 编辑器导出的 cookies.txt（Netscape 格式）内容登录
 * 2. 打开 Overview 页面，读取 "FREE TIER until" 的到期时间（续期前）
 * 3. 点击 "Renew Free Tier" 按钮
 * 4. 刷新页面，再次读取到期时间（续期后），对比是否有变化
 * 5. 通过 Telegram 机器人发送结果通知（含截图）
 * 6. 如果 Cookie 已失效（被踢回登录页），立即发送告警通知
 */

const { chromium } = require('playwright');
const fs = require('fs');

const TARGET_URL = 'https://panel.modvc.org/#pricing';

const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const COOKIES_RAW = process.env.MODVC_COOKIES;

// ------------------------- 工具函数 -------------------------

/**
 * 解析 Netscape 格式 cookies.txt 内容为 Playwright 可用的 cookie 数组
 * 每行格式：domain \t includeSubdomains \t path \t secure \t expiry \t name \t value
 */
function parseNetscapeCookies(raw) {
  const cookies = [];
  const lines = raw.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue; // 跳过空行/注释行

    const parts = trimmed.split('\t');
    if (parts.length < 7) continue;

    let domain = parts[0];
    const includeSub = parts[1];
    const cpath = parts[2] || '/';
    const secure = parts[3];
    const expiry = parts[4];
    const name = parts[5];
    const value = parts.slice(6).join('\t'); // 防止 value 里也含 tab

    if (includeSub && includeSub.toUpperCase() === 'TRUE' && !domain.startsWith('.')) {
      domain = '.' + domain;
    }

    const expiryNum = parseInt(expiry, 10);

    cookies.push({
      name,
      value,
      domain,
      path: cpath,
      secure: (secure || '').toUpperCase() === 'TRUE',
      expires: Number.isFinite(expiryNum) && expiryNum > 0 ? expiryNum : -1,
    });
  }

  return cookies;
}

/** 从页面正文中提取 "FREE TIER until xxxx/x/x" 这样的日期 */
async function extractUntilDate(page) {
  const text = await page.evaluate(() => document.body.innerText);

  // 优先匹配 "until" 紧跟的日期
  let match = text.match(/until\s*\n?\s*(\d{4}\/\d{1,2}\/\d{1,2})/i);
  if (match) return match[1];

  // 兜底：在 "FREE TIER" 附近 100 字符内找日期
  const idx = text.toUpperCase().indexOf('FREE TIER');
  if (idx !== -1) {
    const snippet = text.slice(idx, idx + 120);
    const m2 = snippet.match(/(\d{4}\/\d{1,2}\/\d{1,2})/);
    if (m2) return m2[1];
  }

  return null;
}

/** 粗略判断是否被踢回了登录页（Cookie 失效） */
function isLoggedOut(text) {
  const lower = text.toLowerCase();
  const hasLoginHint = /sign in|log in|forgot password|email address/.test(lower) && /password/.test(lower);
  const hasDashboardHint = /overview|free tier|renew free tier|public url/i.test(text);
  return hasLoginHint && !hasDashboardHint;
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
  if (!COOKIES_RAW) {
    console.error('未配置 MODVC_COOKIES Secret');
    await sendTelegram('❌ ModVC 续期失败：未配置 MODVC_COOKIES Secret，请先导出 Cookie 并添加到 GitHub Secrets。');
    process.exit(1);
  }

  const cookies = parseNetscapeCookies(COOKIES_RAW);
  if (cookies.length === 0) {
    console.error('Cookie 解析为空');
    await sendTelegram('❌ ModVC 续期失败：MODVC_COOKIES 内容解析为空，请检查是否为 Netscape 格式（Tab 分隔）的 cookies.txt 原文。');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addCookies(cookies);
  const page = await context.newPage();

  let beforeShot = 'before.png';
  let afterShot = 'after.png';

  try {
    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    let bodyText = await page.evaluate(() => document.body.innerText);

    // ---- Cookie 失效检测 ----
    if (isLoggedOut(bodyText)) {
      await page.screenshot({ path: beforeShot, fullPage: true });
      await sendTelegram(
        '⚠️ ModVC Cookie 已失效！页面被重定向到登录页，自动续期未执行。\n请重新登录 panel.modvc.org，用 Cookie 编辑器重新导出 cookies.txt，并更新 GitHub Secret：MODVC_COOKIES。',
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
    await page.waitForTimeout(3000);

    bodyText = await page.evaluate(() => document.body.innerText);
    if (isLoggedOut(bodyText)) {
      await page.screenshot({ path: afterShot, fullPage: true });
      await sendTelegram('⚠️ ModVC 点击续期后 Cookie 失效（被踢回登录页），请重新更新 MODVC_COOKIES。', afterShot);
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
