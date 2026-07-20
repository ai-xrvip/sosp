// Proxy pool: scrape, test against missav.ai, rotate
const https = require('https');
const http = require('http');
const { SocksProxyAgent } = require('socks-proxy-agent');

const PROXY_SOURCES = [
  "https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=5000&country=all&ssl=all",
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
  "https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt",
  "https://raw.githubusercontent.com/ngosang/proxy-lists/master/proxy-lists/http.txt",
  "https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/http.txt",
  "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt",
  "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt",
  "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt"
];

const SOCKS_SOURCES = [
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
  "https://raw.githubusercontent.com/ngosang/proxy-lists/master/proxy-lists/socks5.txt",
  "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt"
];

let proxyPool = [];
let lastRefresh = 0;
let poolInUse = [];
const REFRESH_INTERVAL = 10 * 60 * 1000;
const MAX_PROXIES = 50;

function timeoutSignal(ms) {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

async function fetchProxies(url) {
  try {
    const resp = await fetch(url, { signal: timeoutSignal(10000) });
    if (!resp.ok) return [];
    const text = await resp.text();
    return text.split("\n").map(l => l.trim()).filter(l => l && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l));
  } catch(e) { return []; }
}

// Test HTTP/HTTPS proxy via CONNECT tunnel + TLS
function testHttpProxy(proxy) {
  return new Promise(resolve => {
    const [host, port] = proxy.split(':');
    const pNum = parseInt(port);
    const start = Date.now();

    const req = http.request({
      hostname: host,
      port: pNum,
      method: 'CONNECT',
      path: 'missav.ai:443',
      timeout: 8000,
      headers: { Host: 'missav.ai:443' }
    });

    req.on('connect', (res, socket) => {
      const tls = require('tls');
      const tlsSocket = tls.connect({
        socket: socket,
        servername: 'missav.ai',
        host: 'missav.ai',
        port: 443,
        rejectUnauthorized: false
      }, () => {
        tlsSocket.write('GET / HTTP/1.1\r\nHost: missav.ai\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\nConnection: close\r\n\r\n');
        let data = '';
        tlsSocket.on('data', chunk => { data += chunk.toString(); });
        tlsSocket.on('end', () => {
          const latency = Date.now() - start;
          if ((data.includes('missav') || data.includes('MissAV')) && !data.includes('Just a moment') && !data.includes('cf-browser-verification')) {
            resolve({ proxy, latency, time: Date.now() });
          } else {
            resolve(null);
          }
        });
        tlsSocket.on('error', () => resolve(null));
      });
      tlsSocket.on('error', () => resolve(null));
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.setTimeout(8000);
    req.end();
  });
}

// Test SOCKS5 proxy
async function testSocksProxy(proxy) {
  try {
    const agent = new SocksProxyAgent('socks5://' + proxy);
    const start = Date.now();
    const resp = await fetch('https://missav.ai', {
      agent,
      signal: timeoutSignal(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const text = await resp.text();
    const latency = Date.now() - start;
    if ((text.includes('missav') || text.includes('MissAV')) && !text.includes('Just a moment') && !text.includes('cf-browser-verification')) {
      return { proxy, latency, time: Date.now() };
    }
  } catch(e) {}
  return null;
}

async function refreshPool() {
  console.log('[Pool] Refreshing proxy pool...');

  const httpResults = await Promise.allSettled(PROXY_SOURCES.map(url => fetchProxies(url)));
  let allHttp = [];
  httpResults.forEach(r => { if (r.status === 'fulfilled') allHttp = allHttp.concat(r.value); });

  const socksResults = await Promise.allSettled(SOCKS_SOURCES.map(url => fetchProxies(url)));
  let allSocks = [];
  socksResults.forEach(r => { if (r.status === 'fulfilled') allSocks = allSocks.concat(r.value); });

  allHttp = [...new Set(allHttp)];
  allSocks = [...new Set(allSocks)];

  console.log('[Pool] HTTP proxies:', allHttp.length, 'SOCKS5:', allSocks.length);

  const toTestHttp = allHttp.slice(0, 60);
  console.log('[Pool] Testing', toTestHttp.length, 'HTTP proxies against missav.ai...');
  const httpTestResults = await Promise.allSettled(toTestHttp.map(p => testHttpProxy(p)));
  const workingHttp = [];
  httpTestResults.forEach(r => { if (r.status === 'fulfilled' && r.value) workingHttp.push(r.value); });

  const toTestSocks = allSocks.slice(0, 20);
  if (toTestSocks.length > 0) {
    console.log('[Pool] Testing', toTestSocks.length, 'SOCKS5 proxies...');
    const socksTestResults = await Promise.allSettled(toTestSocks.map(p => testSocksProxy(p)));
    socksTestResults.forEach(r => { if (r.status === 'fulfilled' && r.value) workingHttp.push(r.value); });
  }

  workingHttp.sort((a, b) => a.latency - b.latency);
  proxyPool = workingHttp.slice(0, MAX_PROXIES);
  lastRefresh = Date.now();
  poolInUse = [];

  console.log('[Pool] Working:', proxyPool.length, 'Best:', proxyPool.length > 0 ? proxyPool[0].latency + 'ms' : 'N/A');
  if (proxyPool.length > 0) {
    console.log('[Pool] Top 5:', proxyPool.slice(0, 5).map(p => p.proxy).join(', '));
  }
}

function getRandomProxy() {
  if (poolInUse.length > 0) {
    const idx = Math.floor(Math.random() * Math.min(poolInUse.length, 5));
    return poolInUse[idx].proxy;
  }
  if (proxyPool.length === 0) return null;
  const idx = Math.floor(Math.random() * Math.min(proxyPool.length, 10));
  return proxyPool[idx].proxy;
}

function markProxySuccess(proxy) {
  poolInUse = poolInUse.filter(p => p.proxy !== proxy);
  poolInUse.unshift({ proxy, time: Date.now() });
  if (poolInUse.length > 10) poolInUse.pop();
}

function getProxyStatus() {
  return { count: proxyPool.length, lastRefresh, inUse: poolInUse.length, best: proxyPool.length > 0 ? proxyPool.slice(0, 3) : [] };
}

module.exports = { refreshPool, getRandomProxy, markProxySuccess, getProxyStatus };
