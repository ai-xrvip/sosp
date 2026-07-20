
const h = {'User-Agent': 'Mozilla/5.0'};

async function check(url) {
  try {
    const r = await fetch(url, {headers: h, signal: AbortSignal.timeout(8000)});
    const t = await r.text();
    return {
      status: r.status,
      title: t.match(/<title>([^<]+)/)?.[1]?.substring(0,80),
      m3u8: t.includes('.m3u8'),
      surrit: t.includes('surrit'),
      video: t.includes('<video'),
      iframe: t.includes('<iframe'),
      size: t.length
    };
  } catch(e) { return {error: e.message.substring(0,40)}; }
}

const results = await Promise.all([
  check('https://jav.guru/ssis-698'),
  check('https://javdb.com/v/KkOwR'),
  check('https://r18.dev/videos/vod/movies/detail/-/id=ssis00698')
]);

results.forEach((r, i) => {
  const names = ['jav.guru', 'javdb.com', 'r18.dev'];
  console.log(names[i] + ':', JSON.stringify(r).substring(0,300));
});

