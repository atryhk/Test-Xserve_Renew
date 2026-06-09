#!/usr/bin/env node

const { chromium } = require('playwright');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');

const LOGIN_URL = 'https://secure.xserver.ne.jp/xapanel/login/xmgame';
const STATE_FILE = 'state.json';

const LOCAL_PROXY = 'http://127.0.0.1:8080';
const LOCAL_PROXY_HOST = '127.0.0.1';
const LOCAL_PROXY_PORT = 8080;

const MIN_DELAY_MINUTES = 3;
const MAX_DELAY_MINUTES = 10;

function loadJsonEnv(name) {
  try {
    if (!process.env[name]) return {};
    return JSON.parse(process.env[name]);
  } catch {
    return {};
  }
}

const ALL_VARS = loadJsonEnv('ALL_VARS');
const ALL_SECRETS = loadJsonEnv('ALL_SECRETS');
const ENV = { ...ALL_VARS, ...ALL_SECRETS, ...process.env };

function getEnv(name, def = '') {
  const v = ENV[name];
  return v === undefined || v === null ? def : String(v);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatTimeUTC8(ts) {
  return new Date(ts + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
}

function safeFileName(s) {
  return String(s).replace(/[^A-Za-z0-9_.-]/g, '_');
}

function maskEmail(email) {
  if (!email) return '';
  const [name, domain] = email.split('@');
  if (!domain) return email.slice(0, 2) + '***';

  const maskedName = name.length <= 2 ? name.slice(0, 1) + '***' : name.slice(0, 2) + '***';
  const parts = domain.split('.');

  if (parts.length >= 2) {
    return `${maskedName}@${parts[0].slice(0, 2)}***.${parts.slice(1).join('.')}`;
  }

  return `${maskedName}@${domain.slice(0, 2)}***`;
}

function maskHost(host) {
  if (!host) return '';

  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const p = host.split('.');
    return `${p[0]}.*.*.${p[3]}`;
  }

  if (host.includes(':')) {
    const p = host.split(':').filter(Boolean);
    if (p.length >= 2) return `${p[0]}:*:*:${p[p.length - 1]}`;
    return host.slice(0, 2) + '***';
  }

  const parts = host.split('.');
  if (parts.length >= 2) {
    return `${parts[0].slice(0, 2)}***.${parts.slice(1).join('.')}`;
  }

  return host.slice(0, 2) + '***';
}

function maskProxy(proxy) {
  if (!proxy || proxy === 'DIRECT') return 'DIRECT';

  try {
    const u = new URL(proxy);
    const scheme = u.protocol.replace(':', '');
    const port = u.port ? ':' + u.port : '';
    return `${scheme}://${maskHost(u.hostname)}${port}`;
  } catch {
    const scheme = proxy.includes('://') ? proxy.split('://')[0] : 'unknown';
    return `${scheme}://***`;
  }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function updateState(key, data) {
  const state = loadState();
  state[key] = {
    expireTime: data.expireTime || state[key]?.expireTime || null,
    expireTimeStr: data.expireTimeStr || state[key]?.expireTimeStr || null,
    renewTime: data.renewTime || state[key]?.renewTime || null,
    renewTimeStr: data.renewTimeStr || state[key]?.renewTimeStr || null
  };
  saveState(state);
}

function discoverAccountKeys() {
  const keys = [];

  for (const name of Object.keys(ENV)) {
    const m = name.match(/^X_SERVER_([A-Za-z0-9_]+)$/);
    if (m && m[1]) keys.push(m[1]);
  }

  return [...new Set(keys)].sort((a, b) => {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function parseTelegram() {
  const raw = getEnv('TG_TC').trim();
  if (!raw) return { token: '', chatId: '' };

  const parts = raw.split(/\s+/);
  return {
    token: parts[0] || '',
    chatId: parts[1] || ''
  };
}

function parseAccount(key) {
  const raw = getEnv(`X_SERVER_${key}`).trim();
  if (!raw) throw new Error(`未找到 X_SERVER_${key}`);

  const parts = raw.split(/\s+/);
  const email = parts.shift();
  const password = parts.join(' ');

  if (!email || !password) {
    throw new Error(`X_SERVER_${key} 格式错误，应为: email password`);
  }

  const planRaw = getEnv(`PLAN_${key}`, '16').trim() || '16';
  const threshold = parseFloat(planRaw);

  if (!Number.isFinite(threshold)) {
    throw new Error(`PLAN_${key} 不是有效数字: ${planRaw}`);
  }

  const primaryProxy = getEnv(`PROXY_URL_${key}`).trim();
  const backupProxy = getEnv(`PROXY_URLB_${key}`).trim();

  const proxies = [];

  if (primaryProxy) {
    proxies.push({
      name: '主代理',
      value: primaryProxy
    });
  }

  if (backupProxy) {
    proxies.push({
      name: '备用代理',
      value: backupProxy
    });
  }

  if (!proxies.length) {
    proxies.push({
      name: '直连',
      value: 'DIRECT'
    });
  }

  return {
    key,
    safeKey: safeFileName(key),
    email,
    emailMasked: maskEmail(email),
    password,
    threshold,
    proxies
  };
}

function shouldRunAccount(account, noStateFile) {
  if (noStateFile) {
    return {
      run: true,
      reason: '无 state.json，首次初始化'
    };
  }

  const state = loadState();
  const s = state[account.key];

  if (!s || !s.renewTime) {
    return {
      run: true,
      reason: '新账号或缺少可续期时间'
    };
  }

  if (Date.now() >= Number(s.renewTime)) {
    return {
      run: true,
      reason: '已到可续期检查时间'
    };
  }

  return {
    run: false,
    reason: `未到可续期时间 ${s.renewTimeStr || formatTimeUTC8(Number(s.renewTime))}`
  };
}

async function sendTG(tg, title, lines) {
  if (!tg.token || !tg.chatId) return;

  const text = [
    title,
    ...lines,
    `时间: ${formatTimeUTC8(Date.now())}`
  ].join('\n');

  try {
    const res = await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tg.chatId, text })
    });

    if (res.ok) {
      console.log('✅ TG 通知已发送');
    } else {
      console.log('⚠️ TG 通知失败:', res.status, await res.text());
    }
  } catch (e) {
    console.log('⚠️ TG 发送失败:', e.message);
  }
}

function writeScheduleByRemaining(account, remainingMins, reason) {
  const now = Date.now();
  const expireTime = now + remainingMins * 60 * 1000;
  const renewTime = expireTime - account.threshold * 3600000;

  const safeRenewTime = Math.max(now + 30 * 60 * 1000, renewTime);

  updateState(account.key, {
    expireTime,
    expireTimeStr: formatTimeUTC8(expireTime),
    renewTime: safeRenewTime,
    renewTimeStr: formatTimeUTC8(safeRenewTime)
  });

  console.log(`📅 [${account.key}] 到期时间: ${formatTimeUTC8(expireTime)}`);
  console.log(`📅 [${account.key}] 可续期检查时间: ${formatTimeUTC8(safeRenewTime)}，原因: ${reason}`);

  return {
    expireTime,
    expireTimeStr: formatTimeUTC8(expireTime),
    renewTime: safeRenewTime,
    renewTimeStr: formatTimeUTC8(safeRenewTime)
  };
}

function writeRetrySchedule(account, hoursLater) {
  const state = loadState();
  const old = state[account.key] || {};
  const renewTime = Date.now() + hoursLater * 3600000;

  updateState(account.key, {
    expireTime: old.expireTime || null,
    expireTimeStr: old.expireTimeStr || null,
    renewTime,
    renewTimeStr: formatTimeUTC8(renewTime)
  });

  console.log(`📅 [${account.key}] 失败重试时间: ${formatTimeUTC8(renewTime)}`);
}

async function parseRemainingMinutes(page) {
  try {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(2500);

    const text = await page.evaluate(() => document.body.innerText || '');

    let m = text.match(/残り\s*(\d+)\s*時間\s*(\d+)\s*分/);
    if (m) {
      const mins = parseInt(m[1]) * 60 + parseInt(m[2]);
      console.log(`⏱️ 剩余时间: ${m[1]}小时${m[2]}分钟`);
      return mins;
    }

    m = text.match(/残り\s*(\d+)\s*時間/);
    if (m) {
      const mins = parseInt(m[1]) * 60;
      console.log(`⏱️ 剩余时间: ${m[1]}小时`);
      return mins;
    }

    m = text.match(/(\d+)\s*時間\s*(\d+)\s*分/);
    if (m) {
      const mins = parseInt(m[1]) * 60 + parseInt(m[2]);
      console.log(`⏱️ 剩余时间: ${m[1]}小时${m[2]}分钟`);
      return mins;
    }

    console.log('⚠️ 未找到剩余时间');
    return null;
  } catch (e) {
    console.log('⚠️ 解析剩余时间失败:', e.message);
    return null;
  }
}

function isLocalProxy(proxy) {
  try {
    const u = new URL(proxy);
    return ['127.0.0.1', 'localhost'].includes(u.hostname) && String(u.port || '') === '8080';
  } catch {
    return false;
  }
}

function waitPort(host, port, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    function check() {
      const socket = net.connect(port, host);

      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });

      socket.once('error', () => {
        socket.destroy();

        if (Date.now() - start > timeoutMs) {
          reject(new Error(`等待本地代理端口 ${host}:${port} 超时`));
        } else {
          setTimeout(check, 500);
        }
      });
    }

    check();
  });
}

async function startProxy(proxyValue) {
  if (!proxyValue || proxyValue === 'DIRECT') {
    return {
      proxyServer: null,
      process: null,
      mode: 'DIRECT'
    };
  }

  if (isLocalProxy(proxyValue)) {
    return {
      proxyServer: proxyValue,
      process: null,
      mode: 'LOCAL_EXISTING'
    };
  }

  if (!fs.existsSync('./proxyurl.js')) {
    throw new Error('未找到 proxyurl.js');
  }

  if (!fs.existsSync('./sing-box')) {
    throw new Error('未找到 ./sing-box');
  }

  try {
    if (fs.existsSync('config.json')) fs.unlinkSync('config.json');
  } catch {}

  execFileSync(process.execPath, ['proxyurl.js'], {
    env: {
      ...process.env,
      PROXY_URL: proxyValue
    },
    stdio: 'pipe'
  });

  if (!fs.existsSync('config.json')) {
    throw new Error('proxyurl.js 未生成 config.json');
  }

  const out = fs.openSync('singbox.log', 'a');

  const p = spawn('./sing-box', ['run', '-c', 'config.json'], {
    stdio: ['ignore', out, out]
  });

  await waitPort(LOCAL_PROXY_HOST, LOCAL_PROXY_PORT, 12000);
  await sleep(1500);

  return {
    proxyServer: LOCAL_PROXY,
    process: p,
    mode: 'SINGBOX'
  };
}

async function stopProxy(runtime) {
  if (runtime && runtime.process) {
    try {
      runtime.process.kill('SIGTERM');
    } catch {}

    await sleep(1200);

    try {
      runtime.process.kill('SIGKILL');
    } catch {}
  }
}

async function checkIp(page, account) {
  try {
    await page.goto('https://api.ipify.org/?format=json', {
      waitUntil: 'load',
      timeout: 15000
    });

    const body = await page.textContent('body');
    const ip = JSON.parse(body).ip;
    console.log(`🌐 [${account.key}] 当前出口 IP: ${maskHost(ip)}`);
  } catch {
    console.log(`⚠️ [${account.key}] 出口 IP 检查失败`);
  }
}

async function tryRenew(page, account, beforeMins) {
  let success = false;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`🔄 [${account.key}] 第 ${attempt}/3 次尝试续期`);

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2000);

      const btn = page.locator('a,button').filter({ hasText: '期限を延長する' }).first();

      await btn.waitFor({
        state: 'visible',
        timeout: 6000
      });

      await btn.click();

      await page.waitForLoadState('load').catch(() => {});
      await page.getByRole('button', { name: '確認画面に進む' }).click();

      await page.waitForLoadState('load').catch(() => {});
      await page.getByRole('button', { name: '期限を延長する' }).click();

      await page.waitForLoadState('load').catch(() => {});
      await page.screenshot({ path: `${account.safeKey}_renew_done.png` }).catch(() => {});

      await page.getByRole('link', { name: '戻る' }).click();

      await page.waitForLoadState('load').catch(() => {});
      await page.screenshot({ path: `${account.safeKey}_success.png` }).catch(() => {});

      success = true;
      break;
    } catch (e) {
      console.log(`⚠️ [${account.key}] 第 ${attempt} 次续期失败: ${e.message}`);

      if (attempt < 3) {
        console.log(`⏳ [${account.key}] 等待 5 分钟后刷新重试`);
        await page.waitForTimeout(5 * 60 * 1000);
        await page.reload({ waitUntil: 'load' }).catch(() => {});
      }
    }
  }

  if (!success) {
    await page.screenshot({ path: `${account.safeKey}_renew_failed.png` }).catch(() => {});
    writeRetrySchedule(account, 1);
    throw new Error('3次尝试均未成功续期');
  }

  const afterMins = await parseRemainingMinutes(page);

  if (afterMins === null) {
    writeRetrySchedule(account, 1);
    throw new Error('续期后无法解析新的剩余时间');
  }

  const beforeH = beforeMins !== null && beforeMins !== undefined ? (beforeMins / 60).toFixed(1) : '?';
  const afterH = (afterMins / 60).toFixed(1);

  const schedule = writeScheduleByRemaining(account, afterMins, '续期成功后更新');

  return {
    beforeH,
    afterH,
    schedule
  };
}

async function runBrowserFlow(account, proxyServer) {
  const launchOpts = {
    headless: true
  };

  if (proxyServer) {
    launchOpts.proxy = {
      server: proxyServer
    };
  }

  const browser = await chromium.launch(launchOpts);

  const context = await browser.newContext({
    viewport: {
      width: 1920,
      height: 1080
    },
    locale: 'ja-JP'
  });

  const page = await context.newPage();

  try {
    await checkIp(page, account);

    console.log(`🌐 [${account.key}] 打开登录页面`);
    await page.goto(LOGIN_URL, {
      waitUntil: 'load',
      timeout: 30000
    });

    await page.screenshot({ path: `${account.safeKey}_1_navigation.png` }).catch(() => {});

    console.log(`📧 [${account.key}] 填写账号密码: ${account.emailMasked}`);
    await page.locator('#memberid').fill(account.email);
    await page.locator('#user_password').fill(account.password);

    await page.screenshot({ path: `${account.safeKey}_2_filled.png` }).catch(() => {});

    console.log(`🖱️ [${account.key}] 提交登录`);

    await Promise.all([
      page.waitForNavigation({
        waitUntil: 'load',
        timeout: 30000
      }).catch(() => {}),
      page.locator('input[name="action_user_login"]').click()
    ]);

    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${account.safeKey}_3_after_login.png` }).catch(() => {});

    console.log(`🚀 [${account.key}] 点击游戏管理`);
    await page.getByRole('link', { name: 'ゲーム管理' }).click();

    await page.waitForLoadState('load').catch(() => {});
    await page.screenshot({ path: `${account.safeKey}_4_game_manage.png` }).catch(() => {});

    const totalMins = await parseRemainingMinutes(page);

    console.log(`🚀 [${account.key}] 进入升级/期限延长页面`);
    await page.getByRole('link', { name: 'アップグレード・期限延長' }).click();

    await page.waitForLoadState('load').catch(() => {});
    await page.screenshot({ path: `${account.safeKey}_5_renew_page.png` }).catch(() => {});

    if (totalMins === null) {
      console.log(`⚠️ [${account.key}] 无法解析剩余时间，尝试直接续期`);
      const renewed = await tryRenew(page, account, null);

      return {
        action: 'renewed',
        ...renewed
      };
    }

    const hours = totalMins / 60;
    writeScheduleByRemaining(account, totalMins, '登录检测后更新');

    if (hours <= account.threshold) {
      console.log(`🚨 [${account.key}] 剩余 ${hours.toFixed(1)}h <= 阈值 ${account.threshold}h，执行续期`);
      const renewed = await tryRenew(page, account, totalMins);

      return {
        action: 'renewed',
        ...renewed
      };
    }

    console.log(`🔭 [${account.key}] 剩余 ${hours.toFixed(1)}h > 阈值 ${account.threshold}h，未到续期时间`);

    return {
      action: 'not_due',
      remainingH: hours.toFixed(1)
    };
  } catch (e) {
    await page.screenshot({ path: `${account.safeKey}_failure.png` }).catch(() => {});
    throw e;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function runOneAccount(account) {
  console.log('==================================================');
  console.log(`账号: [${account.key}] ${account.emailMasked}`);
  console.log(`续期阈值: ${account.threshold}h`);
  console.log('==================================================');

  const delayMinutes = randomInt(MIN_DELAY_MINUTES, MAX_DELAY_MINUTES);
  console.log(`🎲 [${account.key}] 随机延迟 ${delayMinutes} 分钟后开始运行`);
  await sleep(delayMinutes * 60 * 1000);

  let lastError = null;
  let lastProxy = '';

  for (const proxy of account.proxies) {
    let runtime = null;
    const maskedProxy = maskProxy(proxy.value);
    lastProxy = maskedProxy;

    try {
      console.log(`🌐 [${account.key}] 尝试${proxy.name}: ${maskedProxy}`);

      runtime = await startProxy(proxy.value);
      const result = await runBrowserFlow(account, runtime.proxyServer);

      return {
        key: account.key,
        account: account.emailMasked,
        status: result.action,
        proxy: maskedProxy,
        result
      };
    } catch (e) {
      lastError = e;
      console.log(`⚠️ [${account.key}] ${proxy.name}失败: ${e.message}`);
    } finally {
      await stopProxy(runtime);
    }
  }

  writeRetrySchedule(account, 1);

  return {
    key: account.key,
    account: account.emailMasked,
    status: 'failed',
    proxy: lastProxy,
    error: lastError ? lastError.message : '未知错误'
  };
}

async function main() {
  console.log('==================================================');
  console.log('XServer 自动延期 - state 预检查版');
  console.log(`随机延迟: 每个实际运行账号 ${MIN_DELAY_MINUTES}-${MAX_DELAY_MINUTES} 分钟`);
  console.log('==================================================');

  const tg = parseTelegram();
  const keys = discoverAccountKeys();

  if (!keys.length) {
    console.log('❌ 未发现账号，请设置 X_SERVER_xxx');
    process.exit(1);
  }

  const noStateFile = !fs.existsSync(STATE_FILE);
  const isManual = getEnv('GITHUB_EVENT_NAME') === 'workflow_dispatch';

  console.log(`发现账号数量: ${keys.length}`);
  console.log(`发现账号后缀: ${keys.join(', ')}`);
  console.log(`state.json: ${noStateFile ? '不存在' : '存在'}`);

  const results = [];
  const skipped = [];

  for (const key of keys) {
    try {
      const account = parseAccount(key);
      const decision = shouldRunAccount(account, noStateFile);

      if (!decision.run) {
        console.log(`⏭️ [${key}] 跳过: ${decision.reason}`);
        skipped.push({
          key,
          account: account.emailMasked,
          reason: decision.reason
        });
        continue;
      }

      console.log(`▶️ [${key}] 需要运行: ${decision.reason}`);

      const result = await runOneAccount(account);
      results.push(result);
    } catch (e) {
      console.log(`❌ [${key}] 初始化或运行失败: ${e.message}`);

      results.push({
        key,
        account: '',
        status: 'failed',
        proxy: '',
        error: e.message
      });
    }
  }

  const renewed = results.filter(r => r.status === 'renewed');
  const failed = results.filter(r => r.status === 'failed');

  const shouldNotifyInit = noStateFile && isManual;
  const shouldNotify = renewed.length > 0 || failed.length > 0 || shouldNotifyInit;

  if (shouldNotify) {
    const lines = [];

    if (renewed.length) {
      lines.push('✅ 续期成功');
      for (const r of renewed) {
        lines.push(
          `[${r.key}] ${r.account}`,
          `代理: ${r.proxy}`,
          `续期前: ${r.result.beforeH}h`,
          `续期后: ${r.result.afterH}h`,
          `到期时间: ${r.result.schedule.expireTimeStr}`,
          `下次可续期检查: ${r.result.schedule.renewTimeStr}`
        );
      }
    }

    if (failed.length) {
      lines.push('❌ 续期失败');
      for (const r of failed) {
        lines.push(
          `[${r.key}] ${r.account || ''}`,
          `代理: ${r.proxy || ''}`,
          `错误: ${r.error || '未知错误'}`,
          '已设置 1 小时后重试'
        );
      }
    }

    if (shouldNotifyInit && !renewed.length && !failed.length) {
      lines.push('ℹ️ 首次手动初始化完成');
      lines.push(`检测账号数: ${keys.length}`);
      lines.push(`实际检查账号数: ${results.length}`);
      lines.push(`未到续期账号数: ${results.filter(r => r.status === 'not_due').length}`);
      lines.push('state.json 已生成，后续定时任务会先按可续期时间预检查');
    }

    await sendTG(tg, 'XServer 延期通知', lines);
  } else {
    console.log('🔕 无续期成功/失败，且不是首次手动初始化，不发送通知');
  }

  if (failed.length) {
    process.exitCode = 1;
  }
}

main().catch(e => {
  console.log('❌ 主流程异常:', e.message);
  process.exit(1);
});