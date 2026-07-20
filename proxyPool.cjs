// Proxy pool: scrape, validate, rotate
var PROXY_SOURCES = [
  "https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=5000&country=all&ssl=all",
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
  "https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt",
  "https://raw.githubusercontent.com/ngosang/proxy-lists/master/proxy-lists/http.txt"
];

var proxyPool = [];
var lastRefresh = 0;
var REFRESH_INTERVAL = 10 * 60 * 1000;
var MAX_PROXIES = 50;

function timeoutSignal(ms) {
  var ctrl = new AbortController();
  setTimeout(function() { ctrl.abort(); }, ms);
  return ctrl.signal;
}

async function fetchProxies(url) {
  try {
    var resp = await fetch(url, { signal: timeoutSignal(10000) });
    if (!resp.ok) return [];
    var text = await resp.text();
    return text.split("\n").map(function(l){ return l.trim(); }).filter(function(l){
      return l && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l);
    });
  } catch(e) {
    return [];
  }
}

async function testProxy(proxy) {
  try {
    var start = Date.now();
    var resp = await fetch("https://httpbin.org/ip", {
      signal: timeoutSignal(5000),
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (!resp.ok) return null;
    var latency = Date.now() - start;
    return { proxy: proxy, latency: latency, time: Date.now() };
  } catch(e) {
    return null;
  }
}

async function refreshPool() {
  console.log("[Pool] Refreshing proxy pool...");
  var allProxies = [];

  var results = await Promise.allSettled(PROXY_SOURCES.map(function(url){ return fetchProxies(url); }));
  results.forEach(function(r){
    if (r.status === "fulfilled") allProxies = allProxies.concat(r.value);
  });

  var unique = {};
  allProxies.forEach(function(p){ unique[p] = true; });
  allProxies = Object.keys(unique);

  if (allProxies.length === 0) {
    console.log("[Pool] No proxies found");
    return;
  }
  console.log("[Pool] Found", allProxies.length, "unique, testing...");

  var toTest = allProxies.slice(0, 80);
  var testResults = await Promise.allSettled(toTest.map(function(p){ return testProxy(p); }));
  var working = [];
  testResults.forEach(function(r){
    if (r.status === "fulfilled" && r.value) working.push(r.value);
  });

  working.sort(function(a,b){ return a.latency - b.latency; });
  proxyPool = working.slice(0, MAX_PROXIES);
  lastRefresh = Date.now();
  console.log("[Pool] Working:", proxyPool.length, "Best:", proxyPool.length > 0 ? proxyPool[0].latency + "ms" : "N/A");
}

function getRandomProxy() {
  if (proxyPool.length === 0) return null;
  var idx = Math.floor(Math.random() * Math.min(proxyPool.length, 10));
  return proxyPool[idx].proxy;
}

function getProxyStatus() {
  return { count: proxyPool.length, lastRefresh: lastRefresh, best: proxyPool.length > 0 ? proxyPool.slice(0, 3) : [] };
}

module.exports = { refreshPool: refreshPool, getRandomProxy: getRandomProxy, getProxyStatus: getProxyStatus };
