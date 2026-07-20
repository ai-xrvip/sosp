#!/usr/bin/env python3
"""Fetch missav page via cloudscraper, extract m3u8 URL from obfuscated JS."""
import sys, json, re, os
try:
    import cloudscraper
except ImportError:
    print(json.dumps({"error": "cloudscraper not installed"}))
    sys.exit(1)

MIRRORS = ["missav.ai", "missav.ws", "missav123.com", "missav.live"]
PROXY = os.environ.get("PROXY", "")

proxy_kwargs = {}
if PROXY:
    proxy_kwargs["proxies"] = {"http": "http://" + PROXY, "https": "http://" + PROXY}

def unpack_js(script_text):
    """Decode Dean Edwards p,a,c,k,e,d packer."""
    m = re.search(
        r'eval\(function\(p,a,c,k,e,d\)\{.*?\}\(' + "'(.*?)',\\s*(\\d+),\\s*(\\d+),\\s*'([^']*)'\\s*\\.split\\('\\|'\\)",
        script_text, re.DOTALL
    )
    if not m:
        return None
    packed, base, count, keys_str = m.group(1), int(m.group(2)), int(m.group(3)), m.group(4).split("|")
    if base <= 1 or count < 0 or count > 200000:
        return None
    def to_base(n, b):
        d = "0123456789abcdefghijklmnopqrstuvwxyz"
        if n == 0: return "0"
        s = ""
        while n: s = d[n % b] + s; n //= b
        return s
    lookup = {}
    for i in range(count):
        key = to_base(i, base)
        lookup[key] = keys_str[i] if i < len(keys_str) and keys_str[i] else key
    return re.sub(r"\b(\w+)\b", lambda mo: lookup.get(mo.group(0), mo.group(0)), packed)

def scrape(code):
    code = code.upper()
    path = code.lower()
    result = {"code": code, "title": "", "cover": "", "m3u8_url": "", "uuid": "", "mirror": "", "method": "", "error": ""}

    try:
        scraper = cloudscraper.create_scraper(delay=5)

        for host in MIRRORS:
            url = f"https://{host}/{path}"
            try:
                resp = scraper.get(url, timeout=20,
                    headers={
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                        "Referer": f"https://{host}/",
                        "Accept": "text/html,application/xhtml+xml"
                    },
                    **proxy_kwargs
                )

                text = resp.text

                # Check for CF blocks
                if "just a moment" in text.lower() or "cf-browser-verification" in text or resp.status_code in (403, 503):
                    continue

                # Extract title
                ti = re.search(r'og:title["\s]+content=["\']([^"\']+)', text)
                if ti:
                    result["title"] = ti.group(1).replace("&amp;", "&")

                # Extract cover
                ci = re.search(r'og:image["\s]+content=["\']([^"\']+)', text)
                if ci:
                    result["cover"] = ci.group(1)

                # Method 1: Extract direct m3u8 from JS packer (best)
                scripts = re.findall(r"<script[^>]*>(.*?)</script>", text, re.DOTALL)
                for script in scripts:
                    if "eval(function" not in script or "m3u8" not in script:
                        continue
                    unpacked = unpack_js(script)
                    if unpacked:
                        main_match = re.search(r"source\s*=\s*[\\']*(https?://[^'\\;\s]+\.m3u8)", unpacked)
                        if main_match:
                            result["m3u8_url"] = main_match.group(1)
                            result["method"] = "js_packer_direct"
                            break
                        any_match = re.search(r"(https?://[^'\\;\s]+\.m3u8)", unpacked)
                        if any_match:
                            result["m3u8_url"] = any_match.group(1)
                            result["method"] = "js_packer_any"
                            break

                # Method 2: Extract UUID from m3u8|hex|com pattern (fallback)
                if not result["m3u8_url"]:
                    idx = text.find("m3u8|")
                    if idx >= 0:
                        sec = text[idx:idx+300]
                        parts = sec.split("|")
                        hex_parts = []
                        for i in range(1, len(parts)):
                            if parts[i] == "com": break
                            if re.match(r"^[a-f0-9]+$", parts[i], re.I):
                                hex_parts.append(parts[i])
                        uuid = "-".join(reversed(hex_parts))
                        if len(uuid) >= 20:
                            result["uuid"] = uuid
                            result["m3u8_url"] = f"https://surrit.com/{uuid}/playlist.m3u8"
                            result["method"] = "uuid_fallback"

                if result["m3u8_url"]:
                    result["mirror"] = host
                    # Try to fetch the actual playlist
                    try:
                        pr = scraper.get(result["m3u8_url"], timeout=15,
                            headers={"Referer": f"https://{host}/", "User-Agent": "Mozilla/5.0"},
                            **proxy_kwargs
                        )
                        if pr.status_code == 200:
                            result["playlist_ok"] = True
                            # Extract best resolution
                            for line in pr.text.split("\n"):
                                if "RESOLUTION=" in line:
                                    m = re.search(r"RESOLUTION=(\d+x\d+)", line)
                                    if m: result["resolution"] = m.group(1)
                        else:
                            result["playlist_ok"] = False
                            result["playlist_status"] = pr.status_code
                    except Exception as e:
                        result["playlist_ok"] = False
                        result["playlist_error"] = str(e)[:60]

                    return result

            except Exception as e:
                continue

        result["error"] = "all mirrors blocked by Cloudflare"
    except Exception as e:
        result["error"] = str(e)[:100]

    return result

if __name__ == "__main__":
    code = sys.argv[1] if len(sys.argv) > 1 else "SSIS-698"
    result = scrape(code)
    print(json.dumps(result))
