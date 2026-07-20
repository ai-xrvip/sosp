const h = {UserAgent: String.fromCharCode(77,111,122,105,108,108,97,47,53,46,48)};
const r = await fetch(String.fromCharCode(104,116,116,112,115,58,47,47,106,97,118,46,103,117,114,117,47,115,115,105,115,45,54,57,56), {headers: h, signal: AbortSignal.timeout(10000)});
const t = await r.text();
console.log(t.includes(String.fromCharCode(105,102,114,97,109,101)));