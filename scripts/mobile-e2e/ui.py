#!/usr/bin/env python3
"""Tiny uiautomator driver for the E2E emulator (stdlib only).

Compose test tags (testTagsAsResourceId) show up as resource-ids WITHOUT a package prefix,
so ids are matched by equality or by suffix after '/'.

  ui.py dump                      print the raw hierarchy XML
  ui.py find <id>                 print "x y w h text" of the first match (exit 1 if absent)
  ui.py wait <id> <seconds>       poll until <id> exists (exit 1 on timeout)
  ui.py tap <id>                  tap the centre of <id>
  ui.py type <id> <text>          tap, select all, delete, type <text>
  ui.py text <id>                 text/content-desc of the node and all its descendants
  ui.py exists <id>               exit 0 if present, 1 if not (prints true/false)
  ui.py has-text <regex>          exit 0 if any node's text/content-desc matches (case-insensitive)
  ui.py count <prefix>            number of nodes whose id starts with <prefix>
  ui.py swipe up|down             one screen-height-ish swipe
  ui.py back | home               key events
  ui.py screenshot <file>         PNG via screencap (asserts > 10 KB)
"""
import os
import re
import shlex
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

ADB = os.environ.get('ADB', '/Users/iij/Library/Android/sdk/platform-tools/adb')
SERIAL = os.environ.get('SERIAL', 'emulator-5600')


def adb(*args, check=True, binary=False):
    r = subprocess.run([ADB, '-s', SERIAL, *args], capture_output=True)
    if check and r.returncode != 0:
        raise SystemExit(f'adb {" ".join(args)} failed: {r.stderr.decode(errors="replace").strip()}')
    return r.stdout if binary else r.stdout.decode('utf-8', errors='replace')


def dump_xml():
    last = ''
    for _ in range(3):
        out = adb('shell', 'uiautomator dump /sdcard/pf-ui.xml >/dev/null 2>&1; cat /sdcard/pf-ui.xml', check=False)
        i = out.find('<?xml')
        if i >= 0:
            return out[i:]
        last = out
        time.sleep(0.5)
    raise SystemExit(f'uiautomator dump failed: {last.strip()[:200]}')


def short_id(rid):
    return rid.rsplit('/', 1)[-1] if rid else ''


def matches(node, wanted):
    rid = node.get('resource-id', '')
    return bool(rid) and (rid == wanted or rid.endswith('/' + wanted) or short_id(rid) == wanted)


def find_node(wanted, root=None):
    root = root if root is not None else ET.fromstring(dump_xml())
    for n in root.iter('node'):
        if matches(n, wanted):
            return n
    return None


def bounds(node):
    m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.get('bounds', ''))
    if not m:
        raise SystemExit('node has no bounds')
    x1, y1, x2, y2 = map(int, m.groups())
    return x1, y1, x2 - x1, y2 - y1


def all_text(node):
    parts = []
    for n in node.iter('node'):
        for attr in ('text', 'content-desc'):
            v = (n.get(attr) or '').strip()
            if v and v not in parts:
                parts.append(v)
    return ' '.join(parts)


def need(wanted):
    n = find_node(wanted)
    if n is None:
        print(f'{wanted}: not found', file=sys.stderr)
        sys.exit(1)
    return n


def tap_node(n):
    x, y, w, h = bounds(n)
    adb('shell', 'input', 'tap', str(x + w // 2), str(y + h // 2))


def screen_size():
    out = adb('shell', 'wm', 'size')
    m = re.findall(r'(\d+)x(\d+)', out)
    w, h = map(int, m[-1]) if m else (1080, 2400)
    return w, h


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    cmd, args = argv[0], argv[1:]
    if cmd == 'dump':
        print(dump_xml())
    elif cmd == 'find':
        n = need(args[0])
        x, y, w, h = bounds(n)
        print(x, y, w, h, all_text(n))
    elif cmd == 'wait':
        wanted, secs = args[0], float(args[1])
        deadline = time.time() + secs
        while time.time() < deadline:
            if find_node(wanted) is not None:
                print(f'{wanted}: present')
                return 0
            time.sleep(1)
        print(f'{wanted}: not present after {secs:g}s', file=sys.stderr)
        return 1
    elif cmd == 'tap':
        tap_node(need(args[0]))
    elif cmd == 'type':
        n = need(args[0])
        text = ' '.join(args[1:])
        tap_node(n)
        time.sleep(0.3)
        adb('shell', 'input', 'keycombination', '113', '29')  # CTRL+A
        adb('shell', 'input', 'keyevent', '67')               # DEL
        # `input text` takes %s for spaces; the remote shell needs the rest quoted.
        adb('shell', 'input text ' + shlex.quote(text.replace(' ', '%s')))
    elif cmd == 'text':
        print(all_text(need(args[0])))
    elif cmd == 'exists':
        ok = find_node(args[0]) is not None
        print('true' if ok else 'false')
        return 0 if ok else 1
    elif cmd == 'has-text':
        rx = re.compile(args[0], re.I)
        root = ET.fromstring(dump_xml())
        hit = next((v for n in root.iter('node') for v in (n.get('text') or '', n.get('content-desc') or '') if v and rx.search(v)), None)
        print(hit if hit else 'false')
        return 0 if hit else 1
    elif cmd == 'count':
        prefix = args[0]
        root = ET.fromstring(dump_xml())
        print(sum(1 for n in root.iter('node') if short_id(n.get('resource-id', '')).startswith(prefix)))
    elif cmd == 'swipe':
        w, h = screen_size()
        x = w // 2
        a, b = (int(h * 0.75), int(h * 0.25)) if args[0] == 'up' else (int(h * 0.25), int(h * 0.75))
        adb('shell', 'input', 'swipe', str(x), str(a), str(x), str(b), '300')
    elif cmd == 'back':
        adb('shell', 'input', 'keyevent', '4')
    elif cmd == 'home':
        adb('shell', 'input', 'keyevent', '3')
    elif cmd == 'screenshot':
        png = adb('exec-out', 'screencap', '-p', binary=True)
        with open(args[0], 'wb') as f:
            f.write(png)
        if len(png) <= 10240:
            print(f'screenshot too small ({len(png)} bytes)', file=sys.stderr)
            return 1
        print(f'{args[0]} ({len(png)} bytes)')
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
