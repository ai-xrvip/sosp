const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { spawn } = require("child_process");
const path = require("path");

const BOT_TOKEN = "8889310845:AAFtgz9vTlb8vrPG7m0aPnT0mjXLwCQx-fs";
const PORT = process.env.PORT || 3456;
var PROXY_HOST = process.env.RAILWAY_PUBLIC_DOMAIN
  ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN
  : "http://localhost:" + PORT;

var PYTHON = "python3";
var SCRAPER = path.join(__dirname, "scrape_jav.py");

async function scrapeJav(code) {
  return new Promise(function(resolve) {
    var child = spawn(PYTHON, [SCRAPER, code.toUpperCase()], {
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    var output = "", error = "";
    child.stdout.on("data", function(d) { output += d.toString(); });
    child.stderr.on("data", function(d) { error += d.toString(); });
    child.on("close", function(exitCode) {
      if (exitCode !== 0) {
        console.log("[Scrape] Python exit", exitCode, error.substring(0, 200));
        resolve(null); return;
      }
      try {
        var result = JSON.parse(output.trim());
        if (result.error) { console.log("[Scrape] Error:", result.error); resolve(null); }
        else { console.log("[Scrape] OK:", result.code, result.resolution); resolve(result); }
      } catch(e) {
        console.log("[Scrape] Parse fail:", e.message);
        resolve(null);
      }
    });
    child.on("error", function(e) { console.log("[Scrape] Spawn error:", e.message); resolve(null); });
  });
}

async function streamVideo(code, res) {
  var info = await scrapeJav(code);
  if (!info) { res.status(404).json({ error: "Not found", code: code }); return; }

  var headers = {
    "Referer": "https://missav.ai/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
  };

  var vt = null;
  try { var r = await fetch(info.vm3u8, { headers: headers }); if (r.ok) vt = await r.text(); } catch(e) {}

  if (!vt) { res.status(502).json({ error: "Cannot fetch manifest" }); return; }

  var segUrls = vt.split("\n")
    .filter(function(l){ return l.trim() && !l.startsWith("#"); })
    .map(function(l){ return l.trim().startsWith("http") ? l.trim() : info.tsBase + "/" + l.trim(); });

  console.log("[Stream]", info.code, "-", segUrls.length, "segments");
  res.writeHead(200, {
    "Content-Type": "video/mp4", "Accept-Ranges": "bytes",
    "Content-Disposition": "inline; filename=\"" + info.code + ".mp4\""
  });

  for (var i = 0; i < segUrls.length; i++) {
    try {
      var r = await fetch(segUrls[i], { headers: headers });
      if (r.ok) res.write(Buffer.from(await r.arrayBuffer()));
      else console.log("[Stream] Segment", i, "HTTP", r.status);
    } catch(e) { console.log("[Stream] Segment", i, "error:", e.message); }
  }
  res.end();
  console.log("[Stream] Done", info.code);
}

var app = express();
app.get("/health", function(req, res) { res.json({ ok: true }); });
app.get("/proxy", function(req, res) {
  var code = req.query.code;
  if (!code) return res.status(400).json({ error: "Missing code" });
  streamVideo(code, res).catch(function(e) {
    console.error("[Proxy]", e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });
});

var bot = new TelegramBot(BOT_TOKEN, { polling: false });
setTimeout(function() {
  bot.startPolling().then(function() { console.log("[Bot] Polling started"); })
  .catch(function(e) {
    console.error("[Bot] Polling fail:", e.message);
    setTimeout(function() {
      bot.startPolling().then(function() { console.log("[Bot] Polling started (retry)"); })
      .catch(function(e2) { console.error("[Bot] Polling retry fail:", e2.message); });
    }, 10000);
  });
}, 3000);

bot.onText(/\/start/, function(msg) {
  bot.sendMessage(msg.chat.id, "\uD83C\uDFB2 JAV Bot\nSend JAV code, e.g.: SSIS-123");
});
bot.on("message", async function(msg) {
  if (!msg.text || msg.text.startsWith("/")) return;
  var code = msg.text.trim().toUpperCase();
  if (!/[A-Z]+-\d+/.test(code)) return;
  var cid = msg.chat.id;
  var sm = await bot.sendMessage(cid, "\uD83D\uDD0D " + code + "...");
  try {
    var info = await scrapeJav(code);
    if (!info) { bot.editMessageText("\u26A0\uFE0F Not found: " + code, { chat_id: cid, message_id: sm.message_id }); return; }
    var url = PROXY_HOST + "/proxy?code=" + code;
    var cap = "\uD83C\uDFB2 " + info.title + "\n\uD83D\uDCCB " + code + "\n\uD83C\uDFB4 " + info.resolution;
    await bot.deleteMessage(cid, sm.message_id);
    try { await bot.sendVideo(cid, url, { caption: cap, supports_streaming: true }); }
    catch(e) {
      console.log("[Bot] SendVideo fail:", e.message);
      var kb = { reply_markup: { inline_keyboard: [[{ text: "\u25B6\uFE0F Play", url: url }]] } };
      if (info.cover) await bot.sendPhoto(cid, info.cover, Object.assign({ caption: cap + "\n\n" + url }, kb));
      else await bot.sendMessage(cid, cap + "\n\n" + url, kb);
    }
  } catch(e) {
    console.error("[Bot] Error:", e.message);
    bot.editMessageText("\u26A0 " + e.message.substring(0, 100), { chat_id: cid, message_id: sm.message_id });
  }
});

app.listen(PORT, function() { console.log("[Server] on port " + PORT); });
console.log("[Bot] Will start polling in 3 seconds");
