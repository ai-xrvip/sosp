const fs = require('fs');
const p = 'C:/Users/13249/Documents/Codex/2026-07-20/syngnat-missav-bot-https-github-com/work/sosp/index.cjs';
let c = fs.readFileSync(p, 'utf8');

// Insert after the proxyPool require line
const insertAfter = "const proxyPool = require('./proxyPool.cjs');";
const toInsert = [
  "const { execFileSync } = require('child_process');",
  "const PYTHON = process.platform === 'win32'",
  "  ? 'C:\\\\Users\\\\13249\\\\AppData\\\\Local\\\\Programs\\\\Python\\\\Python312\\\\python.exe'",
  "  : 'python3';",
  "const SCRAPER = __dirname + '/missav_scraper.py';",
  "",
  "function scrapeWithPython(code) {",
  "  try {",
  "    const stdout = execFileSync(PYTHON, [SCRAPER, code], {",
  "      timeout: 30000,",
  "      encoding: 'utf8',",
  "      env: Object.assign({}, process.env)",
  "    });",
  "    const data = JSON.parse(stdout);",
  "    if (data.error) {",
  "      console.log('[PyScraper] Error:', data.error);",
  "      return null;",
  "    }",
  "    if (data.m3u8_url) {",
  "      console.log('[PyScraper]', code, '->', data.method, '(' + data.mirror + ')', data.m3u8_url.substring(0, 60));",
  "      return data;",
  "    }",
  "    return null;",
  "  } catch(e) {",
  "    console.log('[PyScraper] Exception:', e.message.substring(0, 80));",
  "    return null;",
  "  }",
  "}",
  ""
].join('\\\\n');

c = c.replace(insertAfter, insertAfter + '\\\\n' + toInsert);

// Now update the scrapeJav function to try Python first
// Find the scrapeJav function and insert Python check at the beginning
const scrapeStart = "async function scrapeJav(code) {";
const pyCheckStart = [
  "async function scrapeJav(code) {",
  "  // Try Python cloudscraper first (bypasses CF)",
  "  const pyResult = scrapeWithPython(code);",
  "  if (pyResult && pyResult.m3u8_url) {",
  "    return {",
  "      code: pyResult.code || code,",
  "      title: pyResult.title || code,",
  "      cover: pyResult.cover || null,",
  "      m3u8_url: pyResult.m3u8_url,",
  "      resolution: pyResult.resolution || 'unknown',",
  "      uuid: pyResult.uuid || '',",
  "      _source: 'python'",
  "    };",
  "  }",
  "  console.log('[Scrape] Python failed, falling back to Playwright...');",
  ""
].join('\\\\n');

c = c.replace(scrapeStart, pyCheckStart);

// Update the streamVideo function to handle m3u8_url directly
const streamFuncStart = "async function streamVideo(code, res) {";
const streamReplacement = [
  "async function streamVideo(code, res) {",
  "  let info = await scrapeJav(code);",
  "  if (!info) { res.status(404).json({ error: 'Not found', code }); return; }",
  "",
  "  let vm3u8 = info.m3u8_url || '';",
  "  let tsBase = '';",
  "",
  "  // If we only have the playlist URL, get best stream from it",
  "  if (info.uuid && !vm3u8.includes('/playlist.m3u8')) {",
  "    vm3u8 = 'https://surrit.com/' + info.uuid + '/playlist.m3u8';",
  "  }",
  "",
  "  // Fetch the actual variant m3u8 from the playlist",
  "  const headers = { 'Referer': 'https://missav.ai/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };",
  "  let vt = null;",
  "  try {",
  "    const r = await fetch(vm3u8, { headers, signal: AbortSignal.timeout(10000) });",
  "    if (r.ok) vt = await r.text();",
  "  } catch(e) {}",
  "",
  "  if (!vt || vt.indexOf('#EXTM3U') === -1) {",
  "    // Try getting the full playlist URL from the variant",
  "    if (vm3u8.includes('/playlist.m3u8')) {",
  "      const base = vm3u8.substring(0, vm3u8.lastIndexOf('/'));",
  "      try {",
  "        const r = await fetch(vm3u8, { headers, signal: AbortSignal.timeout(10000) });",
  "        if (r.ok) {",
  "          vt = await r.text();",
  "          if (vt.indexOf('#EXTM3U') !== -1) {",
  "            // Parse variant streams",
  "            const streams = [];",
  "            let cur = null;",
  "            vt.split('\\\\n').forEach(l => {",
  "              if (l.startsWith('#EXT-X-STREAM-INF:')) {",
  "                const bw = parseInt((l.match(/BANDWIDTH=(\\\\d+)/) || [,'0'])[1]);",
  "                const res = (l.match(/RESOLUTION=(\\\\d+x\\\\d+)/) || [,'0x0'])[1];",
  "                cur = { bw, res };",
  "              } else if (cur && l.trim() && !l.startsWith('#')) {",
  "                cur.url = l.trim();",
  "                streams.push(cur);",
  "                cur = null;",
  "              }",
  "            });",
  "            if (streams.length) {",
  "              streams.sort((a,b) => b.bw - a.bw);",
  "              const best = streams[0];",
  "              vm3u8 = base + '/' + best.url;",
  "              info.resolution = best.res;",
  "              tsBase = base;",
  "            }",
  "          }",
  "        }",
  "      } catch(e) {}",
  "    }",
  "  }",
  "",
  "  // If we got a variant playlist, extract TS segment URLs",
  "  if (vt && vt.indexOf('#EXTM3U') !== -1) {",
  "    const segUrls = vt.split('\\\\n').filter(l => l.trim() && !l.startsWith('#')).map(l => l.trim().startsWith('http') ? l.trim() : (tsBase || (vm3u8.substring(0, vm3u8.lastIndexOf('/')))) + '/' + l.trim());",
  "",
  "    if (segUrls.length > 0) {",
  "      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Disposition': 'inline; filename=\"' + info.code + '.mp4\"' });",
  "      for (let i = 0; i < segUrls.length; i++) {",
  "        try {",
  "          const r = await fetch(segUrls[i], { headers, signal: AbortSignal.timeout(15000) });",
  "          if (r.ok) res.write(Buffer.from(await r.arrayBuffer()));",
  "        } catch(e) {}",
  "      }",
  "      res.end();",
  "      console.log('[Stream] Done', info.code);",
  "      return;",
  "    }",
  "  }",
  "",
  "  // Fallback: send play link as message",
  "  res.status(502).json({ error: 'Cannot fetch stream', code: info.code, m3u8: vm3u8 });",
  "}"
].join('\\\\n');

c = c.replace(streamFuncStart, streamReplacement);

// Update the bot message handler to show m3u8 URL when streaming fails
const botMsgSend = c.indexOf('await bot.sendVideo(cid, url, { caption: cap, supports_streaming: true });');
if (botMsgSend > -1) {
  // Already updated, skip
}

// Remove the old getBestStream and parseMissavPage functions if they're unused
// Actually let's keep them for backward compatibility

fs.writeFileSync(p, c, 'utf8');
console.log('index.cjs updated successfully');
