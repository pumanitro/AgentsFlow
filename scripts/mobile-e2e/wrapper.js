'use strict';
// Electron entry for the ISOLATED Peers Flow instance (offscreen, no dock icon, no window).
// - require('electron') returns a Proxy whose BrowserWindow is a construct-trap FACTORY:
//   `new BrowserWindow(opts)` builds a REAL window (so BrowserWindow.getAllWindows() still
//   sees it) with show:false and offscreen rendering. A subclass would be invisible to
//   getAllWindows(), which main.ts relies on.
// - HTTP side channel on 127.0.0.1:$PF_SIDE_PORT: GET /info, GET /shot (PNG), POST /js.
// Then it loads the real main process from dist/electron/electron/main.js.
const Module = require('module');
const http = require('http');
const path = require('path');

const REPO = '/Users/iij/Desktop/AgentsFlow';
const MAIN = path.join(REPO, 'dist', 'electron', 'electron', 'main.js');
const SIDE_PORT = Number(process.env.PF_SIDE_PORT || 47832);

const realElectron = require('electron');
const RealBW = realElectron.BrowserWindow;
const noop = function () {};

const FactoryBW = new Proxy(RealBW, {
  construct(target, args) {
    const opts = Object.assign({}, args[0] || {});
    opts.show = false;
    opts.webPreferences = Object.assign({}, opts.webPreferences || {}, { offscreen: true, backgroundThrottling: false });
    const win = new target(opts);
    try { win.webContents.setFrameRate(15); } catch { /* ignore */ }
    win.show = noop;
    win.showInactive = noop;
    win.focus = noop;
    win.moveTop = noop;
    try { win.webContents.openDevTools = noop; } catch { /* ignore */ }
    return win;
  },
});

const electronProxy = new Proxy(realElectron, {
  get(target, prop, receiver) {
    if (prop === 'BrowserWindow') return FactoryBW;
    return Reflect.get(target, prop, receiver);
  },
});

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronProxy;
  return origLoad.apply(this, arguments);
};

const { app, webContents } = realElectron;
app.commandLine.appendSwitch('force-device-scale-factor', '2');

function mainContents() {
  const all = webContents.getAllWebContents().filter((w) => !w.isDestroyed());
  const byUrl = all.find((w) => /^app:\/\//.test(w.getURL()) || /localhost:3030/.test(w.getURL()));
  return byUrl || all.find((w) => w.getType() === 'window') || null;
}

function send(res, code, body, type) {
  res.writeHead(code, { 'content-type': type || 'application/json' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function startSide() {
  const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
    if (req.method === 'GET' && url === '/info') {
      const all = webContents.getAllWebContents().filter((w) => !w.isDestroyed());
      return send(res, 200, {
        pid: process.pid,
        userData: app.getPath('userData'),
        windows: RealBW.getAllWindows().length,
        urls: all.map((w) => w.getURL()),
      });
    }
    if (req.method === 'GET' && url === '/shot') {
      const wc = mainContents();
      if (!wc) return send(res, 503, { error: 'no window yet' });
      wc.capturePage().then((img) => send(res, 200, img.toPNG(), 'image/png'), (e) => send(res, 500, { error: String(e && e.message || e) }));
      return;
    }
    if (req.method === 'POST' && url === '/js') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const wc = mainContents();
        if (!wc) return send(res, 503, { error: 'no window yet' });
        wc.executeJavaScript(body, true).then(
          (v) => send(res, 200, { ok: true, value: v === undefined ? null : v }),
          (e) => send(res, 500, { ok: false, error: String(e && e.message || e) }),
        );
      });
      return;
    }
    send(res, 404, { error: 'not found' });
  });
  server.on('error', (e) => console.error('[mobile-e2e][side] side channel failed', e && e.message));
  server.listen(SIDE_PORT, '127.0.0.1', () => console.log(`[mobile-e2e][side] listening on 127.0.0.1:${SIDE_PORT}`));
}

app.whenReady().then(() => {
  try { if (app.dock) app.dock.hide(); } catch { /* ignore */ }
  startSide();
});

console.log('[mobile-e2e] wrapper pid', process.pid, 'userData', process.env.AGENTSFLOW_USER_DATA);
require(MAIN);
