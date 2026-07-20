const { chromium } = require("playwright");
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

const BOT_TOKEN = "8889310845:AAFtgz9vTlb8vrPG7m0aPnT0mjXLwCQx-fs";
const PORT = process.env.PORT || 3456;
var PROXY_HOST = process.env.RAILWAY_PUBLIC_DOMAIN
  ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN
  : "http://localhost:" + PORT;

var browser, ctx, pg;
var browserReady = false;

function isCfPage(title, content) {
  var c = (title + " " + content).toLowerCase();
  return c.indexOf("just a moment") !== -1
    || c.indexOf("please wait") !== -1
    || c.indexOf("attention required") !== -1
    || c.indexOf("challenge") !== -1
    || c.indexOf("cf-browser-verification") !== -1;
}

async function pageHasContent(page) {
  var title = await page.title();
  var content = await page.content();
  var hasM3u8 = content.indexOf("m3u8|") !== -1;
  var isCf = isCfPage(title, content);
  return { ok: hasM3u8 || (!isCf && content.indexOf("missav") !== -1), isCf: isCf, title: title };
}

async function loadWithCfRetry(url) {
  for (var i = 0; i < 10; i++) {
    try {
      await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    } catch(e) {}
    await pg.waitForTimeout(2000);
    var s = await pageHasContent(pg);
    if (s.ok) {
      console.log("[Nav] OK:", s.title);
      return true;
    }
    if (!s.isCf) {
      // Might be a different error page
      console.log("[Nav] Not CF, not content:", s.title);
      if (i > 2) return false;
    }
    console.log("[Nav] CF:", s.title, "retry", i+1);
    await pg.waitForTimeout(2000);
  }
  console.log("[Nav] Failed after 10 retries");
  return false;
}

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
    console.log("[Browser] Warming up...");
    var ok = await loadWithCfRetry("https://missav.ai");
    browserReady = true;
    console.log("[OK] Browser ready. CF bypass:", ok);
  } catch(e) {
    console.error("[FATAL]", e.message);
    throw e;
  }
}

async function scrapeJav(code) {
  code = code.toUpperCase();
  var ok = await loadWithCfRetry("https://missav.ai/" + code.toLowerCase());
  if (!ok) return null;

  var html = await pg.content();
  var idx = html.indexOf("m3u8|");
  if (idx === -1) return null;

  var sec = html.substring(idx, idx + 300);
  var pts = sec.split("|");
  var hex = [];
  for (var i = 1; i < pts.length; i++) {
    if (pts[i] === "com") break;
    if (/^[a-f0-9]+$/i.test(pts[i])) hex.push(pts[i]);
  }
  var uuid = hex.reverse().join("-");
  if (!uuid || uuid.length < 20) return null;

  var ti = html.match(/og:title["'\s]+content=["']([^"']+)/);
  var ci = html.match(/og:image["'\s]+content=["']([^"']+)/);
  var title = ti ? ti[1].replace(/&amp;/g, "&") : code;

  // Get playlist
  var pt = null;
  try {
    await pg.goto("https://surrit.com/" + uuid + "/playlist.m3u8", { waitUntil: "domcontentloaded", timeout: 15000 });
    await pg.waitForTimeout(2000);
    pt = await pg.evaluate(function(){ return document.body ? document.body.innerText : ""; });
  } catch(e) {}

  if (!pt || pt.indexOf("#EXTM3U") === -1) {
    try {
      var ar = pg.request;
      var pResp = await ar.get("https://surrit.com/" + uuid + "/playlist.m3u8", { headers: { Referer: "https://missav.ai/" } });
      if (pResp.ok()) pt = await pResp.text();
    } catch(e) {}
  }

  if (!pt || pt.indexOf("#EXTM3U") === -1) return null;

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

  return { code: code, title: title, cover: ci ? ci[1] : null, uuid: uuid, resolution: best.res, vm3u8: vm3u8, tsBase: tsBase };
}

async function streamVideo(code, res) {
  var info = await scrapeJav(code);
  if (!info) { res.status(404).json({ error: "Not found", code: code }); return; }

  var headers = { "Referer": "https://missav.ai/", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };
  var vt = null;
  try { var r = await fetch(info.vm3u8, { headers: headers }); if (r.ok) vt = await r.text(); } catch(e) {}
  if (!vt) { res.status(502).json({ error: "Cannot fetch manifest" }); return; }

  var segUrls = vt.split("\n").filter(function(l){ return l.trim() && !l.startsWith("#"); }).map(function(l){ return l.trim().startsWith("http") ? l.trim() : info.tsBase + "/" + l.trim(); });
  res.writeHead(200, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Disposition": "inline; filename=\"" + info.code + ".mp4\"" });

  for (var i = 0; i < segUrls.length; i++) {
    try { var r = await fetch(segUrls[i], { headers: headers }); if (r.ok) res.write(Buffer.from(await r.arrayBuffer())); } catch(e) {}
  }
  res.end();
  console.log("[Stream] Done", info.code);
}

var app = express();
app.get("/health", function(req, res) { res.json({ ok: true, browser: browserReady }); });
app.get("/proxy", function(req, res) {
  var code = req.query.code;
  if (!code) return res.status(400).json({ error: "Missing code" });
  streamVideo(code, res).catch(function(e) { if (!res.headersSent) res.status(500).json({ error: e.message }); });
});

var bot = new TelegramBot(BOT_TOKEN, { polling: false });
setTimeout(function() {
  bot.startPolling().then(function() { console.log("[Bot] Polling started"); }).catch(function(e) {
    console.error("[Bot] Polling fail:", e.message);
    setTimeout(function() { bot.startPolling().catch(function(e2) { console.error("[Bot] Retry fail:", e2.message); }); }, 10000);
  });
}, 3000);

bot.onText(/\/start/, function(msg) { bot.sendMessage(msg.chat.id, "🎲 JAV Bot\nSend JAV code, e.g.: SSIS-123"); });
bot.on("message", async function(msg) {
  if (!msg.text || msg.text.startsWith("/")) return;
  if (!browserReady) { bot.sendMessage(msg.chat.id, "⏳ Starting..."); return; }
  var code = msg.text.trim().toUpperCase();
  if (!/[A-Z]+-\d+/.test(code)) return;
  var cid = msg.chat.id;
  var sm = await bot.sendMessage(cid, "🔍 " + code + "...");
  try {
    var info = await scrapeJav(code);
    if (!info) { bot.editMessageText("Not found: " + code, { chat_id: cid, message_id: sm.message_id }); return; }
    var url = PROXY_HOST + "/proxy?code=" + code;
    var cap = "🎲 " + info.title + "\n📋 " + code + "\n🎴 " + info.resolution;
    await bot.deleteMessage(cid, sm.message_id);
    try { await bot.sendVideo(cid, url, { caption: cap, supports_streaming: true }); }
    catch(e) {
      var kb = { reply_markup: { inline_keyboard: [[{ text: "▶ Play", url: url }]] } };
      if (info.cover) await bot.sendPhoto(cid, info.cover, Object.assign({ caption: cap + "\n\n" + url }, kb));
      else await bot.sendMessage(cid, cap + "\n\n" + url, kb);
    }
  } catch(e) { bot.editMessageText("Error: " + e.message.substring(0, 100), { chat_id: cid, message_id: sm.message_id }); }
});

async function main() {
  await initBrowser();
  app.listen(PORT, function() { console.log("[Server] on port " + PORT); });
}
main().catch(function(e) { console.error("[FATAL]", e); process.exit(1); });
