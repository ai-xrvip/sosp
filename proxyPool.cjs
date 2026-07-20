// Proxy pool: scrape alive proxies via TCP test, Playwright handles CF
const net = require("net");

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
    return text.split("\n").map(l => l.trim()).filter(l => l && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l));
  } catch(e) { return []; }
}

function testProxyTCP(proxy) {
  return new Promise(resolve => {
    const [host, port] = proxy.split(":");
    const pNum = parseInt(port);
    const start = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(3000);
    socket.on("connect", () => {
      const latency = Date.now() - start;
      socket.destroy();
      resolve({ proxy, latency, time: Date.now() });
    });
    socket.on("error", () => { socket.destroy(); resolve(null); });
    socket.on("timeout", () => { socket.destroy(); resolve(null); });
    socket.connect(pNum, host);
  });
}

async function refreshPool() {
  console.log("[Pool] Refreshing proxy pool...");
  const results = await Promise.allSettled(PROXY_SOURCES.map(url => fetchProxies(url)));
  let allProxies = [];
  results.forEach(r => { if (r.status === "fulfilled") allProxies = allProxies.concat(r.value); });
  allProxies = [...new Set(allProxies)];
  console.log("[Pool] Unique:", allProxies.length);
  if (allProxies.length === 0) { console.log("[Pool] No proxies"); return; }

  const toTest = allProxies.slice(0, 50);
  console.log("[Pool] TCP testing", toTest.length, "proxies...");
  const testResults = await Promise.allSettled(toTest.map(p => testProxyTCP(p)));
  const alive = [];
  testResults.forEach(r => { if (r.status === "fulfilled" && r.value) alive.push(r.value); });

  alive.sort((a, b) => a.latency - b.latency);
  proxyPool = alive.slice(0, MAX_PROXIES);
  lastRefresh = Date.now();
  poolInUse = [];

  console.log("[Pool] Alive:", proxyPool.length, "/", toTest.length, "Best:", proxyPool.length > 0 ? proxyPool[0].latency + "ms" : "N/A");
  if (proxyPool.length > 0) console.log("[Pool] Top 5:", proxyPool.slice(0, 5).map(p => p.proxy).join(", "));
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