import { readFileSync, writeFileSync } from 'fs';

const p = 'C:/Users/13249/Documents/Codex/2026-07-20/syngnat-missav-bot-https-github-com/work/sosp/index.cjs';
let c = readFileSync(p, 'utf8');
c = c.replace('for (let i = 0; i < 15; i++)', 'const mr = proxyAddr ? 5 : 12; for (let i = 0; i < mr; i++)');
c = c.replace('timeout: 15000', 'timeout: proxyAddr ? 10000 : 15000');
c = c.replace('await pg.waitForTimeout(2000);', 'await pg.waitForTimeout(proxyAddr ? 1500 : 2000);');
writeFileSync(p, c, 'utf8');
console.log('OK: warmup fixed');

