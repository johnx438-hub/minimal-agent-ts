#!/usr/bin/env python3
"""Fetch a Cloudflare-gated URL via CloakBrowser and print clean markdown to stdout.

Usage: cloak_fetch.py <url>

Stdout: clean markdown extracted from the rendered page via trafilatura.
Stderr: progress messages (safe to /dev/null).
Exit 0 on success, 1 on failure.
"""

import sys
import time

if len(sys.argv) != 2:
    print("usage: cloak_fetch.py <url>", file=sys.stderr)
    sys.exit(1)

url = sys.argv[1]

try:
    from cloakbrowser import launch
except ImportError as e:
    print(f"cloakbrowser import failed: {e}", file=sys.stderr)
    sys.exit(1)

try:
    import trafilatura
except ImportError as e:
    print(f"trafilatura import failed: {e}", file=sys.stderr)
    print("install via: pip install trafilatura", file=sys.stderr)
    sys.exit(1)

try:
    print(f"[cloak] launching headless browser", file=sys.stderr)
    browser = launch(headless=True)
    page = browser.new_page()

    print(f"[cloak] navigating to {url}", file=sys.stderr)
    page.goto(url, wait_until="networkidle", timeout=90000)

    # Cloudflare interstitial flips the title to "Just a moment..." — poll for
    # the real title up to 30s.
    deadline = time.time() + 30
    while time.time() < deadline:
        title = page.title() or ""
        if title and "Just a moment" not in title:
            break
        time.sleep(1)

    # Wait briefly for an SPA content container. If none of these exist, the
    # page is either a plain static doc or the site uses uncommon selectors —
    # fall through to the time.sleep settle below in either case.
    try:
        page.wait_for_selector(
            "main, article, .article__body, .core-container, .pb-page-body",
            timeout=5000,
        )
    except Exception:
        pass

    time.sleep(2)  # extra settle for late-loading JS chunks

    print(f"[cloak] title: {page.title()}", file=sys.stderr)
    html = page.evaluate("() => document.documentElement.outerHTML")
    browser.close()
    print(f"[cloak] rendered, {len(html)} bytes HTML", file=sys.stderr)

    md = trafilatura.extract(
        html,
        url=url,
        output_format="markdown",
        include_links=True,
        include_images=False,
        include_comments=False,
        favor_recall=True,
    )
    if not md:
        print("[cloak] trafilatura found no main content; emitting raw HTML", file=sys.stderr)
        sys.stdout.write(html)
    else:
        sys.stdout.write(md)
        print(f"[cloak] done, {len(md)} bytes markdown", file=sys.stderr)
except Exception as e:
    print(f"[cloak] failed: {e}", file=sys.stderr)
    sys.exit(1)
