// Proxy pool v2: scrape, test against missav.ai, rotate
const http = require('http');
const https = require('https');

const PROXY_SOURCES = [
  'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=5000&country=all&ssl=all',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt',
  'https://raw.githubusercontent.com/ngosang/proxy-lists/master/proxy-lists/http.txt',
  'https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/http.txt',
  'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt',
  'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
  'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
  'https://raw.githubusercontent.com/almroot/proxylist/master/list.txt',
  'https://raw.githubusercontent.com/roma8ok/proxy-list/main/proxy-list-http.txt'
];

let proxyPool = [];
let lastRefresh = 0;
let poolInUse = [];
const REFRESH_INTERVAL = 10 * 60 * 1000;
const MAX_PROXIES = 30;

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
    return text.split('\n').map(l => l.trim()).filter(l => l && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l));
  } catch(e) { return []; }
}

// Test HTTP proxy by checking if it can reach missav.ai via CONNECT tunnel
// Uses a timeout wrapper to prevent hanging
function testHttpProxy(proxy) {
  return new Promise(resolve => {
    const [host, port] = proxy.split(':');
    const pNum = parseInt(port);
    const start = Date.now();
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) { finished = true; resolve(null); }
    }, 10000);

    try {
      const req = http.request({
        hostname: host,
        port: pNum,
        method: 'CONNECT',
        path: 'missav.ai:443',
        timeout: 8000,
        headers: { Host: 'missav.ai:443' }
      });

      req.on('connect', (res, socket) => {
        if (finished) { socket.destroy(); return; }
        if (res.statusCode !== 200) {
          socket.destroy();
          if (!finished) { finished = true; clearTimeout(timer); resolve(null); }
          return;
        }

        // Do TLS handshake over the tunnel
        let tlsSocket = null;
        try {
          const tls = require('tls');
          tlsSocket = tls.connect({
            socket: socket,
            servername: 'missav.ai',
            host: 'missav.ai',
            port: 443,
            rejectUnauthorized: false
          }, () => {
            if (finished) { tlsSocket.destroy(); return; }
            tlsSocket.write('GET / HTTP/1.1\r\nHost: missav.ai\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\nConnection: close\r\n\r\n');
            let data = '';
            const dataHandler = chunk => { data += chunk.toString(); };
            const endHandler = () => {
              if (finished) return;
              finished = true;
              clearTimeout(timer);
              const latency = Date.now() - start;
              if ((data.includes('missav') || data.includes('MissAV')) && !data.includes('Just a moment') && !data.includes('cf-browser-verification')) {
                resolve({ proxy, latency, time: Date.now() });
              } else {
                resolve(null);
              }
            };
            const errorHandler = () => {
              if (!finished) { finished = true; clearTimeout(timer); resolve(null); }
            };
            tlsSocket.on('data', dataHandler);
            tlsSocket.on('end', endHandler);
            tlsSocket.on('error', errorHandler);
            tlsSocket.on('close', () => {
              if (!finished) {
                finished = true;
                clearTimeout(timer);
                // If we got data, process it even without 'end'
                if (data) {
                  const latency = Date.now() - start;
                  if ((data.includes('missav') || data.includes('MissAV')) && !data.includes('Just a moment') && !data.includes('cf-browser-verification')) {
                    resolve({ proxy, latency, time: Date.now() });
                  } else {
                    resolve(null);
                  }
                } else {
                  resolve(null);
                }
              }
            });
          });
          tlsSocket.on('error', () => { if (!finished) { finished = true; clearTimeout(timer); resolve(null); } });
          tlsSocket.setTimeout(8000, () => { tlsSocket.destroy(); if (!finished) { finished = true; clearTimeout(timer); resolve(null); } });
        } catch(e) {
          if (!finished) { finished = true; clearTimeout(timer); resolve(null); }
          if (tlsSocket) try { tlsSocket.destroy(); } catch(e2) {}
        }
      });

      req.on('error', () => { if (!finished) { finished = true; clearTimeout(timer); resolve(null); } });
      req.on('timeout', () => { req.destroy(); if (!finished) { finished = true; clearTimeout(timer); resolve(null); } });
      req.setTimeout(8000);
      req.end();
    } catch(e) {
      if (!finished) { finished = true; clearTimeout(timer); resolve(null); }
    }
  });
}

async function refreshPool() {
  console.log('[Pool] Refreshing proxy pool...');

  const httpResults = await Promise.allSettled(PROXY_SOURCES.map(url => fetchProxies(url)));
  let allHttp = [];
  httpResults.forEach(r => { if (r.status === 'fulfilled') allHttp = allHttp.concat(r.value); });

  allHttp = [...new Set(allHttp)];
  console.log('[Pool] Unique HTTP proxies:', allHttp.length);

  // Test a smaller batch with tight timeouts
  const toTest = allHttp.slice(0, 30);
  console.log('[Pool] Testing', toTest.length, 'proxies against missav.ai (10s timeout)...');

  const testResults = await Promise.allSettled(toTest.map(p => testHttpProxy(p)));
  const working = [];
  testResults.forEach(r => { if (r.status === 'fulfilled' && r.value) working.push(r.value); });

  working.sort((a, b) => a.latency - b.latency);
  proxyPool = working.slice(0, MAX_PROXIES);
  lastRefresh = Date.now();
  poolInUse = [];

  console.log('[Pool] Working:', proxyPool.length, 'Best latency:', proxyPool.length > 0 ? proxyPool[0].latency + 'ms' : 'N/A');
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
