const { chromium } = require("playwright");
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

// ====== Config ======
const BOT_TOKEN = "8889310845:AAFtgz9vTlb8vrPG7m0aPnT0mjXLwCQx-fs";
const PORT = process.env.PORT || 3456;
// Railway provides RAILWAY_PUBLIC_DOMAIN; fallback for local dev
var PROXY_HOST = process.env.RAILWAY_PUBLIC_DOMAIN
  ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN
  : "http://localhost:" + PORT;

// ====== Browser Management ======
var browser, ctx, pg;
var browserReady = false;
var lastActivity = Date.now();
var SESSION_REFRESH_MS = 10 * 60 * 1000; // 10 min

async function initBrowser() {
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    ctx = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 }
    });
    pg = await ctx.newPage();
    await pg.goto("https://missav.ai", { waitUntil: "domcontentloaded", timeout: 30000 });
    await pg.waitForTimeout(2000);
    browserReady = true;
    lastActivity = Date.now();
    console.log("[OK] Browser initialized and warmed up");
  } catch(e) {
    console.error("[FATAL] Browser init failed:", e.message);
    throw e;
  }
}

// Refresh browser session periodically to avoid CF ban
async function ensureSession() {
  if (!browserReady) return;
  var now = Date.now();
  if (now - lastActivity > SESSION_REFRESH_MS) {
    console.log("[Session] Refreshing...");
    try {
      await pg.goto("https://missav.ai", { waitUntil: "domcontentloaded", timeout: 15000 });
      await pg.waitForTimeout(2000);
      console.log("[Session] Refreshed");
    } catch(e) {
      console.error("[Session] Refresh failed, re-creating browser");
      await closeBrowser();
      await initBrowser();
    }
  }
  lastActivity = now;
}

async function closeBrowser() {
  try {
    if (browser) await browser.close();
  } catch(e) {}
  browser = null; ctx = null; pg = null;
  browserReady = false;
}

// ====== Scraper ======
async function scrapeJav(code) {
  code = code.toUpperCase();
  await ensureSession();

  try {
    await pg.goto("https://missav.ai/" + code.toLowerCase(), { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch(e) {
    console.error("[Scrape] goto failed:", e.message);
    // Try once more with a new page
    try {
      pg = await ctx.newPage();
      await pg.goto("https://missav.ai/" + code.toLowerCase(), { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch(e2) {
      throw new Error("Cannot load page: " + e2.message);
    }
  }

  lastActivity = Date.now();
  var html = await pg.content();

  // Extract UUID using string search (avoids regex escaping issues)
  var idx = html.indexOf("m3u8|");
  if (idx === -1) {
    // Log page snippet for debugging
    var snippet = html.substring(0, 500);
    console.error("[Scrape] No m3u8| pattern found in page for", code);
    return null;
  }
  var section = html.substring(idx, idx + 200);
  var parts = section.split("|");
  // parts[0]="m3u8", parts[1:-5] = hex chunks, then ["com","surrit","https","video"]
  var hexParts = [];
  for (var i = 1; i < parts.length; i++) {
    if (parts[i] === "com") break;
    if (/^[a-f0-9]+$/i.test(parts[i])) hexParts.push(parts[i]);
  }
  var uuid = hexParts.reverse().join("-");
  if (!uuid || uuid.length < 20) {
    console.error("[Scrape] Invalid UUID for", code, ":", uuid);
    return null;
  }

  var titleMatch = html.match(/og:title"\s+content="([^"]+)"/);
  var coverMatch = html.match(/og:image"\s+content="([^"]+)"/);
  var title = titleMatch ? titleMatch[1] : code;
  var cover = coverMatch ? coverMatch[1] : null;

  // Fetch playlist via browser request API (has CF cookies)
  var ar = pg.request;
  var pResp = await ar.get("https://surrit.com/" + uuid + "/playlist.m3u8", {
    headers: { Referer: "https://missav.ai/" }
  });
  if (!pResp.ok()) {
    console.error("[Scrape] Playlist fetch failed:", pResp.status());
    return null;
  }
  var pt = await pResp.text();

  // Parse streams
  var streams = [];
  var cur = null;
  pt.split("\n").forEach(function(l) {
    if (l.startsWith("#EXT-X-STREAM-INF:")) {
      var bw = parseInt((l.match(/BANDWIDTH=(\d+)/) || [,"0"])[1]);
      var res = (l.match(/RESOLUTION=(\d+x\d+)/) || [,"0x0"])[1];
      cur = { bw: bw, res: res };
    } else if (cur && l.trim() && !l.startsWith("#")) {
      cur.url = l.trim();
      streams.push(cur);
      cur = null;
    }
  });
  if (!streams.length) {
    console.error("[Scrape] No streams found for", code);
    return null;
  }
  streams.sort(function(a,b){ return b.bw - a.bw; });
  var best = streams[0];
  var vm3u8 = "https://surrit.com/" + uuid + "/" + best.url;
  var tsBase = vm3u8.substring(0, vm3u8.lastIndexOf("/"));

  return {
    code: code,
    title: title,
    cover: cover,
    uuid: uuid,
    resolution: best.res,
    vm3u8: vm3u8,
    tsBase: tsBase
  };
}

// ====== Stream Proxy ======
async function streamVideo(code, res) {
  var info = await scrapeJav(code);
  if (!info) {
    res.status(404).json({ error: "Not found", code: code });
    return;
  }
  console.log("[Stream]", info.code, info.resolution);

  var ar = pg.request;
  var vResp = await ar.get(info.vm3u8, {
    headers: { Referer: "https://missav.ai/" }
  });
  if (!vResp.ok()) {
    res.status(502).json({ error: "Cannot fetch manifest" });
    return;
  }
  var vt = await vResp.text();

  var segUrls = vt.split("\n")
    .filter(function(l){ return l.trim() && !l.startsWith("#"); })
    .map(function(l){ return l.trim().startsWith("http") ? l.trim() : info.tsBase + "/" + l.trim(); });

  res.writeHead(200, {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Content-Disposition": "inline; filename=\"" + info.code + ".mp4\""
  });

  for (var i = 0; i < segUrls.length; i++) {
    try {
      var sResp = await ar.get(segUrls[i], {
        headers: { Referer: "https://missav.ai/" }
      });
      if (sResp.ok()) {
        res.write(await sResp.body());
      } else {
        console.log("[Stream] Segment failed:", i, sResp.status());
      }
    } catch(e) {
      console.log("[Stream] Segment error:", i, e.message);
    }
  }
  res.end();
  console.log("[Stream] Done", info.code);
}

// ====== Express Server ======
var app = express();

app.get("/health", function(req, res) {
  res.json({ ok: true, browser: browserReady });
});

app.get("/proxy", function(req, res) {
  var code = req.query.code;
  if (!code) return res.status(400).json({ error: "Missing code" });
  streamVideo(code, res).catch(function(e) {
    console.error("[Proxy]", e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });
});

// ====== Telegram Bot ======
// Start with a delay to avoid 409 conflict from previous instance
var bot = new TelegramBot(BOT_TOKEN, { polling: false });
setTimeout(function() {
  bot.startPolling().then(function() {
    console.log("[Bot] Polling started");
  }).catch(function(e) {
    console.error("[Bot] Polling start failed:", e.message);
    // Retry after 10 seconds
    setTimeout(function() {
      bot.startPolling().then(function() {
        console.log("[Bot] Polling started (retry)");
      }).catch(function(e2) {
        console.error("[Bot] Polling retry failed:", e2.message);
      });
    }, 10000);
  });
}, 3000);
console.log("[Bot] Will start polling in 3 seconds");

bot.onText(/\/start/, function(msg) {
  bot.sendMessage(msg.chat.id, "馃幀 JAV Bot\nSend JAV code to search, e.g.: SSIS-123");
});

bot.on("message", async function(msg) {
  if (!msg.text || msg.text.startsWith("/")) return;
  if (!browserReady) {
    bot.sendMessage(msg.chat.id, "鈴?Bot is starting up, please wait...");
    return;
  }
  var code = msg.text.trim().toUpperCase();
  if (!/[A-Z]+-\d+/.test(code)) return;

  var cid = msg.chat.id;
  var sm = await bot.sendMessage(cid, "馃攳 Searching " + code + "...");
  try {
    var info = await scrapeJav(code);
    if (!info) {
      bot.editMessageText("鉂?Not found: " + code, { chat_id: cid, message_id: sm.message_id });
      return;
    }
    var url = PROXY_HOST + "/proxy?code=" + code;
    var cap = "馃幀 " + info.title + "\n馃搶 " + code + "\n馃帴 " + info.resolution;
    await bot.deleteMessage(cid, sm.message_id);
    try {
      await bot.sendVideo(cid, url, { caption: cap, supports_streaming: true });
    } catch(e) {
      console.log("[Bot] SendVideo fail:", e.message);
      var kb = { reply_markup: { inline_keyboard: [[{ text: "鈻讹笍 Play", url: url }]] } };
      if (info.cover) {
        await bot.sendPhoto(cid, info.cover, Object.assign({ caption: cap + "\n\n" + url }, kb));
      } else {
        await bot.sendMessage(cid, cap + "\n\n" + url, kb);
      }
    }
  } catch(e) {
    console.error("[Bot] Error:", e.message);
    bot.editMessageText("鉂?" + e.message.substring(0, 100), { chat_id: cid, message_id: sm.message_id });
  }
});

// ====== Start ======
async function main() {
  await initBrowser();
  app.listen(PORT, function() {
    console.log("[Server] Proxy on port " + PORT);
    console.log("[Server] Proxy URL: " + PROXY_HOST + "/proxy?code=SSIS-123");
  });
}

main().catch(function(e) {
  console.error("[FATAL]", e);
  process.exit(1);
});
