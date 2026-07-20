const { chromium } = require('playwright');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const proxyPool = require('./proxyPool.cjs');

const BOT_TOKEN = '8889310845:AAFtgz9vTlb8vrPG7m0aPnT0mjXLwCQx-fs';
const PORT = process.env.PORT || 3456;
const PROXY_HOST = process.env.RAILWAY_PUBLIC_DOMAIN
  ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
  : 'http://localhost:' + PORT;

let browser, ctx, pg;
let browserReady = false;
let currentProxy = null;

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

    // Stealth: hide webdriver, add plugins
    await pg.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    });

    console.log('[Browser] Warming up...');

    // Try to reach missav.ai homepage
    let ok = false;
    for (let i = 0; i < 12; i++) {
      try {
        await pg.goto('https://missav.ai', { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch(e) {}
      await pg.waitForTimeout(2000);
      const title = await pg.title();
      const content = await pg.content();

      if (!isCfPage(title) && (title.indexOf('MissAV') !== -1 || title.indexOf('missav') !== -1 || content.indexOf('missav') !== -1)) {
        console.log('[Warmup] OK:', title);
        ok = true;
        break;
      }
      console.log('[Warmup] CF:', title, 'retry', i + 1);
      await pg.waitForTimeout(2000);
    }

    browserReady = true;
    console.log('[Browser] Ready. Warmup:', ok ? 'SUCCESS' : 'FAILED (proxy may be needed)');
    return ok;
  } catch(e) {
    console.error('[Browser] Init error:', e.message);
    throw e;
  }
}

// Scrape JAV info using page.evaluate(fetch) instead of page.goto
// This preserves CF cookies from the current page
async function scrapeJav(code) {
  code = code.toUpperCase();
  const videoPath = code.toLowerCase();

  // First navigate to homepage to get CF cookies (if not already on missav)
  const currentUrl = pg ? await pg.evaluate(() => window.location.href).catch(() => '') : '';
  if (currentUrl.indexOf('missav.ai') === -1) {
    let ok = false;
    for (let i = 0; i < 10; i++) {
      try {
        await pg.goto('https://missav.ai', { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch(e) {}
      await pg.waitForTimeout(2000);
      const title = await pg.title();
      if (!isCfPage(title) && title.indexOf('MissAV') !== -1) {
        ok = true;
        break;
      }
      await pg.waitForTimeout(2000);
    }
    if (!ok) {
      console.log('[Scrape] Homepage blocked by CF for', code);
      return null;
    }
  }

  // Use page.evaluate to fetch video page via browser's fetch (preserves CF cookies)
  console.log('[Scrape] Fetching', code, 'via page.evaluate...');
  const html = await pg.evaluate(async (vPath) => {
    try {
      const resp = await fetch('https://missav.ai/' + vPath, {
        headers: { 'Accept': 'text/html,application/xhtml+xml' }
      });
      return await resp.text();
    } catch(e) {
      return null;
    }
  }, videoPath);

  if (!html) return null;

  // Parse m3u8|hex|hex|...|com pattern
  let idx = html.indexOf('m3u8|');
  if (idx === -1) {
    // Try page.goto fallback
    console.log('[Scrape] No m3u8 in evaluate, trying goto...');
    let ok = false;
    for (let i = 0; i < 8; i++) {
      try {
        await pg.goto('https://missav.ai/' + videoPath, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch(e) {}
      await pg.waitForTimeout(2000);
      const title = await pg.title();
      if (!isCfPage(title)) { ok = true; break; }
      await pg.waitForTimeout(2000);
    }
    if (!ok) return null;
    idx = (await pg.content()).indexOf('m3u8|');
    if (idx === -1) return null;
    const sec = (await pg.content()).substring(idx, idx + 300);
    const pts = sec.split('|');
    const hex = [];
    for (let i = 1; i < pts.length; i++) {
      if (pts[i] === 'com') break;
      if (/^[a-f0-9]+$/i.test(pts[i])) hex.push(pts[i]);
    }
    const uuid = hex.reverse().join('-');
    if (!uuid || uuid.length < 20) return null;

    const fullHtml = await pg.content();
    const ti = fullHtml.match(/og:title["'\s]+content=["']([^"']+)/);
    const ci = fullHtml.match(/og:image["'\s]+content=["']([^"']+)/);
    const title = ti ? ti[1].replace(/&amp;/g, '&') : code;

    // Get playlist
    const pt = await fetchPlaylist(uuid);
    if (!pt) return null;

    const streams = parsePlaylist(pt);
    if (!streams.length) return null;
    streams.sort((a, b) => b.bw - a.bw);
    const best = streams[0];
    const vm3u8 = 'https://surrit.com/' + uuid + '/' + best.url;
    const tsBase = vm3u8.substring(0, vm3u8.lastIndexOf('/'));

    return { code, title, cover: ci ? ci[1] : null, uuid, resolution: best.res, vm3u8, tsBase };
  }

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

  // Get playlist from surrit.com
  const pt = await fetchPlaylist(uuid);
  if (!pt) return null;

  const streams = parsePlaylist(pt);
  if (!streams.length) return null;
  streams.sort((a, b) => b.bw - a.bw);
  const best = streams[0];
  const vm3u8 = 'https://surrit.com/' + uuid + '/' + best.url;
  const tsBase = vm3u8.substring(0, vm3u8.lastIndexOf('/'));

  return { code, title, cover: ci ? ci[1] : null, uuid, resolution: best.res, vm3u8, tsBase };
}

async function fetchPlaylist(uuid) {
  try {
    const resp = await fetch('https://surrit.com/' + uuid + '/playlist.m3u8', {
      headers: { 'Referer': 'https://missav.ai/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (resp.ok) return await resp.text();
  } catch(e) {}
  return null;
}

function parsePlaylist(pt) {
  const streams = [];
  let cur = null;
  pt.split('\n').forEach(l => {
    if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const bw = parseInt((l.match(/BANDWIDTH=(\d+)/) || [, '0'])[1]);
      const res = (l.match(/RESOLUTION=(\d+x\d+)/) || [, '0x0'])[1];
      cur = { bw, res };
    } else if (cur && l.trim() && !l.startsWith('#')) {
      cur.url = l.trim();
      streams.push(cur);
      cur = null;
    }
  });
  return streams;
}

async function streamVideo(code, res) {
  let info = await scrapeJav(code);
  if (!info) { res.status(404).json({ error: 'Not found', code }); return; }

  const headers = { 'Referer': 'https://missav.ai/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
  let vt = null;
  try {
    const r = await fetch(info.vm3u8, { headers });
    if (r.ok) vt = await r.text();
  } catch(e) {}
  if (!vt) { res.status(502).json({ error: 'Cannot fetch manifest' }); return; }

  const segUrls = vt.split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => l.trim().startsWith('http') ? l.trim() : info.tsBase + '/' + l.trim());
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': 'inline; filename="' + info.code + '.mp4"'
  });

  for (let i = 0; i < segUrls.length; i++) {
    try {
      const r = await fetch(segUrls[i], { headers });
      if (r.ok) res.write(Buffer.from(await r.arrayBuffer()));
    } catch(e) {}
  }
  res.end();
  console.log('[Stream] Done', info.code);
}

// --- Express Server ---
const app = express();
app.get('/health', (req, res) => {
  res.json({ ok: true, browser: browserReady, proxy: proxyPool.getProxyStatus() });
});

app.get('/proxy', (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).json({ error: 'Missing code' });
  streamVideo(code, res).catch(e => {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });
});

app.get('/proxy-pool', (req, res) => {
  res.json(proxyPool.getProxyStatus());
});

// --- Telegram Bot ---
const bot = new TelegramBot(BOT_TOKEN, { polling: false });
setTimeout(() => {
  bot.startPolling().then(() => console.log('[Bot] Polling started')).catch(e => {
    console.error('[Bot] Polling fail:', e.message);
    setTimeout(() => {
      bot.startPolling().catch(e2 => console.error('[Bot] Retry fail:', e2.message));
    }, 10000);
  });
}, 3000);

bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id, '\u{1F3F0}JAV Bot\nSend JAV code, e.g.: SSIS-123');
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

    // If first attempt failed with page.evaluate, try restarting browser with a proxy
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
      // If browser was started with proxy, restart without proxy for next requests
      if (currentProxy) {
        currentProxy = null;
        initBrowser(null).catch(() => {});
      }
      return;
    }

    const url = PROXY_HOST + '/proxy?code=' + code;
    const cap = '\uD83D\uDCF2 ' + info.title + '\n\uD83D\uDCF1 ' + code + '\n\uD83D\uDCCD ' + info.resolution;
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
    try {
      await bot.editMessageText('Error: ' + e.message.substring(0, 100), { chat_id: cid, message_id: sm.message_id });
    } catch(e2) {}
  }
});

// --- Startup ---
app.listen(PORT, () => {
  console.log('[Server] on port ' + PORT);

  // Start proxy pool refresh
  proxyPool.refreshPool().then(() => {
    console.log('[Pool] Initial refresh complete');
  }).catch(e => console.error('[Pool] Refresh error:', e.message));
  setInterval(() => {
    proxyPool.refreshPool().catch(e => console.error('[Pool] Periodic refresh error:', e.message));
  }, 10 * 60 * 1000);

  // Init browser without proxy first
  initBrowser(null).then(ok => {
    if (!ok && proxyPool.getRandomProxy()) {
      const p = proxyPool.getRandomProxy();
      console.log('[Startup] Warmup failed, retrying with proxy:', p);
      currentProxy = p;
      initBrowser(p).catch(e => console.error('[Startup] Proxy init error:', e.message));
    }
    console.log('[Bot] Browser ready');
  }).catch(e => console.error('[FATAL] Browser init:', e.message));
});
