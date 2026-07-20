const { chromium } = require('playwright');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const proxyPool = require('./proxyPool.cjs');
const { execFileSync } = require('child_process');
const PYTHON = process.platform === 'win32'
  ? 'C:\\Users\\13249\\AppData\\Local\\Programs\\Python\\Python312\\python.exe'
  : 'python3';
const SCRAPER_PATH = __dirname + '/missav_scraper.py';

function scrapeWithPython(code) {
  try {
    const stdout = execFileSync(PYTHON, [SCRAPER_PATH, code], {
      timeout: 30000,
      encoding: 'utf8',
      env: Object.assign({}, process.env)
    });
    const data = JSON.parse(stdout);
    if (data.error) {
      console.log('[Py]', code, 'Error:', data.error);
      return null;
    }
    if (data.m3u8_url) {
      console.log('[Py]', code, '->', data.method, data.mirror, data.m3u8_url.substring(0, 50));
      return data;
    }
    return null;
  } catch(e) {
    console.log('[Py] Exception:', e.message.substring(0, 80));
    return null;
  }
}

const BOT_TOKEN = '8889310845:AAFtgz9vTlb8vrPG7m0aPnT0mjXLwCQx-fs';
const PORT = process.env.PORT || 3456;
const PROXY_HOST = process.env.RAILWAY_PUBLIC_DOMAIN
  ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
  : 'http://localhost:' + PORT;

let browser, ctx, pg;
let browserReady = false;
let warmupOk = false;

function isCfPage(title) {
  const t = title.toLowerCase();
  return t.indexOf('just a moment') !== -1 || t.indexOf('please wait') !== -1 || t.indexOf('attention required') !== -1;
}

async function initBrowser(proxyAddr) {
  try {
    if (browser) {
      try { await browser.close(); } catch(e) {}
      browser = null; ctx = null; pg = null;
    }

    const launchOpts = {
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-web-security'
      ]
    };

    if (proxyAddr) {
      launchOpts.args.push('--proxy-server=http://' + proxyAddr);
      console.log('[Browser] Using proxy:', proxyAddr);
    }

    browser = await chromium.launch(launchOpts);
    ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York'
    });

    pg = await ctx.newPage();
    await pg.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    });

    console.log('[Browser] Warming up on missav.ai...');
    let ok = false;
    const mr = proxyAddr ? 5 : 12; for (let i = 0; i < mr; i++) {
      try {
        await pg.goto('https://missav.ai', { waitUntil: 'domcontentloaded', timeout: proxyAddr ? 10000 : 15000 });
      } catch(e) {}
      await pg.waitForTimeout(proxyAddr ? 1500 : 2000);
      const title = await pg.title();
      const content = await pg.content();
      if (!isCfPage(title) && (title.indexOf('MissAV') !== -1 || content.indexOf('missav') !== -1)) {
        console.log('[Warmup] OK:', title);
        ok = true;
        break;
      }
      console.log('[Warmup]', proxyAddr ? '(proxy)' : '(direct)', 'CF:', title, 'retry', i + 1);
      await pg.waitForTimeout(2000);
    }

    browserReady = true;
    warmupOk = ok;
    console.log('[Browser] Ready. Warmup:', ok ? 'SUCCESS' : 'FAILED');
    return ok;
  } catch(e) {
    console.error('[Browser] Init error:', e.message);
    throw e;
  }
}

// Scrape JAV info: try page.evaluate(fetch) first, then page.goto fallback
async function scrapeJav(code) {
  code = code.toUpperCase();
  const pyResult = scrapeWithPython(code);
  if (pyResult && pyResult.m3u8_url) {
    return {
      code: pyResult.code || code,
      title: pyResult.title || code,
      cover: pyResult.cover || null,
      m3u8_url: pyResult.m3u8_url,
      resolution: pyResult.resolution || 'unknown',
      uuid: pyResult.uuid || '',
      _source: 'python'
    };
  }
  console.log('[Scrape] Python failed, trying Playwright...');
  code = code.toUpperCase();
  code = code.toUpperCase();
  const videoPath = code.toLowerCase();

  // First navigate to homepage to get CF cookies
  const currentUrl = pg ? await pg.evaluate(() => window.location.href).catch(() => '') : '';
  if (currentUrl.indexOf('missav.ai') === -1) {
    let ok = false;
    for (let i = 0; i < 10; i++) {
      try {
        await pg.goto('https://missav.ai', { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch(e) {}
      await pg.waitForTimeout(2000);
      const title = await pg.title();
      if (!isCfPage(title) && title.indexOf('MissAV') !== -1) { ok = true; break; }
      await pg.waitForTimeout(2000);
    }
    if (!ok) return null;
  }

  // Use page.evaluate fetch (preserves CF cookies)
  console.log('[Scrape] Fetching', code, 'via page.evaluate...');
  const html = await pg.evaluate(async (vPath) => {
    try {
      const resp = await fetch('https://missav.ai/' + vPath, { headers: { 'Accept': 'text/html' } });
      return await resp.text();
    } catch(e) { return null; }
  }, videoPath);

  if (!html) return null;

  let idx = html.indexOf('m3u8|');
  if (idx === -1) {
    // Fallback: try page.goto
    console.log('[Scrape] m3u8 not in evaluate, trying goto fallback...');
    for (let i = 0; i < 8; i++) {
      try {
        await pg.goto('https://missav.ai/' + videoPath, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch(e) {}
      await pg.waitForTimeout(2000);
      const title = await pg.title();
      if (!isCfPage(title)) { idx = 0; break; }
      await pg.waitForTimeout(2000);
    }
    if (idx !== 0) return null;
    const fullHtml = await pg.content();
    idx = fullHtml.indexOf('m3u8|');
    if (idx === -1) return null;
    return parseMissavPage(fullHtml, idx, code);
  }

  return parseMissavPage(html, idx, code);
}

function parseMissavPage(html, idx, code) {
  const sec = html.substring(idx, idx + 300);
  const pts = sec.split('|');
  const hex = [];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i] === 'com') break;
    if (/^[a-f0-9]+$/i.test(pts[i])) hex.push(pts[i]);
  }
  const uuid = hex.reverse().join('-');
  if (!uuid || uuid.length < 20) return null;

  const ti = html.match(/og:title["'\s]+content=["']([^"']+)/);
  const ci = html.match(/og:image["'\s]+content=["']([^"']+)/);
  const title = ti ? ti[1].replace(/&amp;/g, '&') : code;

  return { code, title, cover: ci ? ci[1] : null, uuid };
}

async function getBestStream(uuid) {
  const headers = { 'Referer': 'https://missav.ai/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
  try {
    const r = await fetch('https://surrit.com/' + uuid + '/playlist.m3u8', { headers, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const pt = await r.text();
    if (pt.indexOf('#EXTM3U') === -1) return null;

    const streams = [];
    let cur = null;
    pt.split('\n').forEach(l => {
      if (l.startsWith('#EXT-X-STREAM-INF:')) {
        cur = {
          bw: parseInt((l.match(/BANDWIDTH=(\d+)/) || [,'0'])[1]),
          res: (l.match(/RESOLUTION=(\d+x\d+)/) || [,'0x0'])[1]
        };
      } else if (cur && l.trim() && !l.startsWith('#')) {
        cur.url = l.trim();
        streams.push(cur);
        cur = null;
      }
    });

    if (!streams.length) return null;
    streams.sort((a, b) => b.bw - a.bw);
    const best = streams[0];
    const vm3u8 = 'https://surrit.com/' + uuid + '/' + best.url;
    const tsBase = vm3u8.substring(0, vm3u8.lastIndexOf('/'));
    return { resolution: best.res, vm3u8, tsBase };
  } catch(e) { return null; }
}

async function streamVideo(code, res) {
  let info = await scrapeJav(code);
  if (!info) { res.status(404).json({ error: 'Not found', code }); return; }

  const headers = { 'Referer': 'https://missav.ai/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
  let vm3u8 = info.m3u8_url || '';
  if (!vm3u8 && info.uuid) vm3u8 = 'https://surrit.com/' + info.uuid + '/playlist.m3u8';
  if (!vm3u8) { res.status(404).json({ error: 'No stream URL' }); return; }

  // Fetch the variant m3u8 playlist
  let vt = null;
  try {
    const r = await fetch(vm3u8, { headers, signal: AbortSignal.timeout(10000) });
    if (r.ok) vt = await r.text();
  } catch(e) {}

  if (!vt || vt.indexOf('#EXTM3U') === -1) {
    res.status(502).json({ error: 'Cannot fetch playlist', url: vm3u8 });
    return;
  }

  // Find best quality variant if this is a multi-resolution playlist
  if (vt.indexOf('EXT-X-STREAM-INF') !== -1) {
    const base = vm3u8.substring(0, vm3u8.lastIndexOf('/'));
    const streams = [];
    let cur = null;
    vt.split('\n').forEach(l => {
      if (l.startsWith('#EXT-X-STREAM-INF:')) {
        cur = {
          bw: parseInt((l.match(/BANDWIDTH=(\d+)/) || [,'0'])[1]),
          res: (l.match(/RESOLUTION=(\d+x\d+)/) || [,'0x0'])[1]
        };
      } else if (cur && l.trim() && !l.startsWith('#')) {
        cur.url = l.trim();
        streams.push(cur);
        cur = null;
      }
    });
    streams.sort((a,b) => b.bw - a.bw);
    if (streams.length) {
      const best = streams[0];
      vm3u8 = base + '/' + best.url;
      info.resolution = best.res;
      // Fetch the actual segment playlist
      try {
        const r = await fetch(vm3u8, { headers, signal: AbortSignal.timeout(10000) });
        if (r.ok) vt = await r.text();
      } catch(e) {}
    }
  }

  // Extract TS segment URLs and stream them
  const segUrls = vt.split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l =>
    l.trim().startsWith('http') ? l.trim() : (vm3u8.substring(0, vm3u8.lastIndexOf('/'))) + '/' + l.trim()
  );

  if (segUrls.length === 0) {
    res.status(502).json({ error: 'No segments in playlist' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': 'inline; filename="' + info.code + '.mp4"'
  });

  for (let i = 0; i < segUrls.length; i++) {
    try {
      const r = await fetch(segUrls[i], { headers, signal: AbortSignal.timeout(15000) });
      if (r.ok) res.write(Buffer.from(await r.arrayBuffer()));
    } catch(e) {}
  }
  res.end();
  console.log('[Stream] Done', info.code);
}

// --- Express ---
const app = express();
app.get('/health', (req, res) => res.json({ ok: true, browser: browserReady, warmupOk, proxy: proxyPool.getProxyStatus() }));
app.get('/proxy', (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).json({ error: 'Missing code' });
  streamVideo(code, res).catch(e => { if (!res.headersSent) res.status(500).json({ error: e.message }); });
});
app.get('/proxy-pool', (req, res) => res.json(proxyPool.getProxyStatus()));
app.get('/restart', async (req, res) => {
  const proxy = proxyPool.getRandomProxy();
  console.log('[Restart] Triggered, using proxy:', proxy || 'none');
  initBrowser(proxy).catch(e => console.error('[Restart] Error:', e.message));
  res.json({ restarting: true, proxy });
});

// --- Telegram Bot ---
const bot = new TelegramBot(BOT_TOKEN, { polling: false });
setTimeout(() => {
  bot.startPolling().then(() => console.log('[Bot] Polling started')).catch(e => {
    console.error('[Bot] Polling fail:', e.message);
    setTimeout(() => bot.startPolling().catch(e2 => console.error('[Bot] Retry fail:', e2.message)), 10000);
  });
}, 3000);

bot.onText(/\/start/, msg => bot.sendMessage(msg.chat.id, '\u{1F3F0}JAV Bot\nSend JAV code, e.g.: SSIS-123'));
bot.onText(/\/restart/, async msg => {
  await bot.sendMessage(msg.chat.id, '\u{1F504}Restarting browser with proxy...');
  const proxy = proxyPool.getRandomProxy();
  initBrowser(proxy).catch(e => console.error('[Bot] Restart error:', e.message));
  bot.sendMessage(msg.chat.id, 'Browser restarted' + (proxy ? ' with proxy: ' + proxy : ''));
});

bot.on('message', async msg => {
  if (!msg.text || msg.text.startsWith('/')) return;
  if (!browserReady) { bot.sendMessage(msg.chat.id, '\u23F3Starting...'); return; }
  const code = msg.text.trim().toUpperCase();
  if (!/[A-Z]+-\d+/.test(code)) return;

  const cid = msg.chat.id;
  const sm = await bot.sendMessage(cid, '\uD83D\uDD0D ' + code + '...');
  console.log('[Bot] Search:', code);

  try {
    let info = await scrapeJav(code);

    // If page.evaluate failed, try page.goto fallback (already inside scrapeJav)
    // If still failed, try with a proxy
    if (!info) {
      const proxy = proxyPool.getRandomProxy();
      if (proxy) {
        console.log('[Bot] Retrying with proxy:', proxy);
        await bot.editMessageText('\uD83D\uDD0D ' + code + ' (proxy)...', { chat_id: cid, message_id: sm.message_id });
        await initBrowser(proxy);
        info = await scrapeJav(code);
        if (info) proxyPool.markProxySuccess(proxy);
      }
    }

    if (!info) {
      await bot.editMessageText('Not found: ' + code, { chat_id: cid, message_id: sm.message_id });
      return;
    }

    const url = PROXY_HOST + '/proxy?code=' + code;
    const cap = '\uD83D\uDCF2 ' + info.title + '\n\uD83D\uDCF1 ' + info.code + '\n' + (info.cover ? '' : '');
    await bot.deleteMessage(cid, sm.message_id);

    try {
      await bot.sendVideo(cid, url, { caption: cap, supports_streaming: true });
    } catch(e) {
      const kb = { reply_markup: { inline_keyboard: [[{ text: '\u25B6Play', url }]] } };
      if (info.cover) {
        await bot.sendPhoto(cid, info.cover, { caption: cap + '\n\n' + url, ...kb });
      } else {
        await bot.sendMessage(cid, cap + '\n\n' + url, kb);
      }
    }
    console.log('[Bot] Sent:', code);
  } catch(e) {
    console.error('[Bot] Error:', e.message);
    try { await bot.editMessageText('Error: ' + e.message.substring(0, 100), { chat_id: cid, message_id: sm.message_id }); } catch(e2) {}
  }
});

// --- Startup with correct ordering ---
app.listen(PORT, async () => {
  console.log('[Server] on port ' + PORT);

  console.log('[Startup] Step 1: Refreshing proxy pool...');
  try {
    await proxyPool.refreshPool();
    console.log('[Startup] Pool refresh complete:', proxyPool.getProxyStatus().count, 'proxies');
  } catch(e) {
    console.error('[Startup] Pool refresh error:', e.message);
  }

  setInterval(() => {
    proxyPool.refreshPool().catch(e => console.error('[Pool] Periodic refresh error:', e.message));
  }, 10 * 60 * 1000);

  const proxiesToTry = [''];
  let p = proxyPool.getRandomProxy();
  while (p) {
    proxiesToTry.push(p);
    p = proxyPool.getRandomProxy();
    if (proxiesToTry.length >= 15) break;
  }
  const unique = [...new Set(proxiesToTry)];

  let started = false;
  for (let i = 0; i < unique.length && !started; i++) {
    const proxy = unique[i] || null;
    console.log('[Startup] Starting browser' + (proxy ? ' with proxy: ' + proxy : ' without proxy') + ' (attempt ' + (i+1) + '/' + unique.length + ')');
    try {
      started = await initBrowser(proxy);
      if (proxy && started) proxyPool.markProxySuccess(proxy);
    } catch(e) {
      console.error('[Startup] Attempt ' + (i+1) + ' error:', e.message.substring(0, 60));
    }
  }

  console.log('[Startup] Complete. Browser warmup:', started ? 'SUCCESS' : 'FAILED');
});
