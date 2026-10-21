// Hark Cockpit: 每个 Hark 账号一个独立的持久化会话（cookie/登录态互不干扰），侧栏一键切换。
const { app, BaseWindow, WebContentsView, ipcMain, session, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const SIDEBAR_W = 220;
const DEFAULT_URL = 'https://app.hark.com';
// 去掉 Electron 标识，降低 Google 登录拦截“此浏览器不安全”的概率
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const store = path.join(app.getPath('userData'), 'accounts.json');
let accounts = [];      // [{id, name, url}]
let activeId = null;
const views = new Map(); // id -> WebContentsView
let win, sidebar;

function load() {
  try { const d = JSON.parse(fs.readFileSync(store, 'utf8')); accounts = d.accounts || []; activeId = d.activeId; } catch { accounts = []; }
}
function save() { fs.writeFileSync(store, JSON.stringify({ accounts, activeId }, null, 2)); }

function partitionOf(id) { return `persist:hark-${id}`; }

function getView(acc) {
  if (views.has(acc.id)) return views.get(acc.id);
  const ses = session.fromPartition(partitionOf(acc.id));
  ses.setUserAgent(UA);
  const v = new WebContentsView({ webPreferences: { partition: partitionOf(acc.id), contextIsolation: true } });
  v.webContents.setUserAgent(UA);
  // Google OAuth 等弹窗留在同一会话内，其他外链用系统浏览器打开
  v.webContents.setWindowOpenHandler(({ url }) => {
    if (/accounts\.google\.com|hark\.com|appleid\.apple\.com|login\.microsoftonline\.com/.test(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, webPreferences: { partition: partitionOf(acc.id) } } };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  v.webContents.on('page-title-updated', () => pushState());
  v.webContents.loadURL(acc.url || DEFAULT_URL);
  views.set(acc.id, v);
  return v;
}

function layout() {
  const [w, h] = win.getContentSize();
  sidebar.setBounds({ x: 0, y: 0, width: SIDEBAR_W, height: h });
  for (const [id, v] of views) {
    v.setBounds(id === activeId ? { x: SIDEBAR_W, y: 0, width: w - SIDEBAR_W, height: h } : { x: 0, y: 0, width: 0, height: 0 });
  }
}

function activate(id) {
  const acc = accounts.find(a => a.id === id);
  if (!acc) return;
  activeId = id;
  const v = getView(acc);
  if (!win.contentView.children.includes(v)) win.contentView.addChildView(v);
  layout(); save(); pushState();
  v.webContents.focus();
}

function pushState() {
  sidebar?.webContents.send('state', { accounts, activeId });
}

ipcMain.handle('add', (_e, { name, url }) => {
  const acc = { id: Date.now().toString(36), name: name || `Hark ${accounts.length + 1}`, url: url || DEFAULT_URL };
  accounts.push(acc); save(); activate(acc.id); return acc;
});
ipcMain.handle('switch', (_e, id) => activate(id));
ipcMain.handle('rename', (_e, { id, name }) => { const a = accounts.find(x => x.id === id); if (a) { a.name = name; save(); pushState(); } });
ipcMain.handle('reload', (_e, id) => views.get(id)?.webContents.reload());
ipcMain.handle('remove', async (_e, id) => {
  const v = views.get(id);
  if (v) { win.contentView.removeChildView(v); v.webContents.close(); views.delete(id); }
  await session.fromPartition(partitionOf(id)).clearStorageData(); // 删除账号时一并清除其登录态
  accounts = accounts.filter(a => a.id !== id);
  if (activeId === id) activeId = accounts[0]?.id || null;
  save();
  if (activeId) activate(activeId); else { layout(); pushState(); }
});
ipcMain.handle('getState', () => ({ accounts, activeId }));

app.whenReady().then(() => {
  load();
  Menu.setApplicationMenu(null);
  win = new BaseWindow({ width: 1320, height: 860, title: 'Hark Cockpit' });
  sidebar = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true } });
  win.contentView.addChildView(sidebar);
  sidebar.webContents.loadFile(path.join(__dirname, 'sidebar.html'));
  win.on('resize', layout);
  win.on('maximize', layout); win.on('unmaximize', layout);
  layout();
  sidebar.webContents.once('did-finish-load', () => {
    if (activeId && accounts.some(a => a.id === activeId)) activate(activeId);
    else if (accounts[0]) activate(accounts[0].id);
    pushState();
  });
});
// 远程更新：由 bootstrap.js 从 GitHub 拉取新版界面/逻辑代码，点击后重启生效
const boot = global.__cockpitBoot || {};
function setupUpdater() {
  const send = (s) => sidebar?.webContents.send('update', s);
  boot.onReady = (v) => send({ state: 'ready', version: v });
  if (boot.pending) send({ state: 'ready', version: boot.pending });
  sidebar.webContents.on('did-finish-load', () => { if (boot.pending) send({ state: 'ready', version: boot.pending }); });
  boot.check?.();
  setInterval(() => boot.check?.(), 30 * 60 * 1000);
}
ipcMain.handle('installUpdate', () => { app.relaunch(); app.exit(0); });
ipcMain.handle('checkUpdate', async () => (boot.check ? await boot.check() : null));
ipcMain.handle('version', () => boot.version || app.getVersion());
app.whenReady().then(() => setTimeout(setupUpdater, 1500));

// ===== 浏览器登录导入桥（配合 Hark Cockpit Chrome 插件）=====
const BRIDGE_PORT = 47321;
function toast(msg) { sidebar?.webContents.send('toast', msg); }
async function importCookies(accId, cookies) {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) throw new Error('账号不存在');
  const ses = session.fromPartition(partitionOf(acc.id));
  let ok = 0;
  for (const c of cookies || []) {
    try {
      const host = String(c.domain || '').replace(/^\./, '');
      if (!/(^|\.)hark\.com$/.test(host)) continue;
      const d = { url: `https://${host}${c.path || '/'}`, name: c.name, value: c.value, path: c.path || '/',
        secure: !!c.secure, httpOnly: !!c.httpOnly };
      if (!c.hostOnly && !c.name.startsWith('__Host-')) d.domain = c.domain;
      if (c.expirationDate) d.expirationDate = c.expirationDate;
      if (c.sameSite && ['unspecified','no_restriction','lax','strict'].includes(c.sameSite)) d.sameSite = c.sameSite;
      await ses.cookies.set(d); ok++;
    } catch (e) { /* 跳过个别无法写入的 cookie */ }
  }
  await ses.cookies.flushStore();
  return ok;
}
function startBridge() {
  const srv = http.createServer((req, res) => {
    const origin = req.headers.origin || '';
    if (origin && !/^(chrome-extension|moz-extension|extension):\/\//.test(origin)) { res.writeHead(403); return res.end(); }
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method === 'GET' && req.url === '/accounts') return json(200, { accounts: accounts.map(a => ({ id: a.id, name: a.name })), activeId });
    if (req.method === 'POST' && req.url === '/import') {
      let body = ''; req.on('data', d => { body += d; if (body.length > 2e6) req.destroy(); });
      req.on('end', async () => {
        try {
          const { accountId, cookies, newName, silent } = JSON.parse(body || '{}');
          let id = accountId;
          if (!id || id === '__new__') { const acc = { id: Date.now().toString(36), name: newName || `Hark ${accounts.length + 1}`, url: DEFAULT_URL }; accounts.push(acc); save(); id = acc.id; }
          const n = await importCookies(id, cookies);
          const acc = accounts.find(a => a.id === id);
          const v = views.get(id);
          if (v && !silent) v.webContents.loadURL(acc.url || DEFAULT_URL);
          if (!silent) { activate(id); win.show(); win.focus(); toast(`已从浏览器导入「${acc.name}」的登录`); }
          pushState();
          json(200, { ok: true, count: n, accountId: id });
        } catch (e) { json(400, { ok: false, error: String(e.message || e) }); }
      });
      return;
    }
    json(404, { ok: false });
  });
  srv.on('error', () => toast('导入服务启动失败：端口 47321 被占用'));
  srv.listen(BRIDGE_PORT, '127.0.0.1');
}
app.whenReady().then(startBridge);
app.on('window-all-closed', () => app.quit());
