// 启动器：优先运行从 GitHub 下载的最新代码，失败则回退到内置版本。
const { app, net } = require('electron');
const path = require('path');
const fs = require('fs');

const BASES = [
  'https://raw.githubusercontent.com/skewliness/hark-cockpit/main/app/',
  'https://cdn.jsdelivr.net/gh/skewliness/hark-cockpit@main/app/',
];
const bundledDir = path.join(__dirname, 'app');
const cacheRoot = path.join(app.getPath('userData'), 'app-cache');

const cmp = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
const readVer = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8')).version; } catch { return null; } };

function pickDir() {
  let best = { dir: bundledDir, version: readVer(bundledDir) || '0.0.0' };
  try {
    for (const d of fs.readdirSync(cacheRoot)) {
      const dir = path.join(cacheRoot, d), v = readVer(dir);
      if (v && !d.endsWith('.tmp') && fs.existsSync(path.join(dir, 'main.js')) && cmp(v, best.version) > 0) best = { dir, version: v };
    }
  } catch {}
  return best;
}

async function get(url, json) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
  try { await app.whenReady(); const doFetch = (net && net.fetch) ? net.fetch.bind(net) : fetch;
    const r = await doFetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { signal: ctl.signal });
    if (!r.ok) throw new Error(r.status); return json ? r.json() : r.text(); } finally { clearTimeout(t); }
}

const running = pickDir();
const boot = global.__cockpitBoot = { version: running.version, pending: null, onReady: null };
let busy = null;

boot.check = () => busy || (busy = (async () => {
  let reached = false;
  for (const base of BASES) {
    try {
      const meta = await get(base + 'version.json', true); reached = true;
      const target = boot.pending || running.version;
      if (cmp(meta.version, target) <= 0) return 'latest';
      const tmp = path.join(cacheRoot, meta.version + '.tmp'), final = path.join(cacheRoot, meta.version);
      fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
      for (const f of meta.files) fs.writeFileSync(path.join(tmp, f), await get(base + f, false));
      fs.writeFileSync(path.join(tmp, 'version.json'), JSON.stringify(meta));
      fs.rmSync(final, { recursive: true, force: true }); fs.renameSync(tmp, final);
      boot.pending = meta.version; boot.onReady?.(meta.version);
      return 'ready';
    } catch (e) { /* 换下一个源 */ }
  }
  return reached ? 'error' : 'offline';
})().finally(() => { busy = null; }));

app.whenReady().then(() => setTimeout(() => boot.check(), 3000));
try { require(path.join(running.dir, 'main.js')); }
catch (e) { // 下载的版本出错时回退到内置版本
  if (running.dir !== bundledDir) { fs.rmSync(running.dir, { recursive: true, force: true }); boot.version = readVer(bundledDir); require(path.join(bundledDir, 'main.js')); }
  else throw e;
}
