const { chromium } = require("playwright");
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

// ====== Config ======
const BOT_TOKEN = "8889310845:AAFtgz9vTlb8vrPG7m0aPnT0mjXLwCQx-fs";
const PORT = process.env.PORT || 3456;
var PROXY_HOST = process.env.RAILWAY_PUBLIC_DOMAIN
  ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN
  : "http://localhost:" + PORT;

// ====== Browser Management ======
var browser, ctx, pg;
var browserReady = false;

async function isCfBlocked(page) {
  var ct = (await page.content()).toLowerCase();
  return ct.indexOf("just a moment") !== -1
    || ct.indexOf("cloudflare") !== -1
    || ct.indexOf("attention required") !== -1
    || ct.indexOf("please wait") !== -1
    || ct.indexOf("challenge-form") !== -1
    || ct.indexOf("cf-browser-verification") !== -1
    || ct.indexOf("しばらくお待ちください") !== -1;
}

async function navigateWithCfRetry(url, maxWaitMs) {
  var start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await pg.waitForTimeout(2000);
      if (!(await isCfBlocked(pg))) {
        var t = await pg.title();
        console.log("[Nav] OK - Title:", t);
        return true;
      }
      console.log("[Nav] CF block, waiting...");
      await pg.waitForTimeout(3000);
    } catch(e) {
      console.log("[Nav] Error:", e.message);
      await pg.waitForTimeout(2000);
    }
  }
  return false;
}

async function initBrowser() {
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });
    ctx = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
      locale: "ja-JP"
    });
    pg = await ctx.newPage();

    console.log("[Browser] Warming up on missav.ai...");
    var ok = await navigateWithCfRetry("https://missav.ai", 60000);
    if (!ok) {
      // Try surrit.com first, then back to missav
      console.log("[Browser] First try failed, trying surrit.com...");
      await pg.goto("https://surrit.com", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(function(){});
      await pg.waitForTimeout(3000);
      ok = await navigateWithCfRetry("https://missav.ai", 30000);
    }

    browserReady = true;
    console.log("[OK] Browser initialized and warmed up. CF bypass:", ok);
  } catch(e) {
    console.error("[FATAL] Browser init failed:", e.message);
    throw e;
  }
}

async function scrapeJav(code) {
  code = code.toUpperCase();

  // Navigate to video page with CF retry
  var ok = await navigateWithCfRetry("https://missav.ai/" + code.toLowerCase(), 60000);
  if (!ok) {
    console.log("[Scrape] Could not bypass CF for", code);
    return null;
  }

  var html = await pg.content();
  if (html.indexOf("m3u8|") === -1) {
    console.log("[Scrape] No m3u8| pattern found for", code);
    return null;
  }

  // Extract UUID
  var idx = html.indexOf("m3u8|");
  var section = html.substring(idx, idx + 300);
  var parts = section.split("|");
  var hexParts = [];
  for (var i = 1; i < parts.length; i++) {
    if (parts[i] === "com") break;
    if (/^[a-f0-9]+$/i.test(parts[i])) hexParts.push(parts[i]);
  }
  var uuid = hexParts.reverse().join("-");
  if (!uuid || uuid.length < 20) {
    console.log("[Scrape] Invalid UUID:", uuid);
    return null;
  }

  var titleMatch = html.match(/og:title["'\s]+content=["']([^"']+)/);
  var coverMatch = html.match(/og:image["'\s]+content=["']([^"']+)/);
  var title = titleMatch ? titleMatch[1].replace(/&amp;/g, "&") : code;

  // Export cookies for TS segment fetching
  var cookies = await ctx.cookies();
  var surritCookies = cookies.filter(function(c){ return c.domain.indexOf("surrit") !== -1; });
  var cookieHeader = surritCookies.map(function(c){ return c.name + "=" + c.value; }).join("; ");
  console.log("[Scrape] surrit.com cookies:", surritCookies.length);

  // Fetch playlist m3u8 - navigate to it
  var pt = null;
  ok = await navigateWithCfRetry("https://surrit.com/" + uuid + "/playlist.m3u8", 30000);
  if (ok) {
    var bodyText = await pg.evaluate(function(){ return document.body ? document.body.innerText : ""; });
    if (bodyText && bodyText.indexOf("#EXTM3U") !== -1) pt = bodyText;
  }

  // Fallback: API fetch
  if (!pt) {
    console.log("[Scrape] Trying API playlist fetch...");
    try {
      var ar = pg.request;
      var pResp = await ar.get("https://surrit.com/" + uuid + "/playlist.m3u8", {
        headers: { Referer: "https://missav.ai/" }
      });
      if (pResp.ok()) pt = await pResp.text();
    } catch(e) {
      console.log("[Scrape] API playlist fetch failed:", e.message);
    }
  }

  if (!pt || pt.indexOf("#EXTM3U") === -1) {
    console.log("[Scrape] No valid playlist");
    return null;
  }

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
  if (!streams.length) return null;
  streams.sort(function(a,b){ return b.bw - a.bw; });
  var best = streams[0];
  var vm3u8 = "https://surrit.com/" + uuid + "/" + best.url;
  var tsBase = vm3u8.substring(0, vm3u8.lastIndexOf("/"));

  return {
    code: code, title: title,
    cover: coverMatch ? coverMatch[1] : null,
    uuid: uuid, resolution: best.res,
    vm3u8: vm3u8, tsBase: tsBase,
    cookieHeader: cookieHeader
  };
}

async function streamVideo(code, res) {
  var info = await scrapeJav(code);
  if (!info) {
    res.status(404).json({ error: "Not found", code: code });
    return;
  }
  console.log("[Stream]", info.code, info.resolution);

  var headers = {
    "Referer": "https://missav.ai/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
  };
  if (info.cookieHeader) headers["Cookie"] = info.cookieHeader;

  // Fetch variant m3u8
  var vt = null;
  try {
    var vResp = await fetch(info.vm3u8, { headers: headers });
    if (vResp.ok) vt = await vResp.text();
  } catch(e) {}

  if (!vt) {
    try {
      var ar = pg.request;
      var pr = await ar.get(info.vm3u8, { headers: headers });
      if (pr.ok()) vt = await pr.text();
    } catch(e) {}
  }

  if (!vt) {
    res.status(502).json({ error: "Cannot fetch manifest" });
    return;
  }

  var segUrls = vt.split("\n")
    .filter(function(l){ return l.trim() && !l.startsWith("#"); })
    .map(function(l){ return l.trim().startsWith("http") ? l.trim() : info.tsBase + "/" + l.trim(); });

  res.writeHead(200, {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Content-Disposition": "inline; filename=\"" + info.code + ".mp4\""
  });

  var ar2 = pg.request;
  for (var i = 0; i < segUrls.length; i++) {
    var buf = null;
    try {
      var resp = await fetch(segUrls[i], { headers: headers });
      if (resp.ok) buf = Buffer.from(await resp.arrayBuffer());
    } catch(e) {}
    if (!buf) {
      try {
        var pr2 = await ar2.get(segUrls[i], { headers: headers });
        if (pr2.ok()) buf = await pr2.body();
      } catch(e) {}
    }
    if (buf) {
      res.write(buf);
    } else {
      console.log("[Stream] Segment failed:", i);
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
var bot = new TelegramBot(BOT_TOKEN, { polling: false });
setTimeout(function() {
  bot.startPolling().then(function() {
    console.log("[Bot] Polling started");
  }).catch(function(e) {
    console.error("[Bot] Polling start failed:", e.message);
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
  bot.sendMessage(msg.chat.id, "🎲 JAV Bot\nSend JAV code to search, e.g.: SSIS-123");
});

bot.on("message", async function(msg) {
  if (!msg.text || msg.text.startsWith("/")) return;
  if (!browserReady) {
    bot.sendMessage(msg.chat.id, "⏳ Bot is starting up, please wait...");
    return;
  }
  var code = msg.text.trim().toUpperCase();
  if (!/[A-Z]+-\d+/.test(code)) return;

  var cid = msg.chat.id;
  var sm = await bot.sendMessage(cid, "🔍 Searching " + code + "...");
  try {
    var info = await scrapeJav(code);
    if (!info) {
      bot.editMessageText("⚠️ Not found: " + code, { chat_id: cid, message_id: sm.message_id });
      return;
    }
    var url = PROXY_HOST + "/proxy?code=" + code;
    var cap = "🎲 " + info.title + "\n📋 " + code + "\n🎴 " + info.resolution;
    await bot.deleteMessage(cid, sm.message_id);
    try {
      await bot.sendVideo(cid, url, { caption: cap, supports_streaming: true });
    } catch(e) {
      console.log("[Bot] SendVideo fail:", e.message);
      var kb = { reply_markup: { inline_keyboard: [[{ text: "▶️ Play", url: url }]] } };
      if (info.cover) {
        await bot.sendPhoto(cid, info.cover, Object.assign({ caption: cap + "\n\n" + url }, kb));
      } else {
        await bot.sendMessage(cid, cap + "\n\n" + url, kb);
      }
    }
  } catch(e) {
    console.error("[Bot] Error:", e.message);
    bot.editMessageText("⚠️ " + e.message.substring(0, 100), { chat_id: cid, message_id: sm.message_id });
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
