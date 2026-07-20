const { execSync } = require("child_process");
const codes = ["SSIS-698","JUL-970","STARS-256","ABW-335"];
for (const code of codes) {
  try {
    const r = execSync(
      'C:\\Users\\13249\\AppData\\Local\\Programs\\Python\\Python312\\python.exe -c "import cloudscraper,re; s=cloudscraper.create_scraper(delay=10); r=s.get(\\'https://missav.ai/' + code.toLowerCase() + "\\', timeout=15); scripts=re.findall(\\'<script[^>]*>(.*?)</script>\\', r.text, re.DOTALL); [print('" + code + ":', u[:100]) for script in scripts if 'eval(function' in script and 'm3u8' in script for u in re.findall(r'https?://[^\\'\\\\\";\\\\s]+\\.m3u8', script)]\"",
      { timeout: 15000, encoding: "utf8" }
    );
    console.log(r);
  } catch(e) { console.log(code + ": error"); }
}
