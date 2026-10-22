// Hark Cockpit: 每个 Hark 账号一个独立的持久化会话（cookie/登录态互不干扰），侧栏一键切换。
const { app, BaseWindow, WebContentsView, ipcMain, session, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const SIDEBAR_W = 264;
const TOOLBAR_H = 52;
const DEFAULT_URL = 'https://app.hark.com';
const URLS = { hark: DEFAULT_URL };

function normalizeKind(kind, url) {
  // Muse 已下线：历史 kind/url 一律当作无效，加载时会丢掉
  const k = String(kind || '').toLowerCase();
  if (k === 'hark') return 'hark';
  if (url && /muse\.ai/i.test(String(url))) return 'drop';
  if (k === 'muse') return 'drop';
  return 'hark';
}
function urlForKind(_kind) { return DEFAULT_URL; }
function isCollabAccount(a) { return normalizeKind(a && a.kind, a && a.url) === 'hark'; }
function siteSeries(_a) { return 'hark'; }
function collabUrlOk(url) { return /^https:\/\/app\.hark\.com/.test(url || ''); }
// 去掉 Electron 标识，降低 Google 登录拦截“此浏览器不安全”的概率
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const store = path.join(app.getPath('userData'), 'accounts.json');
let accounts = [];      // [{id, name, url, kind:'hark'}]
let activeId = null;
const views = new Map(); // id -> WebContentsView
let win, sidebar, home, toolbar;
let showHome = false;

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(store, 'utf8'));
    accounts = (d.accounts || []).map(a => {
      const kind = normalizeKind(a.kind, a.url);
      if (kind === 'drop') return null; // 丢弃已下线的 Muse 账号，不再打开 muse.ai 窗口
      return { ...a, kind: 'hark', url: a.url && !/muse\.ai/i.test(String(a.url)) ? a.url : DEFAULT_URL };
    }).filter(Boolean);
    activeId = d.activeId;
    if (activeId && !accounts.some(a => a.id === activeId)) activeId = accounts[0]?.id || null;
  } catch { accounts = []; }
}
function save() { fs.writeFileSync(store, JSON.stringify({ accounts, activeId }, null, 2)); }

// 快捷键 Ctrl/Cmd+1–9 切换账号：在主进程拦截，无论焦点在侧栏、总览还是右侧账号页都生效，可按住 Ctrl 连续切换
function hookKeys(wc) {
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt || input.shift) return;
    const m = /^(?:Digit|Numpad)([1-9])$/.exec(input.code || '');
    if (!m) return;
    const acc = accounts[+m[1] - 1];
    if (!acc) return;
    e.preventDefault();
    if (acc.id !== activeId || showHome) activate(acc.id);
  });
}

function partitionOf(id) { return `persist:hark-${id}`; }

function getView(acc) {
  if (views.has(acc.id)) return views.get(acc.id);
  const ses = session.fromPartition(partitionOf(acc.id));
  ses.setUserAgent(UA);
  const v = new WebContentsView({ webPreferences: { partition: partitionOf(acc.id), contextIsolation: true, backgroundThrottling: false } });
  v.setVisible(false);
  win.contentView.addChildView(v);
  { const [w, h] = win.getContentSize(); v.setBounds({ x: SIDEBAR_W, y: TOOLBAR_H, width: Math.max(0, w - SIDEBAR_W), height: Math.max(0, h - TOOLBAR_H) }); } // 后台窗口也要有尺寸，不然页面布局为 0，信箱找不到输入框
  v.webContents.setUserAgent(UA);
  hookKeys(v.webContents);
  // Google OAuth 等弹窗留在同一会话内，其他外链用系统浏览器打开
  v.webContents.setWindowOpenHandler(({ url }) => {
    if (dlWait.has(acc.id)) { v.webContents.downloadURL(url); return { action: 'deny' }; } // 信箱正在取附件
    if (/accounts\.google\.com|hark\.com|auth\.meta\.com|accountscenter\.meta\.com|facebook\.com|instagram\.com|appleid\.apple\.com|login\.microsoftonline\.com/.test(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, webPreferences: { partition: partitionOf(acc.id) } } };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  v.webContents.on('page-title-updated', () => pushState());
  v.webContents.on('did-finish-load', () => pushState());
  v.webContents.on('did-navigate-in-page', () => pushState());
  watchUsage(acc, v.webContents);
  hookDownloads(acc, v.webContents);
  v.webContents.loadURL(acc.url || urlForKind(acc.kind));
  views.set(acc.id, v);
  return v;
}

// —— 项目收信：信不投进「聊天」，而是投进这个账号指定的项目对话 ——
// 同一登录分区开一个隐藏页面停在项目地址，不动你正在看的页面
const inboxViews = new Map();
function isProjectUrl(url) { try { const u = new URL(url); return collabUrlOk(url) && u.pathname.replace(/\/+$/, '') !== ''; } catch { return false; } }
function inboxView(acc) {
  if (!acc.inboxUrl) return null;
  let v = inboxViews.get(acc.id);
  if (v && !v.webContents.isDestroyed()) return v;
  const v2 = new WebContentsView({ webPreferences: { partition: partitionOf(acc.id), contextIsolation: true, backgroundThrottling: false } });
  v2.setVisible(false);
  win.contentView.addChildView(v2);
  { const [w, h] = win.getContentSize(); v2.setBounds({ x: SIDEBAR_W, y: TOOLBAR_H, width: Math.max(0, w - SIDEBAR_W), height: Math.max(0, h - TOOLBAR_H) }); }
  v2.webContents.setUserAgent(UA);
  v2.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  v2.webContents.loadURL(acc.inboxUrl);
  inboxViews.set(acc.id, v2);
  return v2;
}
function dropInboxView(id) {
  const v = inboxViews.get(id); if (!v) return;
  try { win.contentView.removeChildView(v); v.webContents.close(); } catch {}
  inboxViews.delete(id);
}
// 收信目标：设了项目就投项目，否则投聊天（账号主页面）
function deliveryWc(acc) {
  const iv = inboxView(acc);
  if (iv) {
    // 页面跑偏（被跳回聊天等）时拉回项目
    const cur = iv.webContents.getURL();
    if (!iv.webContents.isLoading() && cur && collabUrlOk(cur) && !cur.startsWith(acc.inboxUrl)) iv.webContents.loadURL(acc.inboxUrl);
    return iv.webContents;
  }
  return getView(acc).webContents;
}

function layout() {
  const [w, h] = win.getContentSize();
  sidebar.setBounds({ x: 0, y: 0, width: SIDEBAR_W, height: h });
  toolbar?.setBounds({ x: SIDEBAR_W, y: 0, width: Math.max(0, w - SIDEBAR_W), height: TOOLBAR_H });
  const main = { x: SIDEBAR_W, y: TOOLBAR_H, width: Math.max(0, w - SIDEBAR_W), height: Math.max(0, h - TOOLBAR_H) }, hidden = { x: 0, y: 0, width: 0, height: 0 };
  // 所有账号窗口始终保持同样大小，切换时只改可见性：不触发页面重排，切换几乎是瞬间的
  if (home) { home.setBounds(main); home.setVisible(!!showHome); }
  for (const [id, v] of views) { v.setBounds(main); v.setVisible(!showHome && id === activeId); }
  for (const v of inboxViews.values()) { v.setBounds(main); v.setVisible(false); }
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

// 登录状态：Hark 看 hark.com session
const loginState = {};
async function refreshStatus() {
  await Promise.all(accounts.map(async a => {
    try {
      const cs = await session.fromPartition(partitionOf(a.id)).cookies.get({});
      loginState[a.id] = cs.some(c => {
        const host = c.domain.replace(/^\./, '');
        return /(^|\.)hark\.com$/.test(host) && /session/i.test(c.name);
      });
    } catch { loginState[a.id] = false; }
  }));
}
function snapshot() { return { accounts: accounts.map(a => ({ ...a, loggedIn: !!loginState[a.id], usage: usage[a.id] || null, kind: 'hark' })), activeId, showHome, usageReady: !!usageCfg.url, mail: mailSnapshot() }; }
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

ipcMain.handle('add', (_e, { name, url, kind }) => {
  if (normalizeKind(kind, url) === 'drop') return null;
  const acc = {
    id: Date.now().toString(36),
    name: name || `Hark ${accounts.length + 1}`,
    url: (url && !/muse\.ai/i.test(String(url))) ? url : DEFAULT_URL,
    kind: 'hark',
  };
  accounts.push(acc); save(); activate(acc.id); return acc;
});
ipcMain.handle('switch', (_e, id) => activate(id));
ipcMain.handle('setInbox', (_e, { id, mode }) => {
  const a = accounts.find(x => x.id === id); if (!a) return { ok: false };
  if (mode === 'chat') { delete a.inboxUrl; dropInboxView(id); save(); pushState(); toast(`信箱：${a.name} 改回在聊天收信`); return { ok: true }; }
  const url = views.get(id)?.webContents.getURL() || '';
  if (!isProjectUrl(url)) { toast(`信箱：先在「${a.name}」里打开要收信的项目，再点这个`); return { ok: false, error: 'not-project' }; }
  a.inboxUrl = url.split('#')[0]; dropInboxView(id); save(); pushState(); toast(`信箱：${a.name} 以后在这个项目里收信`);
  return { ok: true, url: a.inboxUrl };
});
ipcMain.handle('rename', (_e, { id, name }) => { const a = accounts.find(x => x.id === id); if (a) { a.name = name; save(); pushState(); } });
ipcMain.handle('reload', (_e, id) => views.get(id)?.webContents.reload());
ipcMain.handle('remove', async (_e, id) => {
  const v = views.get(id);
  if (v) { win.contentView.removeChildView(v); v.webContents.close(); views.delete(id); }
  dropInboxView(id);
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
  for (const wc of [sidebar.webContents, home.webContents, toolbar.webContents]) hookKeys(wc);
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
  try {
    await refreshStatus();
    await Promise.all(accounts.filter(a => loginState[a.id]).map(a => fetchUsage(a)));
  } finally { polling = false; pushState(); pushQuota().catch(() => {}); }
}
ipcMain.handle('refreshUsage', () => pollUsage());
ipcMain.handle('openBilling', () => {
  const acc = accounts.find(a => a.id === activeId && loginState[a.id]) || accounts.find(a => loginState[a.id]);
  if (!acc) { toast('先登录一个账号'); return; }
  activate(acc.id);
  toast('在这个账号里聊几句、打开一下设置，再回总览导出诊断文件');
});
app.whenReady().then(() => { setTimeout(pollUsage, 4000); setInterval(pollUsage, 10 * 60 * 1000); });

// ===== 信箱：窗口之间的 agent 互相写信 =====
// agent 在回复里写 [[MAIL to=窗口名]] … [[/MAIL]]（放在代码块里最稳），这里扫描到后自动投递到收件窗口的输入框并发送。
const mailStore = path.join(app.getPath('userData'), 'mail.json');
let mail = { letters: [], seen: [], paused: false };
const mailFresh = !fs.existsSync(mailStore); // 首次启用：把聊天记录里已有的信当作已处理，不重发
try { mail = { ...mail, ...JSON.parse(fs.readFileSync(mailStore, 'utf8')) }; } catch {}
const PLACEHOLDER = '这里写正文';
const pendingSeen = new Map(); // hash -> 第一次看到的扫描轮次（等内容稳定再投递）
const baselined = new Set();
let scanRound = 0, mailSaveT;
function mailSave() { clearTimeout(mailSaveT); mailSaveT = setTimeout(() => { mail.letters = mail.letters.slice(-200); mail.seen = mail.seen.slice(-2000); try { fs.writeFileSync(mailStore, JSON.stringify(mail)); } catch {} }, 300); }
function hashOf(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + s.length.toString(36); }
const norm = s => String(s).replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
// 每个窗口一个信箱地址（如 #KQZM）：由 Hark Tools 分配，全局唯一，改名、调顺序都不变；身份以「信是从哪个窗口里发出的」为准，agent 无法冒充
const ADDR_CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function mailAddr(a) {
  if (a.mail && !accounts.some(x => x !== a && x.mail === a.mail)) return a.mail;
  let code; do { code = '#' + Array.from({ length: 4 }, () => ADDR_CH[Math.floor(Math.random() * ADDR_CH.length)]).join(''); } while (code === '#TOOL' || accounts.some(x => x.mail === code));
  a.mail = code; save(); return code;
}
function accLabel(a) { const i = accounts.indexOf(a); return `窗口${i + 1}「${a.name}」${mailAddr(a)}`; }
function directory(me) { return accounts.map((a, i) => `${mailAddr(a)} 窗口${i + 1}「${a.name}」${me && a.id === me.id ? '（就是你）' : ''}`).join('\n'); }
function resolveTo(raw) {
  const t = String(raw).trim().replace(/^["'「『]|["'」』]$/g, '').trim();
  const am = /#([A-Z]{4})\b/i.exec(t); if (am) { const hit = accounts.find(a => mailAddr(a) === '#' + am[1].toUpperCase()); if (hit) return hit; }
  const m = /^(?:窗口|window\s*|#)?\s*(\d+)$/i.exec(t);
  if (m) return accounts[+m[1] - 1] || null;
  return accounts.find(a => a.name === t) || accounts.find(a => a.name.toLowerCase() === t.toLowerCase()) ||
    accounts.find(a => a.name.includes(t) || t.includes(a.name)) || null;
}
const SCAN_JS = `(() => { const t = document.body ? document.body.innerText : ''; const out = [];
  const re = /\\[\\[\\s*MAIL\\s+to\\s*[=:：]\\s*([^\\]\\n]+?)\\s*\\]\\]([\\s\\S]*?)\\[\\[\\s*\\/\\s*MAIL\\s*\\]\\]/gi; let m;
  while ((m = re.exec(t))) out.push([m[1], m[2]]); return out; })()`;
// 自动学会信箱：每个已登录窗口（包括以后新加的）第一次准备好时，自动收到一份信箱说明，只发一次
function autoTeach() {
  mail.taught = mail.taught || {};
  for (const a of accounts) {
    if (!loginState[a.id] || mail.taught[a.id] || !isCollabAccount(a)) continue;
    if (mail.letters.some(x => x.teach && x.to === a.id && (x.status === 'queued' || x.status === 'sent'))) { mail.taught[a.id] = Date.now(); continue; }
    if (!views.has(a.id)) getView(a); // 后台加载，不切换你当前的窗口
    const wc = views.get(a.id).webContents;
    if (wc.isLoading() || !collabUrlOk(wc.getURL())) continue;
    mail.taught[a.id] = Date.now();
    mail.letters.push({ id: 'p' + Date.now().toString(36) + a.id.slice(-3), at: Date.now(), from: null, fromName: 'Hark Tools', to: a.id, toName: a.name, subject: '信箱说明', body: '', status: 'queued', note: '', teach: true, auto: true });
    mailSave(); pushState(); deliverQueue();
  }
}
async function scanMail() {
  scanRound++;
  autoTeach();
  for (const a of accounts) {
    const v = views.get(a.id);
    if (!v || v.webContents.isDestroyed() || v.webContents.isLoading() || !collabUrlOk(v.webContents.getURL())) continue;
    let found; try { found = await v.webContents.executeJavaScript(SCAN_JS); } catch { continue; }
    const first = !baselined.has(a.id); baselined.add(a.id);
    for (const [to, raw] of found || []) {
      let body = norm(raw); let subject = '';
      const sm = /^(?:主题|subject)\s*[:：]\s*(.+)\n?/i.exec(body); if (sm) { subject = sm[1].trim(); body = body.slice(sm[0].length).trim(); }
      if (!body || body.includes(PLACEHOLDER)) continue;
      const h = hashOf(norm(to) + '\n' + body);
      if (mail.seen.includes(h)) continue;
      if (first && mailFresh) { mail.seen.push(h); mailSave(); continue; }
      const k = a.id + ':' + h;
      if (!pendingSeen.has(k)) { pendingSeen.set(k, scanRound); continue; } // 下一轮内容仍一致才算写完
      pendingSeen.delete(k); mail.seen.push(h);
      let files = [];
      body = body.replace(/^(?:附件|attachments?)\s*[:：]\s*(.+)$/gim, (_m, list) => { files.push(...list.split(/[,，、;；]/).map(x => x.trim().replace(/^[`"'「]|[`"'」]$/g, '')).filter(Boolean)); return ''; }).trim();
      newLetter(a, to, subject, body, files);
    }
  }
  for (const [k, r] of pendingSeen) if (scanRound - r > 3) pendingSeen.delete(k);
}
function newLetter(fromAcc, toRaw, subject, body, wantFiles = []) {
  const target = resolveTo(toRaw);
  const L = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: Date.now(), from: fromAcc.id, fromName: fromAcc.name,
    to: target ? target.id : null, toName: target ? target.name : String(toRaw).trim(), subject, body, status: 'queued', note: '', want: wantFiles, files: [] };
  if (!target) { L.status = 'failed'; L.note = '找不到收件窗口'; }
  else if (target.id === fromAcc.id) { L.status = 'failed'; L.note = '不能寄给自己'; }
  else if (mail.paused) { L.status = 'held'; L.note = '信箱已暂停'; }
  else {
    // 防死循环：同一对窗口 30 分钟内自动往来超过 16 封就停下等你
    const pair = x => [x.from, x.to].sort().join('|'), p = pair(L);
    const recent = mail.letters.filter(x => pair(x) === p && x.status === 'sent' && Date.now() - x.at < 30 * 60e3).length;
    if (recent >= 16) { L.status = 'held'; L.note = '来回太多次，已暂停，点继续'; }
  }
  mail.letters.push(L); mailSave(); pushState();
  if (L.status === 'queued' && wantFiles.length) { L.status = 'fetching'; pushState(); collectFiles(fromAcc, L).finally(() => { if (L.status === 'fetching') L.status = 'queued'; mailSave(); pushState(); deliverQueue(); }); }
  else if (L.status === 'queued') deliverQueue();
  else if (L.status === 'held') toast(`信箱：${fromAcc.name} → ${L.toName} 的信已暂停`);
}
function letterText(L) {
  const from = accounts.find(a => a.id === L.from);
  const att = (L.files || []).length ? `\n\n📎 附件（已随这条消息上传）：${L.files.map(f => f.name).join('、')}` : '';
  const miss = (L.missing || []).length ? `\n⚠️ 没取到的附件：${L.missing.join('、')}，需要的话请对方重新发。` : '';
  return `📨 信箱来信｜来自 ${from ? accLabel(from) : L.fromName}${L.subject ? '｜主题：' + L.subject : ''}\n\n${L.body}${att}${miss}\n\n——\n` +
    `（这是 Hark Tools 信箱从另一个窗口的 agent 转来的信。回信请放进一个代码块，格式：\n[[MAIL to=${from ? mailAddr(from) : L.fromName}]]\n主题: …\n附件: 文件名（可选，文件作为附件放在同一条回复里）\n${PLACEHOLDER}\n[[/MAIL]]\nHark Tools 会自动送达。讨论有结论后，由发起讨论的一方告诉用户。\n当前通讯录：\n${directory(accounts.find(a => a.id === L.to))}）`;
}
const COMPOSER_JS = text => `(async () => {
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 40 && r.height > 10 && getComputedStyle(e).visibility !== 'hidden'; };
  // Hark 多为 textarea；也兼容 contenteditable。优先可见的 textbox / contenteditable，再退回 textarea
  const sel = '[role="textbox"][contenteditable="true"], [contenteditable="true"], [contenteditable=""], textarea, [role="textbox"]';
  const cands = [...document.querySelectorAll(sel)].filter(e => !e.disabled && !e.readOnly && vis(e));
  const el = cands.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0]
    || [...document.querySelectorAll(sel)].filter(e => !e.disabled && !e.readOnly).pop();
  if (!el) return 'no-composer';
  el.focus();
  const text = ${JSON.stringify(text)};
  let ok = false; try { ok = document.execCommand('insertText', false, text); } catch {}
  const got = () => String(el.value ?? el.innerText ?? el.textContent ?? '');
  if (!ok || !got().includes(text.slice(0, Math.min(20, text.length)))) {
    if (el.tagName === 'TEXTAREA') { const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(el, text); el.dispatchEvent(new Event('input', { bubbles: true })); }
    else {
      try { document.execCommand('selectAll', false, null); } catch {}
      try { ok = document.execCommand('insertText', false, text); } catch {}
      if (!got().includes(text.slice(0, Math.min(12, text.length)))) {
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      }
    }
  }
  const root = el.closest('form') || el.parentElement?.parentElement?.parentElement || document;
  const findSend = () => { const btns = [...root.querySelectorAll('button,[role="button"]')].filter(b => vis(b));
    const label = b => ((b.getAttribute('aria-label') || '') + ' ' + (b.title || '') + ' ' + (b.innerText || '')).trim();
    return btns.find(b => b.type === 'submit') || btns.find(b => /^send$/i.test(label(b))) || btns.find(b => /send|发送|submit/i.test(label(b))); };
  for (let i = 0; i < 100; i++) { await new Promise(r => setTimeout(r, 400)); const b = findSend(); if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') { b.click(); return 'sent'; } if (!b && i > 2) break; }
  const kd = o => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, ...o }));
  kd({}); return 'enter';
})()`;
let delivering = false;
async function deliverQueue() {
  if (delivering) return; delivering = true;
  try {
    for (const L of mail.letters.filter(x => x.status === 'queued')) {
      const acc = accounts.find(a => a.id === L.to);
      if (!acc) { L.status = 'failed'; L.note = '收件窗口已删除'; continue; }
      const wc = deliveryWc(acc);
      let r = 'no-composer';
      if (!isCollabAccount(acc)) { L.status = 'failed'; L.note = '该窗口不参与信箱协同'; continue; }
      if ((L.files || []).length) {
        for (let i = 0; i < 12 && !(!wc.isLoading() && collabUrlOk(wc.getURL())); i++) await new Promise(res => setTimeout(res, 2500));
        const up = await uploadFiles(wc, L.files.map(f => f.path));
        if (!up) L.note = '附件没能上传（没找到上传入口）';
      }
      for (let i = 0; i < 24 && r === 'no-composer'; i++) {
        if (!wc.isLoading() && collabUrlOk(wc.getURL())) { try { r = await wc.executeJavaScript(COMPOSER_JS(L.teach ? protocolText(acc) : (L.raw || letterText(L))), true); } catch { r = 'no-composer'; } }
        if (r === 'no-composer') await new Promise(res => setTimeout(res, 2500));
      }
      if (r === 'no-composer') {
        L.status = 'failed';
        L.note = !loginState[acc.id] ? '收件窗口未登录' : '没找到输入框';
        if (L.teach && mail.taught) { L.tries = (L.tries || 0) + 1; if (L.tries < 3) delete mail.taught[acc.id]; }
      }
      else { L.status = 'sent'; L.sentAt = Date.now(); toast(`信箱：${L.fromName} → ${acc.name}${L.subject ? '「' + L.subject + '」' : ''}`); }
      mailSave(); pushState();
      await new Promise(res => setTimeout(res, 1500));
    }
  } finally { delivering = false; }
}
// —— 附件：从写信窗口取文件（拦截下载），再上传到收件窗口的输入框 ——
const dlWait = new Map(); // accId -> { dir, done(file) }
const hookedSes = new Set();
function hookDownloads(acc, wc) {
  const ses = wc.session; if (hookedSes.has(ses)) return; hookedSes.add(ses);
  ses.on('will-download', (_e, item) => {
    const w = dlWait.get(acc.id); if (!w) return;
    const name = (item.getFilename() || 'file').replace(/[\\/:*?"<>|]/g, '_');
    const p = path.join(w.dir, name); item.setSavePath(p);
    item.once('done', (_e2, state) => w.done(state === 'completed' ? { name, path: p, size: item.getTotalBytes() } : null));
  });
}
const FIND_FILE_JS = name => `(() => { const n = ${JSON.stringify(name)}.toLowerCase();
  const hit = s => String(s || '').toLowerCase().includes(n);
  const as = [...document.querySelectorAll('a[href]')].filter(a => hit(a.download) || hit(a.innerText) || hit(a.title) || hit(a.getAttribute('aria-label')) || hit(decodeURIComponent(a.href)));
  if (as.length) return { href: as[as.length - 1].href };
  const els = [...document.querySelectorAll('body *')].filter(e => e.children.length < 6 && hit(e.innerText) && e.innerText.length < n.length + 120 && !e.closest('pre,code'));
  const el = els[els.length - 1]; if (!el) return null;
  const c = el.closest('a,button,[role=button],[tabindex]') || el; c.scrollIntoView({ block: 'center' }); c.click(); return { clicked: true };
})()`;
async function grabFile(acc, name, dir) {
  const v = views.get(acc.id); if (!v) return null; const wc = v.webContents;
  return new Promise(async resolve => {
    let t; const done = f => { clearTimeout(t); dlWait.delete(acc.id); resolve(f); };
    dlWait.set(acc.id, { dir, done }); t = setTimeout(() => done(null), 25000);
    try { const r = await wc.executeJavaScript(FIND_FILE_JS(name), true); if (!r) return done(null); if (r.href) wc.downloadURL(r.href); }
    catch { done(null); }
  });
}
async function collectFiles(fromAcc, L) {
  const dir = path.join(app.getPath('userData'), 'mail-files', L.id); fs.mkdirSync(dir, { recursive: true });
  L.missing = [];
  for (const name of L.want) {
    const f = await grabFile(fromAcc, name, dir);
    if (f && f.size <= 100 * 1024 * 1024) L.files.push(f); else L.missing.push(name);
    pushState();
  }
  if (L.missing.length && !L.files.length) L.note = '附件没取到';
}
async function uploadFiles(wc, paths) {
  const dbg = wc.debugger;
  try { if (!dbg.isAttached()) dbg.attach('1.3'); } catch { return false; }
  try {
    const { root } = await dbg.sendCommand('DOM.getDocument', {});
    let { nodeIds } = await dbg.sendCommand('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]:not([accept^="image"])' });
    if (!nodeIds.length) ({ nodeIds } = await dbg.sendCommand('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' }));
    if (!nodeIds.length) return false;
    const nodeId = nodeIds[nodeIds.length - 1];
    for (const p of paths) { await dbg.sendCommand('DOM.setFileInputFiles', { files: [p], nodeId }); await new Promise(r => setTimeout(r, 2000)); }
    await new Promise(r => setTimeout(r, 2000));
    return true;
  } catch { return false; }
}
ipcMain.handle('mailFiles', (_e, id) => { const L = mail.letters.find(x => x.id === id); if (L && L.files && L.files[0]) shell.showItemInFolder(L.files[0].path); });
function protocolText(acc) {
  if (site.ok) return siteProtocolText(acc);
  return `【Hark Tools 信箱说明，请记住】我同时开着几个 Hark 窗口，每个窗口有唯一的信箱地址，你是 Hark，地址是 ${mailAddr(acc)}。通讯录：\n${directory(acc)}\n\n当我让你去和另一个窗口讨论，或你需要别的窗口配合时，用写信的方式联系它：把信放进一个代码块发出，格式如下——\n\n[[MAIL to=对方的信箱地址，例如 #ABCD]]\n主题: 一句话主题\n${PLACEHOLDER}（文字、方案、代码都可以直接写在这里）\n[[/MAIL]]\n\nHark Tools 会自动把信送到对方窗口，对方也会用同样的格式回信给你。一封信一个代码块；正文里如果要放代码，直接写，不要再嵌套代码块。内容很长（大段代码、整个文件、多个文件）时，别塞进正文：把它存成文件（txt、md、源码文件、zip 压缩包等任意格式都行），作为附件放在写信的同一条回复里，并在信里加一行「附件: 文件名1, 文件名2」，Hark Tools 会把文件一起送过去。收件人优先写信箱地址（窗口改名或调顺序时地址不变），也可以写窗口名或编号。你的身份由 Hark Tools 按发信窗口自动标注，不用自己署名。新窗口加入时，你收到的来信末尾会附最新通讯录。讨论出结论后，你来告诉我结果。收到这条只需回复「好的」，不用写信。`;
}
ipcMain.handle('mailPause', (_e, on) => { mail.paused = !!on; if (!on) mail.letters.filter(x => x.status === 'held').forEach(x => { x.status = 'queued'; x.note = ''; }); mailSave(); pushState(); deliverQueue(); });
ipcMain.handle('mailRetry', (_e, id) => { const L = mail.letters.find(x => x.id === id); if (L && L.to) { L.status = 'queued'; L.note = ''; L.at = Date.now(); mailSave(); pushState(); deliverQueue(); } });
ipcMain.handle('mailClear', () => { mail.letters = mail.letters.filter(x => x.status === 'queued'); mailSave(); pushState(); });
ipcMain.handle('mailTeach', async (_e, id) => {
  const targets = (id ? accounts.filter(a => a.id === id) : accounts.filter(a => loginState[a.id])).filter(isCollabAccount);
  for (const a of targets) {
    mail.taught = mail.taught || {}; mail.taught[a.id] = Date.now();
    const L = { id: 'p' + Date.now().toString(36) + a.id.slice(0, 3), at: Date.now(), from: null, fromName: 'Hark Tools', to: a.id, toName: a.name, subject: '信箱说明', body: '', status: 'queued', note: '', teach: true };
    mail.letters.push(L);
  }
  mailSave(); pushState(); deliverQueue();
});
function mailSnapshot() { return { paused: mail.paused, site: site.ok, addrs: Object.fromEntries(accounts.map(a => [a.id, mailAddr(a)])), taught: mail.taught || {}, letters: mail.letters.slice(-40).map(({ body, files, ...x }) => ({ ...x, nfiles: (files || []).length, fileNames: (files || []).map(f => f.name), preview: String(body).slice(0, 140) })) }; }
app.whenReady().then(() => setInterval(() => { scanMail().catch(() => {}); }, 3000));


// 更新公告：changelog.json 随每次发版更新；顶栏有 NEW 标记，点开在总览里看
const prefsFile = path.join(app.getPath('userData'), 'prefs.json');
let prefs = {}; try { prefs = JSON.parse(fs.readFileSync(prefsFile, 'utf8')); } catch {}
const savePrefs = () => { try { fs.writeFileSync(prefsFile, JSON.stringify(prefs)); } catch {} };
const verCmp = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
let notesCache = null;
async function loadNotes() {
  let list = []; try { list = JSON.parse(fs.readFileSync(path.join(__dirname, 'changelog.json'), 'utf8')); } catch {}
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
    const r = await (require('electron').net.fetch)('https://raw.githubusercontent.com/skewliness/hark-cockpit/main/app/changelog.json?t=' + Date.now(), { signal: ctl.signal });
    clearTimeout(t); if (r.ok) { const remote = await r.json(); const seen = new Set(remote.map(x => x.version)); list = [...remote, ...list.filter(x => !seen.has(x.version))]; }
  } catch {}
  list.sort((a, b) => verCmp(b.version, a.version));
  notesCache = list; return list;
}
function notesState() { const list = notesCache || []; const latest = list[0] ? list[0].version : null; return { list, latest, unread: !!latest && verCmp(latest, prefs.notesSeen || '0.0.0') > 0, running: boot.version || app.getVersion() }; }
function pushNotes() { const s = notesState(); for (const x of [toolbar, home]) x?.webContents.send('notes', s); }
ipcMain.handle('notes', async () => { if (!notesCache) await loadNotes(); return notesState(); });
ipcMain.handle('openNotes', async () => { if (!notesCache) await loadNotes(); showOverview(); home?.webContents.send('openNotes'); const s = notesState(); if (s.latest) { prefs.notesSeen = s.latest; savePrefs(); } pushNotes(); });
app.whenReady().then(() => { setTimeout(() => loadNotes().then(pushNotes), 5000); setInterval(() => loadNotes().then(pushNotes), 30 * 60 * 1000); });

// 远程更新：由 bootstrap.js 从 GitHub 拉取新版界面/逻辑代码，点击后重启生效
const boot = global.__cockpitBoot || {};
function setupUpdater() {
  const send = (s) => { for (const x of [sidebar, toolbar, home]) x?.webContents.send('update', s); };
  if (process.platform === 'win32') app.setAppUserModelId('com.hark.cockpit');
  let notified = null;
  const ready = (v) => {
    send({ state: 'ready', version: v }); loadNotes().then(pushNotes);
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
    if (req.method === 'GET' && req.url === '/accounts') return json(200, { accounts: accounts.map(a => ({ id: a.id, name: a.name, kind: normalizeKind(a.kind, a.url) })), activeId });
    if (req.method === 'POST' && req.url === '/import') {
      let body = ''; req.on('data', d => { body += d; if (body.length > 2e6) req.destroy(); });
      req.on('end', async () => {
        try {
          const { accountId, cookies, newName, silent, kind } = JSON.parse(body || '{}');
          let id = accountId;
          const k = normalizeKind(kind);
          if (k === 'drop') return json(400, { ok: false, error: 'Muse 已下线，请导入 Hark 账号' });
          if (!id || id === '__new__') {
            const acc = {
              id: Date.now().toString(36),
              name: newName || `Hark ${accounts.length + 1}`,
              url: DEFAULT_URL,
              kind: 'hark',
            };
            accounts.push(acc); save(); id = acc.id;
          } else if (kind) {
            const existing = accounts.find(a => a.id === id);
            if (existing) { existing.kind = 'hark'; existing.url = existing.url && !/muse\.ai/i.test(String(existing.url)) ? existing.url : DEFAULT_URL; save(); }
          }
          const n = await importCookies(id, cookies);
          const acc = accounts.find(a => a.id === id);
          const v = views.get(id);
          if (v && !silent) v.webContents.loadURL(acc.url || urlForKind(acc.kind));
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

// —— 网站信箱门铃：信放在 agent.miracleai.club，Hark Tools 只负责提醒收件窗口 ——
const SITE = 'https://agent.miracleai.club';
const site = { ok: false, checkedAt: 0 };
const siteAddr = a => siteSeries(a) + '.' + mailAddr(a).slice(1);
function siteBook(me) {
  return accounts.filter(isCollabAccount).map(a => {
    const ser = siteSeries(a);
    return `${siteAddr(a)} 「${a.name}」[${ser}]${a.id === me.id ? '（就是你）' : ''}${quotaText(a)}`;
  }).join('\n');
}
function siteProtocolText(acc) {
  const A = siteAddr(acc), ser = siteSeries(acc), W = A.slice(ser.length + 1);
  // 通讯录常驻网站（/api/quota 列出全部已登记窗口），说明里不再附整份名单和长命令
  return `agent.miracleai.club 是我自己搭的站，我的几个 Hark 窗口用它互相传信。你的地址是 ${A}。\n通讯录和各窗口额度都在网站上：curl -s "${SITE}/api/quota?series=hark"\n要用信箱时：先 POST ${SITE}/api/agent {"name":"${ser}","window":"${W}"} 拿 token 存好，写信、读信、已读的用法见 ${SITE}/notice.md。有信时我会在这里告诉你信的 id。\n收到回复「好的」就行。`;
}
function quotaTeachText(acc) {
  return `各 Hark 窗口的额度在 ${SITE}/api/quota?series=hark（today_left 为今日剩余百分比），找窗口协作时挑额度多的。收到回复「好的」就行。`;
}
// 额度共享：每个协同窗口今日/本期还剩多少，按系列发到网站 /api/quota
function quotaOf(a) {
  const u = usage[a.id]; if (!u || !u.buckets || !u.buckets.length) return { today_left: null, period_left: null, today_resets: null };
  const left = b => b && typeof b.pct === 'number' ? Math.round((100 - b.pct) * 10) / 10 : null;
  const day = u.buckets.find(b => /daily|day|今日/.test((b.key || '') + (b.label || '')));
  const week = u.buckets.find(b => /weekly|week|周/.test((b.key || '') + (b.label || '')));
  const primary = day || week || u.buckets.find(b => !/topup|额外/.test((b.key || '') + (b.label || ''))) || u.buckets[0];
  const per = u.buckets.find(b => b !== primary && !/topup|额外/.test((b.key || '') + (b.label || ''))) || (week && week !== primary ? week : null);
  const resets = primary && primary.resets != null ? (typeof primary.resets === 'number' ? new Date(primary.resets).toISOString() : String(primary.resets)) : null;
  return { today_left: left(primary), period_left: left(per || primary), today_resets: resets, read_at: u.at ? new Date(u.at).toISOString() : null };
}
function quotaText(a) {
  const q = quotaOf(a); if (q.today_left == null && q.period_left == null) return '';
  return `（今日剩 ${q.today_left ?? '?'}%，本期剩 ${q.period_left ?? '?'}%）`;
}
async function sitePost(q, body, token) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  try { const r = await require('electron').net.fetch(SITE + q, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }); return await r.json().catch(() => null); } catch { return null; } finally { clearTimeout(t); }
}
async function ensureSiteToolToken(series) {
  const key = 'siteToolToken';
  if (mail[key]) return mail[key];
  const j = await sitePost('/api/agent', { name: series || 'hark', window: 'TOOL', action: 'reclaim', note: 'Hark Tools quota publisher' });
  if (!j || !j.token) return null;
  mail[key] = j.token; mailSave(); return j.token;
}
async function pushQuota() {
  if (!site.ok) return;
  const series = 'hark';
  const token = await ensureSiteToolToken(series);
  if (token) {
    const windows = accounts.filter(isCollabAccount).map(a => ({ address: siteAddr(a), name: a.name, logged_in: !!loginState[a.id], ...quotaOf(a) }));
    const j = await sitePost('/api/quota', { windows }, token);
    if (j && j.ok === false && /token/i.test(j.error || '')) { mail.siteToolToken = null; mailSave(); }
  }
  // collabTeachVer=5：移除 Muse/Mu，网站信箱仅 hark（升级后重发说明）
  if ((mail.collabTeachVer || 0) < 5) {
    mail.collabTeachVer = 5;
    mail.siteTaught = mail.siteTaught || {};
    mail.taught = mail.taught || {};
    mail.quotaTaught = Date.now();
    for (const a of accounts) if (loginState[a.id] && isCollabAccount(a)) {
      mail.siteTaught[a.id] = Date.now();
      mail.taught[a.id] = Date.now();
      mail.letters.push({ id: 'p' + Date.now().toString(36) + a.id.slice(-3), at: Date.now(), from: null, fromName: 'Hark Tools', to: a.id, toName: a.name, subject: '信箱说明（仅 Hark）', body: '', status: 'queued', note: '', teach: true, auto: true });
      const raw = quotaTeachText(a);
      mail.letters.push({ id: 'q' + Date.now().toString(36) + a.id.slice(-3), at: Date.now(), from: null, fromName: 'Hark Tools', to: a.id, toName: a.name, subject: '额度共享说明', body: raw, raw, status: 'queued', note: '', site: true, auto: true });
    }
    mailSave(); pushState(); deliverQueue();
  }
}
async function siteGet(q) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  try { const r = await require('electron').net.fetch(SITE + q, { signal: ctl.signal }); if (!r.ok) return null; return await r.json(); } catch { return null; } finally { clearTimeout(t); }
}
async function sitePoll() {
  if (mail.paused) return;
  const fresh = mail.siteSeq == null;
  const seq = fresh ? 0 : mail.siteSeq;
  const jH = await siteGet(`/api/message?to_prefix=hark.&since_seq=${seq}&limit=100`);
  const hasH = jH && typeof jH.next_seq === 'number';
  if (!hasH) {
    if (site.ok) { site.ok = false; pushState(); }
    return;
  }
  const next = jH.next_seq;
  let messages = [...(jH.messages || [])];
  const seenId = new Set(); messages = messages.filter(m => { if (!m || !m.id || seenId.has(m.id)) return false; seenId.add(m.id); return true; }).sort((x, y) => (x.seq || 0) - (y.seq || 0));
  if (!site.ok) {
    site.ok = true; setTimeout(() => pushQuota().catch(() => {}), 1000);
    mail.siteTaught = mail.siteTaught || {};
    for (const a of accounts) if (loginState[a.id] && !mail.siteTaught[a.id] && isCollabAccount(a)) {
      mail.siteTaught[a.id] = Date.now();
      mail.letters.push({ id: 'p' + Date.now().toString(36) + a.id.slice(-3), at: Date.now(), from: null, fromName: 'Hark Tools', to: a.id, toName: a.name, subject: '信箱说明（网站版）', body: '', status: 'queued', note: '', teach: true, auto: true });
    }
  }
  if (fresh) { mail.siteSeq = next; mailSave(); pushState(); deliverQueue(); return; }
  if (mail.siteSeq === 0 && next > 0 && !messages.length) {
    const all = await siteGet('/api/message');
    messages = ((all && all.messages) || []).filter(m => Number(m.seq) > 0 && Number(m.seq) <= next && (m.to === 'all' || m.to === 'hark' || /^hark\./.test(m.to || ''))).sort((x, y) => x.seq - y.seq);
  }
  const collab = accounts.filter(isCollabAccount);
  const ring = new Map();
  for (const m of messages) {
    let targets = [];
    const wh = /^hark\.([A-Z]{4})$/.exec(m.to || '');
    if (wh) targets = collab.filter(a => mailAddr(a) === '#' + wh[1]);
    else if (m.to === 'hark') targets = collab.filter(a => loginState[a.id]);
    else if (m.to === 'all') targets = collab.filter(a => loginState[a.id]);
    // 忽略历史 mu.* / to=mu 信件：Muse 已下线
    targets = targets.filter(a => siteAddr(a) !== m.from);
    for (const a of targets) { if (!ring.has(a.id)) ring.set(a.id, []); ring.get(a.id).push(m); }
  }
  for (const [id, ms] of ring) {
    const a = accounts.find(x => x.id === id);
    const lines = ms.map(m => `• 来自 ${m.from}${m.title ? '「' + m.title + '」' : ''}（${m.bytes || 0} 字节）\n  读取：curl -s ${SITE}/api/message/${m.id}`).join('\n');
    const raw = `📨 你有 ${ms.length} 封新信（收件地址 ${siteAddr(a)}）\n${lines}\n\n读完请 ack：curl -s -X POST ${SITE}/api/message/<id>/ack -H "Authorization: Bearer <你的token>"。需要回信就用你的 token POST ${SITE}/api/message，to 填对方地址（hark.XXXX）。规则见 ${SITE}/notice.md。${quotaText(a) ? `\n你现在${quotaText(a)}；要拉别的窗口帮忙先查额度：\ncurl -s "${SITE}/api/quota?series=hark"` : ''}`;
    const L = { id: 'b' + Date.now().toString(36) + id.slice(-3), at: Date.now(), from: null, fromName: ms.length === 1 ? ms[0].from : `${ms.length} 封网站来信`, to: id, toName: a.name, subject: ms.length === 1 ? (ms[0].title || '网站来信') : ms.map(m => m.title || m.from).join('；').slice(0, 60), body: raw, raw, status: 'queued', note: '', site: true };
    mail.letters.push(L);
  }
  mail.siteSeq = next; mailSave(); if (ring.size) { pushState(); deliverQueue(); }
}
app.whenReady().then(() => { setTimeout(() => sitePoll().catch(() => {}), 4000); setInterval(() => { sitePoll().catch(() => {}); }, 5000); });

