async function test() {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Referer': 'https://hohoj.tv/'
  };
  
  // Try javdb.com
  const r1 = await fetch('https://javdb.com/v/ssis-698', { headers, signal: AbortSignal.timeout(10000) });
  const t1 = await r1.text();
  console.log('=== JavDB SSIS-698 ===');
  console.log('Status:', r1.status);
  console.log('Title:', t1.substring(t1.indexOf('<title>')+7, t1.indexOf('</title>')).substring(0, 100));
  console.log('Has m3u8:', t1.includes('.m3u8'));
  console.log('Has video:', t1.includes('<video'));
  console.log('Has iframe:', t1.includes('<iframe'));
  
  // Try hohoj with headers
  const r2 = await fetch('https://hohoj.tv/videos/ssis-698', { headers, signal: AbortSignal.timeout(10000) });
  const t2 = await r2.text();
  console.log('=== HoHoj SSIS-698 ===');
  console.log('Status:', r2.status);
  console.log('Title:', t2.indexOf('<title>') > -1 ? t2.substring(t2.indexOf('<title>')+7, t2.indexOf('</title>')).substring(0, 100) : 'N/A');
}
test().catch(console.error);
