---
name: cloak-fetch
description: Use as a fallback when a web page won't load via WebFetch, curl, or any HTTP client because it's behind anti-bot protection — Cloudflare, DataDome, Akamai Bot Manager, PerimeterX/HUMAN, Imperva/Incapsula, F5/Distil, Kasada, AWS WAF, Sucuri, or generic WAF/CDN screening — and returns 403/429/"Just a moment"/"Access Denied"/"Pardon Our Interruption"/"Please verify you are a human"/"Incapsula incident"/"Sucuri WebSite Firewall"/"Reference #" patterns, or an empty body with no useful HTML. Routes the URL through CloakBrowser (a stealth Chromium with C++-level anti-bot patches plus a real TLS/JA3 fingerprint) headlessly, then extracts clean markdown via trafilatura. PROACTIVELY USE whenever a recent fetch returned HTTP 403/429, any of the strings above, "Enable JavaScript and cookies", "Resource was not loaded", or any signal of bot detection / WAF screening — do not tell the user a page is unfetchable until you've tried this skill.
license: MIT
homepage: https://github.com/Agents365-ai/cloakFetch
compatibility: Requires CloakBrowser (https://github.com/CloakHQ/CloakBrowser) installed with the `cloakbrowser` Python package importable, plus `trafilatura` (`pip install trafilatura`) in the same env for HTML→markdown extraction. Set `CLOAKBROWSER_PYTHON` to your cloakbrowser-enabled Python if not in the default location.
platforms: [macos, linux, windows]
metadata: {"openclaw":{"requires":{"bins":["python3"]},"emoji":"🥷"},"hermes":{"tags":["webfetch","cloudflare","datadome","akamai","perimeterx","imperva","sucuri","waf","stealth-browser","bot-bypass","fallback","scraping"],"category":"web","requires_tools":["python3"],"related_skills":[]},"author":"Agents365-ai","version":"0.3.0"}
---

# cloak-fetch — bot-protection / WAF fetch fallback

When a normal HTTP fetcher fails because the target site uses bot protection
or WAF screening, route the same URL through CloakBrowser (a real Chromium
with anti-bot patches at the C++ level and a genuine TLS/JA3 fingerprint) and
return clean markdown via trafilatura. The agent never has to tell the user
"the page is unfetchable" — it can try this skill first.

The underlying engine doesn't care which vendor is blocking the request —
Cloudflare, DataDome, Akamai, PerimeterX, Imperva, Distil, Kasada, AWS WAF,
or a no-name WAF rule. They all eventually let a real browser through, and
CloakBrowser is a real browser.

## When to trigger

Use **immediately** after any of these symptoms from a recent fetch tool call:

| Symptom in tool output | Likely cause |
|---|---|
| `HTTP 403`, `403 Forbidden`, `HTTP 429` | Bot protection or rate-limit block |
| Empty body / a few hundred bytes of nothing on a content-rich URL | Silent WAF / TLS-fingerprint reject |
| Page rendered as a near-empty shell with a JS challenge script | SPA-only page or anti-bot challenge |
| `Resource was not loaded`, `net::ERR_HTTP2_PROTOCOL_ERROR` | Upstream blocked the fetch handshake |
| `Access denied`, `Blocked`, `You don't have permission` | Generic WAF / bot detection |

### Vendor-specific signatures

If the failure string roughly matches one of these, **it's a CloakBrowser case** —
don't waste another round-trip on a plain HTTP client:

| Vendor | Telltale strings / headers |
|---|---|
| **Cloudflare** | `Just a moment...`, `Enable JavaScript and cookies to continue`, `cf-ray:` header, `__cf_bm` cookie, `Attention Required! \| Cloudflare`, `Sorry, you have been blocked` |
| **DataDome** | `blocked by DataDome`, `<title>blocked</title>`, `dd-cookie` / `datadome` cookie, `<head>...captcha-delivery.com`, geo-block style 403 with empty body |
| **Akamai Bot Manager** | `Access Denied` with `Reference #18.` (long hex.epoch.hex) ID, `<TITLE>Access Denied</TITLE>` + Akamai `<HTML><HEAD>` boilerplate, `Pragma: akamai-x-cache`, `akamai-bot-manager` cookie |
| **PerimeterX / HUMAN** | `Please verify you are a human`, `Access to this page has been denied because we believe you are using automation tools`, `_px*` cookies (`_pxhd`, `_px3`), `<title>Human Verification</title>` |
| **Imperva / Incapsula** | `Incapsula incident ID:`, `Request unsuccessful. Incapsula incident ID`, `_Incapsula_Resource`, `visid_incap_*` cookie, `X-Iinfo` header |
| **F5 / Distil** | `Pardon Our Interruption`, `As you were browsing something about your browser made us think you were a bot`, `distil_r_captcha`, `D_RID` cookie |
| **Kasada** | `<head>` containing `ips.js`, `x-kpsdk-cd` / `x-kpsdk-cr` response headers, `429` with empty body + `kasada` reference |
| **AWS WAF** | `Request blocked` + `<aws-waf-token>`, `awswaf` cookie, body referencing `aws-waf-token` |
| **Sucuri** | `Sucuri WebSite Firewall - Access Denied`, `<title>Sucuri WebSite Firewall - CloudProxy</title>`, `X-Sucuri-ID` / `X-Sucuri-Cache` header, `sucuri-cf-id` cookie (very common on self-hosted WordPress) |
| **reCAPTCHA / hCaptcha passive triggers** | Interstitial that *displays without user interaction* — page replaced with `g-recaptcha`/`h-captcha` div and no real content. (See "When NOT to trigger" for interactive checkbox/slider cases.) |
| **TLS / JA3 fingerprint reject** | Connection drops, empty body, `ERR_HTTP2_PROTOCOL_ERROR`, `SSL_ERROR_ZERO_RETURN` on a site that loads fine in a normal browser |

Also trigger preemptively when the user asks to fetch a page on a domain
known to live behind one of these stacks — publishers (science.org,
nature.com, sciencedirect.com, jstor.org), news (nytimes.com, bloomberg.com,
ft.com, wsj.com), retail (nike.com, adidas.com, sephora.com), travel
(kayak.com, southwest.com), financial (most broker portals). Going straight
to this skill avoids a guaranteed-to-fail plain-HTTP round trip.

## When NOT to trigger

| Symptom | Why this skill won't help |
|---|---|
| `404 Not Found` | Page genuinely doesn't exist |
| `500 Internal Server Error` | Origin is broken, not blocking you |
| `401 Unauthorized` / login wall | Credentials needed — CloakBrowser does not carry them |
| Plain network error (DNS, connection refused, no route to host) | Network unreachable, not a bot block |
| **Interactive** captcha — slider, image-grid (reCAPTCHA "select all crosswalks"), Cloudflare Turnstile **checkbox** that requires a click, hCaptcha challenge | Needs a human or a paid solver service. CloakBrowser passes *passive* fingerprint checks but does not solve human-interaction challenges. |
| Geo-block where your IP's country is the actual reason (`This content is not available in your region`) | CloakBrowser uses the same IP — proxy/VPN is the fix, not a different browser |
| Site requires a session cookie, OAuth, or signed URL | No credential plumbing — fetch the auth artifact first via the proper channel |
| The normal fetcher already succeeded | No need to re-fetch |

In these cases, report the actual failure to the user instead of masking it.

## How to invoke

One command — the wrapper picks the right Python, runs the headless browser,
extracts the main content with trafilatura, and writes clean markdown to stdout:

```bash
<SKILL_DIR>/cloak_fetch.sh "<URL>"
```

Where `<SKILL_DIR>` is wherever this skill is installed. Common locations:

- Claude Code: `~/.claude/skills/cloak-fetch`
- OpenClaw: `~/.openclaw/skills/cloak-fetch`
- Codex: `~/.codex/skills/cloak-fetch`
- Project-local: `.claude/skills/cloak-fetch` or `skills/cloak-fetch`

A portable invocation that finds the skill across these locations:

```bash
for d in \
  "$HOME/.claude/skills/cloak-fetch" \
  "$HOME/.openclaw/skills/cloak-fetch" \
  "$HOME/.codex/skills/cloak-fetch" \
  ".claude/skills/cloak-fetch" \
  "skills/cloak-fetch"; do
  if [ -x "$d/cloak_fetch.sh" ]; then
    SKILL_DIR="$d"; break
  fi
done

"$SKILL_DIR/cloak_fetch.sh" "https://www.science.org/content/page/information-authors-research-articles"
```

The wrapper streams clean markdown on stdout. Save to a file with `> out.md` or
pipe directly into further processing.

## Behavior

- **Headless by default** — no browser window opens.
- **Latency:** ~20–40 s per call (browser launch + page render + content settle).
- **Output:** clean markdown via trafilatura. Page chrome, navigation, ads,
  and cookie banners stripped. Headings, lists, links, and code blocks
  preserved. When trafilatura can't isolate a main content node, the wrapper
  falls back to emitting the rendered HTML so the agent still has something
  to read.
- **Failure modes:** exits non-zero with a message on stderr if no
  cloakbrowser-enabled Python is found, the browser couldn't reach the URL, or
  CloakBrowser couldn't pass the challenge. Surface the failure honestly to
  the user — do not fabricate page content.

## Configuration

| Env var | Purpose | Default |
|---|---|---|
| `CLOAKBROWSER_PYTHON` | Path to the Python interpreter with `cloakbrowser` installed | `~/github/CloakBrowser/.venv/bin/python`, falling back to `python3` |

For more advanced tuning (headless toggle, content-selector wait list, settle
timing), edit `cloak_fetch.py` directly — see comments in that file.

## Example end-to-end

User: "Get the authors info from https://www.science.org/content/page/information-authors-research-articles"

1. Agent tries `WebFetch` — gets `HTTP 403 Forbidden`.
2. Agent recognises the 403 → invokes this skill:
   ```bash
   ~/.claude/skills/cloak-fetch/cloak_fetch.sh \
     "https://www.science.org/content/page/information-authors-research-articles"
   ```
3. ~25 s later, ~26 KB of clean markdown lands on stdout.
4. Agent answers the user from the markdown — no need to mention the
   underlying fetch took two attempts.

## Related

- [cloakFetch hook](../../hooks/) — same fallback wired up as a Claude Code
  `PostToolUse` hook (fully automatic, no agent decision required). Use the
  hook on Claude Code; use this skill on agents that lack a hook system
  (Codex, OpenCode, OpenClaw, etc.).
