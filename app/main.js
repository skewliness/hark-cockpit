// Hark Cockpit: 每个 Hark 账号一个独立的持久化会话（cookie/登录态互不干扰），侧栏一键切换。
const { app, BaseWindow, WebContentsView, ipcMain, session, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const SIDEBAR_W = 264;
const TOOLBAR_H = 52;
const DEFAULT_URL = 'https://app.hark.com';
// 去掉 Electron 标识，降低 Google 登录拦截“此浏览器不安全”的概率
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const store = path.join(app.getPath('userData'), 'accounts.json');
let accounts = [];      // [{id, name, url}]
let activeId = null;
const views = new Map(); // id -> WebContentsView
let win, sidebar, home, toolbar;
let showHome = false;

function load() {
  try { const d = JSON.parse(fs.readFileSync(store, 'utf8')); accounts = d.accounts || []; activeId = d.activeId; } catch { accounts = []; }
}
function save() { fs.writeFileSync(store, JSON.stringify({ accounts, activeId }, null, 2)); }

function partitionOf(id) { return `persist:hark-${id}`; }

function getView(acc) {
  if (views.has(acc.id)) return views.get(acc.id);
  const ses = session.fromPartition(partitionOf(acc.id));
  ses.setUserAgent(UA);
  const v = new WebContentsView({ webPreferences: { partition: partitionOf(acc.id), contextIsolation: true, backgroundThrottling: false } });
  v.setVisible(false);
  win.contentView.addChildView(v);
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
  v.webContents.on('did-finish-load', () => pushState());
  v.webContents.on('did-navigate-in-page', () => pushState());
  watchUsage(acc, v.webContents);
  v.webContents.loadURL(acc.url || DEFAULT_URL);
  views.set(acc.id, v);
  return v;
}

function layout() {
  const [w, h] = win.getContentSize();
  sidebar.setBounds({ x: 0, y: 0, width: SIDEBAR_W, height: h });
  toolbar?.setBounds({ x: SIDEBAR_W, y: 0, width: Math.max(0, w - SIDEBAR_W), height: TOOLBAR_H });
  const main = { x: SIDEBAR_W, y: TOOLBAR_H, width: Math.max(0, w - SIDEBAR_W), height: Math.max(0, h - TOOLBAR_H) }, hidden = { x: 0, y: 0, width: 0, height: 0 };
  // 所有账号窗口始终保持同样大小，切换时只改可见性：不触发页面重排，切换几乎是瞬间的
  if (home) { home.setBounds(main); home.setVisible(!!showHome); }
  for (const [id, v] of views) { v.setBounds(main); v.setVisible(!showHome && id === activeId); }
}

function activate(id) {
  const acc = accounts.find(a => a.id === id);
  if (!acc) return;
  activeId = id; showHome = false;
  const v = getView(acc);
  layout(); v.webContents.focus();
  setImmediate(() => { save(); pushState(); });
}

function showOverview() { showHome = true; layout(); pushState(); home?.webContents.focus(); }

// 登录状态：分区里存在 hark.com 的 session cookie 即视为已登录
const loginState = {};
async function refreshStatus() {
  await Promise.all(accounts.map(async a => {
    try {
      const cs = await session.fromPartition(partitionOf(a.id)).cookies.get({});
      loginState[a.id] = cs.some(c => /(^|\.)hark\.com$/.test(c.domain.replace(/^\./, '')) && /session/i.test(c.name));
    } catch { loginState[a.id] = false; }
  }));
}
function snapshot() { return { accounts: accounts.map(a => ({ ...a, loggedIn: !!loginState[a.id], usage: usage[a.id] || null })), activeId, showHome, usageReady: !!usageCfg.url }; }
let pushT;
function pushState() {
  clearTimeout(pushT);
  pushT = setTimeout(async () => {
    await refreshStatus();
    const s = snapshot();
    const v = views.get(activeId);
    s.canBack = !!v?.webContents.navigationHistory?.canGoBack(); s.canForward = !!v?.webContents.navigationHistory?.canGoForward();
    s.maximized = !!win?.isMaximized();
    for (const x of [sidebar, home, toolbar]) x?.webContents.send('state', s);
  }, 60);
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
  if (activeId) activate(activeId); else showOverview();
});
ipcMain.handle('getState', async () => { await refreshStatus(); return snapshot(); });
ipcMain.handle('home', () => showOverview());
ipcMain.handle('win', (_e, act) => {
  if (act === 'close') win.close();
  else if (act === 'min') win.minimize();
  else if (act === 'max') win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.handle('nav', (_e, dir) => {
  const h = views.get(activeId)?.webContents.navigationHistory; if (!h) return;
  if (dir === 'back' && h.canGoBack()) h.goBack(); if (dir === 'forward' && h.canGoForward()) h.goForward();
});

app.whenReady().then(() => {
  load();
  Menu.setApplicationMenu(null);
  win = new BaseWindow({ width: 1360, height: 880, minWidth: 900, minHeight: 600, title: 'Hark Tools', backgroundColor: '#222A31', titleBarStyle: 'hidden', titleBarOverlay: { color: '#222A31', symbolColor: '#ECE6DB', height: 51 } });
  sidebar = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true } });
  win.contentView.addChildView(sidebar);
  sidebar.webContents.loadFile(path.join(__dirname, 'sidebar.html'));
  toolbar = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true } });
  win.contentView.addChildView(toolbar);
  toolbar.webContents.loadFile(path.join(__dirname, 'toolbar.html'));
  home = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true } });
  win.contentView.addChildView(home);
  home.webContents.loadFile(path.join(__dirname, 'overview.html'));
  for (const wc of [sidebar.webContents, home.webContents, toolbar.webContents]) wc.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('resize', layout);
  win.on('maximize', () => { layout(); pushState(); }); win.on('unmaximize', () => { layout(); pushState(); });
  layout();
  sidebar.webContents.once('did-finish-load', () => {
    if (activeId && accounts.some(a => a.id === activeId)) activate(activeId);
    else showOverview();
    pushState();
    // 后台预加载其他已登录账号，第一次切过去也不用等页面加载
    setTimeout(async () => {
      await refreshStatus();
      const rest = accounts.filter(x => x.id !== activeId && loginState[x.id] && !views.has(x.id));
      rest.forEach((x, i) => setTimeout(() => { getView(x); layout(); }, i * 1500));
    }, 2500);
  });
});

// ===== 额度检测 =====
// Hark 没有公开的额度接口。做法：在任一账号里打开“设置 → 账单”时，监听该页面的网络响应，
// 找到含有额度字段（percent_used / used+limit / resets_at）的 JSON 接口并记住它；
// 之后用每个账号自己的会话定时请求同一个接口，得到各账号的额度。
const usageStore = path.join(app.getPath('userData'), 'usage.json');
let usageCfg = {}; // { url, method, headers, body }
const usage = {};  // id -> { at, buckets:[{key,label,pct,used,limit,resets}], error }
// v1.3.9：从诊断文件确认，额度来自 GET /api/billing/summary 的 meters.harkTokens
const USAGE_URL = 'https://app.hark.com/api/billing/summary';
usageCfg = { url: USAGE_URL, method: 'GET', headers: { accept: 'application/json' }, body: null };
function parseHark(j) {
  const m = j && j.meters && j.meters.harkTokens; if (!m) return null;
  const b = (key, used, limit, resets) => ({ key, label: LABELS[key], used: num(used), limit: num(limit), resets: resets || null,
    pct: num(limit) ? Math.max(0, Math.min(100, Math.round(num(used) / num(limit) * 1000) / 10)) : null });
  const out = [b('pool', m.poolUsed, m.poolLimit, m.poolResetsAt), b('daily', m.dailyUsed, m.dailyLimit, m.dailyResetsAt)].filter(x => x.limit);
  if (!out.length && j.plan && j.plan.unlimited) return [{ key: 'pool', label: '不限额度', pct: 0, used: null, limit: null, resets: null }];
  return out;
}
const LABELS = { pool: '本期总额度', monthly: '本月额度', month: '本月额度', daily: '今日额度', day: '今日额度', weekly: '本周额度', week: '本周额度', tokens: '额度', credits: '额度', usage: '额度' };
function num(v) { const n = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(n) ? n : null; }
function parseUsage(obj) {
  const h = parseHark(obj); if (h) return h;
  const out = [];
  const walk = (o, key, depth) => {
    if (!o || typeof o !== 'object' || depth > 6) return;
    if (Array.isArray(o)) { o.forEach((x, i) => walk(x, key + i, depth + 1)); return; }
    const k = Object.keys(o);
    const pick = (...names) => { for (const n of names) { const f = k.find(x => x.toLowerCase().replace(/[_-]/g, '') === n); if (f != null && o[f] != null) return o[f]; } return null; };
    let pct = num(pick('percentused', 'usedpercent', 'percentage', 'percent', 'usagepercent'));
    const used = num(pick('used', 'consumed', 'spent', 'usedtokens', 'tokensused', 'usedcredits'));
    const limit = num(pick('limit', 'total', 'quota', 'max', 'allowance', 'totaltokens', 'tokenlimit', 'creditlimit'));
    const remaining = num(pick('remaining', 'left', 'available'));
    const resets = pick('resetsat', 'resetat', 'resetsAt', 'periodend', 'renewsat', 'nextreset');
    if (pct == null && used != null && limit) pct = used / limit * 100;
    if (pct == null && remaining != null && limit) pct = (limit - remaining) / limit * 100;
    if (pct != null && pct <= 1 && pct > 0 && used == null && /ratio|fraction/i.test(k.join())) pct *= 100;
    if (pct != null || (used != null && limit != null)) {
      const lk = String(key || '').toLowerCase();
      out.push({ key: lk, label: LABELS[lk] || (lk ? lk : '额度'), pct: pct == null ? null : Math.max(0, Math.min(100, Math.round(pct * 10) / 10)),
        used, limit: limit ?? (remaining != null && used != null ? used + remaining : null), resets: resets || null });
      return;
    }
    for (const x of k) walk(o[x], x, depth + 1);
  };
  walk(obj, '', 0);
  return out;
}
const SKIP_HEADERS = /^(cookie|host|content-length|accept-encoding|connection|origin|referer|sec-|user-agent|:)/i;
function watchUsage(acc, wc) {
  try { wc.debugger.attach('1.3'); } catch { return; }
  const reqs = new Map();
  wc.debugger.sendCommand('Network.enable').catch(() => {});
  wc.debugger.on('message', async (_e, method, p) => {
    if (method === 'Network.requestWillBeSent') reqs.set(p.requestId, p.request);
    if (method === 'Network.webSocketCreated' || method === 'Network.eventSourceMessageReceived' || method === 'Network.webSocketFrameReceived') diagWs(method, p);
    if (method !== 'Network.responseReceived') return;
    const r = p.response;
    if (!/hark\.com/.test(r.url)) return;
    if (!/json/i.test(r.mimeType || '') || r.status !== 200) { diagAdd({ t: Date.now(), url: r.url.split('?')[0], status: r.status, type: r.mimeType }); return; }
    if (usageCfg.url && r.url.split('?')[0] !== usageCfg.url.split('?')[0] && !/usage|billing|quota|limit|plan|credit|subscription/i.test(r.url)) { diagAdd({ t: Date.now(), url: r.url.split('?')[0], status: r.status }); return; }
    try {
      const { body, base64Encoded } = await wc.debugger.sendCommand('Network.getResponseBody', { requestId: p.requestId });
      if (body.length > 300000) return;
      const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
      try { diagAdd({ t: Date.now(), method: (reqs.get(p.requestId) || {}).method || 'GET', url: r.url.split('?')[0], status: r.status, keys: shape(JSON.parse(text)) }); } catch {}
      if (!/percent|used|limit|quota|resets|credit/i.test(text)) return;
      const buckets = parseUsage(JSON.parse(text));
      if (!buckets.length) return;
      if (r.url.split('?')[0] !== USAGE_URL) return;
      usage[acc.id] = { at: Date.now(), buckets };
      pushState();
    } catch {}
  });
  wc.on('destroyed', () => { try { wc.debugger.detach(); } catch {} });
}

// 额度诊断：只记录 hark.com 接口的地址和字段名（不含任何内容、cookie 或令牌），用来找出额度数据从哪来
const diag = [];
function diagAdd(x) { if (/\.(js|css|png|jpg|svg|woff2?|webp|ico)$/i.test(x.url)) return; diag.push(x); if (diag.length > 600) diag.shift(); }
function shape(o, d = 0) {
  if (Array.isArray(o)) return o.length ? [shape(o[0], d + 1)] : [];
  if (o && typeof o === 'object') { if (d > 3) return '{…}'; const r = {}; for (const k of Object.keys(o).slice(0, 40)) r[k] = shape(o[k], d + 1); return r; }
  return typeof o;
}
function diagWs(method, p) {
  if (method === 'Network.webSocketCreated') return diagAdd({ t: Date.now(), ws: true, url: String(p.url).split('?')[0] });
  const data = method === 'Network.eventSourceMessageReceived' ? p.data : p.response && p.response.payloadData;
  if (!data || data.length > 100000 || !/percent|quota|limit|usage|credit|resets/i.test(data)) return;
  try { diagAdd({ t: Date.now(), stream: method.includes('eventSource') ? 'sse' : 'ws', keys: shape(JSON.parse(data)) }); } catch { diagAdd({ t: Date.now(), stream: 'text', hint: data.replace(/[A-Za-z0-9+/=_-]{24,}/g, '…').slice(0, 300) }); }
}
ipcMain.handle('exportDiag', async () => {
  let f = path.join(app.getPath('desktop'), 'hark-cockpit-diag.json');
  const data = JSON.stringify({ version: boot.version || app.getVersion(), usageCfg: usageCfg.url ? { url: usageCfg.url.split('?')[0] } : null, entries: diag }, null, 2);
  try { fs.writeFileSync(f, data); } catch { f = path.join(app.getPath('userData'), 'hark-cockpit-diag.json'); fs.writeFileSync(f, data); }
  shell.showItemInFolder(f);
  toast(`诊断文件已保存（${diag.length} 条记录），已打开所在文件夹`);
});
async function fetchUsage(acc) {
  if (!usageCfg.url) return;
  try {
    // 优先在账号自己的页面里请求（同源、带 Cloudflare 放行凭证），没有页面时再用会话直接请求
    const v = views.get(acc.id);
    if (v && !v.webContents.isDestroyed() && /^https:\/\/app\.hark\.com/.test(v.webContents.getURL())) {
      const r = await v.webContents.executeJavaScript(`fetch('/api/billing/summary',{credentials:'include',headers:{accept:'application/json'}}).then(async r=>({s:r.status,j:r.ok?await r.json():null})).catch(()=>({s:0}))`);
      if (r.s === 401) { usage[acc.id] = { at: Date.now(), buckets: [], error: '未登录' }; return; }
      if (r.j) { const buckets = parseUsage(r.j); usage[acc.id] = buckets.length ? { at: Date.now(), buckets } : { at: Date.now(), buckets: [], error: '没有额度数据' }; return; }
    }
    const ses = session.fromPartition(partitionOf(acc.id));
    const res = await ses.fetch(usageCfg.url, { method: usageCfg.method, headers: { ...usageCfg.headers, 'user-agent': UA }, body: usageCfg.method === 'GET' ? undefined : usageCfg.body, credentials: 'include' });
    if (res.status === 401) { usage[acc.id] = { at: Date.now(), buckets: [], error: '未登录' }; return; }
    if (res.status === 403) { usage[acc.id] = { ...(usage[acc.id] || {}), error: '暂时读不到，打开一次该账号即可' }; return; }
    if (!res.ok) { usage[acc.id] = { ...(usage[acc.id] || {}), error: '读取失败 ' + res.status }; return; }
    const buckets = parseUsage(await res.json());
    usage[acc.id] = buckets.length ? { at: Date.now(), buckets } : { at: Date.now(), buckets: [], error: '没有额度数据' };
  } catch (e) { usage[acc.id] = { ...(usage[acc.id] || {}), error: '网络错误' }; }
}
let polling = false;
async function pollUsage() {
  if (polling || !usageCfg.url) return; polling = true;
  try { await refreshStatus(); await Promise.all(accounts.filter(a => loginState[a.id]).map(fetchUsage)); } finally { polling = false; pushState(); }
}
ipcMain.handle('refreshUsage', () => pollUsage());
ipcMain.handle('openBilling', () => {
  const acc = accounts.find(a => a.id === activeId && loginState[a.id]) || accounts.find(a => loginState[a.id]);
  if (!acc) { toast('先登录一个账号'); return; }
  activate(acc.id);
  toast('在这个账号里聊几句、打开一下设置，再回总览导出诊断文件');
});
app.whenReady().then(() => { setTimeout(pollUsage, 4000); setInterval(pollUsage, 10 * 60 * 1000); });

// 远程更新：由 bootstrap.js 从 GitHub 拉取新版界面/逻辑代码，点击后重启生效
const boot = global.__cockpitBoot || {};
function setupUpdater() {
  const send = (s) => { for (const x of [sidebar, toolbar, home]) x?.webContents.send('update', s); };
  if (process.platform === 'win32') app.setAppUserModelId('com.hark.cockpit');
  let notified = null;
  const ready = (v) => {
    send({ state: 'ready', version: v });
    if (notified === v) return; notified = v;
    try {
      const { Notification } = require('electron');
      if (Notification.isSupported()) { const n = new Notification({ title: 'Hark Tools 有新版本', body: `v${v} 已下载好，点这里重启更新` }); n.on('click', () => { app.relaunch(); app.exit(0); }); n.show(); }
    } catch {}
  };
  boot.onReady = ready;
  for (const x of [toolbar, home]) x?.webContents.on('did-finish-load', () => { if (boot.pending) send({ state: 'ready', version: boot.pending }); });
  if (boot.pending) send({ state: 'ready', version: boot.pending });
  sidebar.webContents.on('did-finish-load', () => { if (boot.pending) send({ state: 'ready', version: boot.pending }); });
  boot.check?.();
  setInterval(() => boot.check?.(), 5 * 60 * 1000); // 每 5 分钟自动检查一次
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
