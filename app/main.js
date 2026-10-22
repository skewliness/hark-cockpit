// Hark Cockpit: 每个 Hark 账号一个独立的持久化会话（cookie/登录态互不干扰），侧栏一键切换。
const { app, BaseWindow, WebContentsView, ipcMain, session, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const SIDEBAR_W = 264;
const TOOLBAR_H = 52;
const DEFAULT_URL = 'https://app.hark.com';
const MUSE_URL = 'https://muse.ai';
const URLS = { hark: DEFAULT_URL, muse: MUSE_URL };

function normalizeKind(kind, url) {
  const k = String(kind || '').toLowerCase();
  if (k === 'muse' || k === 'hark') return k;
  if (url && /muse\.ai/i.test(String(url))) return 'muse';
  return 'hark';
}
function urlForKind(kind) { return URLS[normalizeKind(kind)] || DEFAULT_URL; }
function isMuseAccount(a) { return normalizeKind(a && a.kind, a && a.url) === 'muse'; }
// 去掉 Electron 标识，降低 Google 登录拦截“此浏览器不安全”的概率
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const store = path.join(app.getPath('userData'), 'accounts.json');
let accounts = [];      // [{id, name, url, kind:'hark'|'muse'}]
let activeId = null;
const views = new Map(); // id -> WebContentsView
let win, sidebar, home, toolbar;
let showHome = false;

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(store, 'utf8'));
    accounts = (d.accounts || []).map(a => {
      const kind = normalizeKind(a.kind, a.url);
      return { ...a, kind, url: a.url || urlForKind(kind) };
    });
    activeId = d.activeId;
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
    if (/accounts\.google\.com|hark\.com|muse\.ai|auth\.muse\.ai|auth\.meta\.com|accountscenter\.meta\.com|facebook\.com|instagram\.com|appleid\.apple\.com|login\.microsoftonline\.com/.test(url)) {
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

// 登录状态：Hark 看 hark.com session；Muse 看 muse.ai 的 hatch_* 会话 cookie
const loginState = {};
// Muse 登录凭证：分区里 .muse.ai 的 hatch_sess / hatch_gw / hatch_vml / hatch_native_auth_device
// （实测登录后一定有 hatch_sess；仅匹配 session|sess 在部分部署会漏判）
function isMuseLoginCookie(c) {
  const host = String(c.domain || '').replace(/^\./, '');
  if (!/(^|\.)muse\.ai$/.test(host)) return false;
  const n = String(c.name || '');
  if (/^(hatch_sess|hatch_gw|hatch_vml|hatch_native_auth_device)$/i.test(n)) return true;
  // 其它 hatch_* 业务 cookie；排除 Meta/CF 噪音
  if (/^hatch_/i.test(n) && !/^(hatch_cf|hatch_theme)/i.test(n)) return true;
  return false;
}
async function refreshStatus() {
  await Promise.all(accounts.map(async a => {
    try {
      const cs = await session.fromPartition(partitionOf(a.id)).cookies.get({});
      if (isMuseAccount(a)) {
        loginState[a.id] = cs.some(isMuseLoginCookie);
      } else {
        loginState[a.id] = cs.some(c => {
          const host = c.domain.replace(/^\./, '');
          return /(^|\.)hark\.com$/.test(host) && /session/i.test(c.name);
        });
      }
    } catch { loginState[a.id] = false; }
  }));
}
function snapshot() { return { accounts: accounts.map(a => ({ ...a, loggedIn: !!loginState[a.id], usage: usage[a.id] || null, kind: normalizeKind(a.kind, a.url) })), activeId, showHome, usageReady: !!usageCfg.url || accounts.some(a => isMuseAccount(a) && loginState[a.id]), mail: mailSnapshot() }; }
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
  const k = normalizeKind(kind, url);
  const acc = {
    id: Date.now().toString(36),
    name: name || `${k === 'muse' ? 'Muse' : 'Hark'} ${accounts.filter(a => normalizeKind(a.kind, a.url) === k).length + 1}`,
    url: url || urlForKind(k),
    kind: k,
  };
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
  if (isMuseAccount(acc)) return;
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
// ===== Muse 额度：Settings → 通用 → 使用情况（Next.js server action，非公开 REST）=====
// POST https://muse.ai/  + header next-action=<deploy-specific id>
// body: [{"includeAgreement":true}]  → RSC flight 行里 subscription.usage.percentUsed / topup*
const museUsageStore = path.join(app.getPath('userData'), 'muse-usage.json');
const MUSE_ACTION_KNOWN = '4029ac5c4bd03136487d91ebde5de39c64b35229b4';
let museActionId = null;
try { museActionId = JSON.parse(fs.readFileSync(museUsageStore, 'utf8')).actionID || null; } catch {}
function saveMuseAction(id) {
  museActionId = id || null;
  try { fs.writeFileSync(museUsageStore, JSON.stringify({ actionID: museActionId, at: Date.now() }, null, 2)); } catch {}
}
function museChunkPaths(text) {
  return [...new Set((String(text).match(/static\/chunks\/[\w~.-]+\.js/g) || []).map(p => '/_next/' + p))];
}
async function museGet(ses, url, headers = {}) {
  const res = await ses.fetch(url, { headers: { 'user-agent': UA, ...headers }, credentials: 'include' });
  const text = await res.text();
  return { status: res.status, text, url: res.url };
}
async function discoverMuseAction(ses) {
  const page = await museGet(ses, MUSE_URL + '/', { accept: 'text/html' });
  if (page.status === 401 || page.status === 403 || /auth\.muse\.ai/i.test(page.url || '')) return null;
  if (page.status !== 200) throw new Error('muse page ' + page.status);
  const paths = museChunkPaths(page.text).slice(0, 96);
  let text = '';
  for (let i = 0; i < paths.length; i += 8) {
    const batch = paths.slice(i, i + 8);
    const bodies = await Promise.all(batch.map(p => museGet(ses, MUSE_URL + p, { accept: '*/*' }).then(r => r.status === 200 ? r.text : '').catch(() => '')));
    text += '\n' + bodies.join('\n');
    const module = /\.A\((\d+)\)\.then\(\(\{[^}]*Settings/.exec(text)?.[1];
    if (!module) continue;
    const loader = new RegExp(`[,{\\[]${module},\\w+=>\\{\\w+\\.v\\(\\w+=>Promise\\.all\\(\\[([^\\]]*)`).exec(text);
    if (!loader) continue;
    const settingsPaths = museChunkPaths(loader[1]).slice(0, 32);
    for (let j = 0; j < settingsPaths.length; j += 8) {
      const sb = await Promise.all(settingsPaths.slice(j, j + 8).map(p => museGet(ses, MUSE_URL + p, { accept: '*/*' }).then(r => r.status === 200 ? r.text : '').catch(() => '')));
      for (const body of sb) {
        const id = /"([0-9a-f]{40,})",[^"]{0,200}"fetchSubscriptionAction"/.exec(body)?.[1];
        if (id) return id;
      }
    }
    break;
  }
  const fallback = /"([0-9a-f]{40,})",[^"]{0,200}"fetchSubscriptionAction"/.exec(text)?.[1];
  return fallback || null;
}
async function postMuseSubscription(ses, actionID) {
  const res = await ses.fetch(MUSE_URL + '/', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'user-agent': UA,
      accept: 'text/x-component',
      'content-type': 'text/plain;charset=UTF-8',
      'next-action': actionID,
      origin: MUSE_URL,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    },
    body: JSON.stringify([{ includeAgreement: true }]),
  });
  const text = await res.text();
  return { status: res.status, text };
}
function parseMuseFlight(bodyText) {
  let sub = null;
  for (const line of String(bodyText).split('\n')) {
    try {
      const m = /^[0-9a-f]+:(\{.*\})\s*$/.exec(line);
      if (!m) continue;
      const row = JSON.parse(m[1]);
      if (row && row.success === true && row.subscription) sub = row.subscription;
    } catch {}
  }
  return sub;
}
function tokensLeftNote(label) {
  const m = /\(([^()]*词元[^()]*)\)|\(([^()]+ tokens left)\)/i.exec(label || '');
  return (m && (m[1] || m[2])) || null;
}
function pctFromLabel(label) {
  const m = /已使用\s*([\d.]+)\s*%|([\d.]+)\s*%\s*used/i.exec(label || '');
  return m ? num(m[1] || m[2]) : null;
}
function museBuckets(sub) {
  const buckets = [];
  const u = sub.usage || {};
  const pct = num(u.percentUsed);
  const resetsSec = num(u.resetsAt);
  buckets.push({
    key: 'weekly',
    label: sub.usageRowLabel || sub.tier?.name || '免费版',
    pct: pct == null ? 0 : Math.max(0, Math.min(100, pct)),
    used: null,
    limit: null,
    resets: resetsSec != null ? resetsSec * 1000 : null,
    note: sub.usageRowValueLabel || (pct != null ? `已使用 ${pct}%` : null),
  });
  const bal = num(sub.topupBalance), tot = num(sub.topupTotal);
  if (tot != null && tot > 0) {
    let tp = pctFromLabel(sub.topupRowValueLabel);
    if (tp == null && bal != null) tp = Math.max(0, Math.min(100, Math.round((tot - bal) / tot * 1000) / 10));
    buckets.push({
      key: 'topup',
      label: sub.topupRowLabel || '额外额度',
      pct: tp == null ? 0 : tp,
      used: null,
      limit: null,
      resets: null,
      note: tokensLeftNote(sub.topupRowValueLabel) || sub.topupRowValueLabel || null,
    });
  }
  return buckets;
}
async function fetchMuseUsage(acc) {
  try {
    const ses = session.fromPartition(partitionOf(acc.id));
    let actionID = museActionId || MUSE_ACTION_KNOWN;
    let res = actionID ? await postMuseSubscription(ses, actionID) : null;
    const stale = res && res.status === 404 && /server action not found/i.test(res.text);
    const signedOut = res && (res.status === 401 || res.status === 403 || /auth\.muse\.ai/i.test(res.text));
    if (!res || stale || signedOut) {
      if (stale) saveMuseAction(null);
      actionID = await discoverMuseAction(ses);
      if (!actionID) {
        usage[acc.id] = { at: Date.now(), buckets: [], error: signedOut ? '未登录' : '找不到额度接口' };
        return;
      }
      res = await postMuseSubscription(ses, actionID);
      if (res.status === 404 && /server action not found/i.test(res.text)) {
        usage[acc.id] = { at: Date.now(), buckets: [], error: '额度接口已变更' };
        return;
      }
    }
    if (res.status === 401 || res.status === 403) {
      usage[acc.id] = { at: Date.now(), buckets: [], error: '未登录' };
      return;
    }
    if (res.status !== 200) {
      usage[acc.id] = { ...(usage[acc.id] || {}), error: '读取失败 ' + res.status };
      return;
    }
    const sub = parseMuseFlight(res.text);
    if (!sub || typeof sub.usage?.percentUsed !== 'number') {
      usage[acc.id] = { at: Date.now(), buckets: [], error: '没有额度数据' };
      return;
    }
    saveMuseAction(actionID);
    usage[acc.id] = { at: Date.now(), buckets: museBuckets(sub) };
  } catch (e) {
    usage[acc.id] = { ...(usage[acc.id] || {}), error: '网络错误' };
  }
}

async function pollUsage() {
  const hasHark = !!usageCfg.url;
  const hasMuse = accounts.some(a => isMuseAccount(a));
  if (polling || (!hasHark && !hasMuse)) return; polling = true;
  try {
    await refreshStatus();
    await Promise.all(accounts.filter(a => loginState[a.id]).map(a => {
      if (isMuseAccount(a)) return fetchMuseUsage(a);
      return hasHark ? fetchUsage(a) : null;
    }));
  } finally { polling = false; pushState(); }
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
  let code; do { code = '#' + Array.from({ length: 4 }, () => ADDR_CH[Math.floor(Math.random() * ADDR_CH.length)]).join(''); } while (accounts.some(x => x.mail === code));
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
    if (!loginState[a.id] || mail.taught[a.id]) continue;
    if (!/^https:\/\/app\.hark\.com/.test(a.url || DEFAULT_URL)) continue; // 只给 Hark 窗口发说明
    if (mail.letters.some(x => x.teach && x.to === a.id && (x.status === 'queued' || x.status === 'sent'))) { mail.taught[a.id] = Date.now(); continue; }
    if (!views.has(a.id)) getView(a); // 后台加载，不切换你当前的窗口
    const wc = views.get(a.id).webContents;
    if (wc.isLoading() || !/^https:\/\/app\.hark\.com/.test(wc.getURL())) continue;
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
    if (!v || v.webContents.isDestroyed() || v.webContents.isLoading() || !/^https:\/\/app\.hark\.com/.test(v.webContents.getURL())) continue;
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
  const cands = [...document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]')].filter(e => !e.disabled && !e.readOnly && vis(e));
  const el = cands.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0]
    || [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].filter(e => !e.disabled && !e.readOnly).pop();
  if (!el) return 'no-composer';
  el.focus();
  const text = ${JSON.stringify(text)};
  let ok = false; try { ok = document.execCommand('insertText', false, text); } catch {}
  if (!ok || !(el.value ?? el.innerText).includes(text.slice(0, 20))) {
    if (el.tagName === 'TEXTAREA') { const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(el, text); el.dispatchEvent(new Event('input', { bubbles: true })); }
    else { el.textContent = text; el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' })); }
  }
  const root = el.closest('form') || el.parentElement?.parentElement?.parentElement || document;
  const findSend = () => { const btns = [...root.querySelectorAll('button')].filter(b => vis(b));
    return btns.find(b => b.type === 'submit') || btns.find(b => /send|发送|submit/i.test((b.getAttribute('aria-label') || '') + (b.title || '') + b.innerText)); };
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
      const v = getView(acc), wc = v.webContents;
      let r = 'no-composer';
      if ((L.files || []).length) {
        for (let i = 0; i < 12 && !(!wc.isLoading() && /^https:\/\/app\.hark\.com/.test(wc.getURL())); i++) await new Promise(res => setTimeout(res, 2500));
        const up = await uploadFiles(wc, L.files.map(f => f.path));
        if (!up) L.note = '附件没能上传（没找到上传入口）';
      }
      for (let i = 0; i < 24 && r === 'no-composer'; i++) {
        if (!wc.isLoading() && /^https:\/\/app\.hark\.com/.test(wc.getURL())) { try { r = await wc.executeJavaScript(COMPOSER_JS(L.teach ? protocolText(acc) : (L.raw || letterText(L))), true); } catch { r = 'no-composer'; } }
        if (r === 'no-composer') await new Promise(res => setTimeout(res, 2500));
      }
      if (r === 'no-composer') { L.status = 'failed'; L.note = loginState[acc.id] ? '没找到输入框' : '收件窗口未登录'; if (L.teach && mail.taught) { L.tries = (L.tries || 0) + 1; if (L.tries < 3) delete mail.taught[acc.id]; } }
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
  return `【Hark Tools 信箱说明，请记住】我同时开着几个 Hark 窗口，每个窗口有唯一的信箱地址，你的地址是 ${mailAddr(acc)}。通讯录：\n${directory(acc)}\n\n当我让你去和另一个窗口讨论，或你需要别的窗口配合时，用写信的方式联系它：把信放进一个代码块发出，格式如下——\n\n[[MAIL to=对方的信箱地址，例如 #ABCD]]\n主题: 一句话主题\n${PLACEHOLDER}（文字、方案、代码都可以直接写在这里）\n[[/MAIL]]\n\nHark Tools 会自动把信送到对方窗口，对方也会用同样的格式回信给你。一封信一个代码块；正文里如果要放代码，直接写，不要再嵌套代码块。内容很长（大段代码、整个文件、多个文件）时，别塞进正文：把它存成文件（txt、md、源码文件、zip 压缩包等任意格式都行），作为附件放在写信的同一条回复里，并在信里加一行「附件: 文件名1, 文件名2」，Hark Tools 会把文件一起送过去。收件人优先写信箱地址（窗口改名或调顺序时地址不变），也可以写窗口名或编号。你的身份由 Hark Tools 按发信窗口自动标注，不用自己署名。新窗口加入时，你收到的来信末尾会附最新通讯录。讨论出结论后，你来告诉我结果。收到这条只需回复「好的」，不用写信。`;
}
ipcMain.handle('mailPause', (_e, on) => { mail.paused = !!on; if (!on) mail.letters.filter(x => x.status === 'held').forEach(x => { x.status = 'queued'; x.note = ''; }); mailSave(); pushState(); deliverQueue(); });
ipcMain.handle('mailRetry', (_e, id) => { const L = mail.letters.find(x => x.id === id); if (L && L.to) { L.status = 'queued'; L.note = ''; L.at = Date.now(); mailSave(); pushState(); deliverQueue(); } });
ipcMain.handle('mailClear', () => { mail.letters = mail.letters.filter(x => x.status === 'queued'); mailSave(); pushState(); });
ipcMain.handle('mailTeach', async (_e, id) => {
  const targets = id ? accounts.filter(a => a.id === id) : accounts.filter(a => loginState[a.id]);
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
      if (!/(^|\.)hark\.com$/.test(host) && !/(^|\.)muse\.ai$/.test(host)) continue;
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
          if (!id || id === '__new__') {
            const nCount = accounts.filter(a => normalizeKind(a.kind, a.url) === k).length + 1;
            const acc = {
              id: Date.now().toString(36),
              name: newName || `${k === 'muse' ? 'Muse' : 'Hark'} ${nCount}`,
              url: urlForKind(k),
              kind: k,
            };
            accounts.push(acc); save(); id = acc.id;
          } else if (kind) {
            const existing = accounts.find(a => a.id === id);
            if (existing) {
              const nk = normalizeKind(kind, existing.url);
              if (normalizeKind(existing.kind, existing.url) !== nk) {
                existing.kind = nk;
                existing.url = urlForKind(nk);
                save();
              }
            }
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
const siteAddr = a => 'hark.' + mailAddr(a).slice(1);
function siteProtocolText(acc) {
  const A = siteAddr(acc), W = A.slice(5);
  const book = accounts.filter(a => /^https:\/\/app\.hark\.com/.test(a.url || DEFAULT_URL)).map((a, i) => `${siteAddr(a)} 「${a.name}」${a.id === acc.id ? '（就是你）' : ''}`).join('\n');
  return `【Hark Tools 信箱说明，请记住】我同时开着几个 Hark 窗口，窗口之间通过 ${SITE} 的传信接口互相写信。你的信箱地址是 ${A}。\n通讯录：\n${book}\n\n第一次使用：\ncurl -s -X POST ${SITE}/api/agent -H 'Content-Type: application/json' -d '{"name":"hark","window":"${W}"}'\n拿到的 token 存进你自己的持久目录（比如记忆或工作区文件），以后换会话也沿用，不要重新注册；丢了再用 "action":"reclaim" 取回。\n\n写信：\ncurl -s -X POST ${SITE}/api/message -H "Authorization: Bearer <你的token>" -H 'Content-Type: application/json' -d '{"to":"对方地址，如 hark.ABCD","title":"一句话主题","content":"正文，长代码、补丁、数据都可以直接放"}'\n读信：curl -s ${SITE}/api/message/<id>\n读完：curl -s -X POST ${SITE}/api/message/<id>/ack -H "Authorization: Bearer <你的token>"\n\n有人给你写信时，Hark Tools 会在这里提醒你信的 id，你去读、处理、回信即可。完整规则见 ${SITE}/notice.md。讨论出结论后，你来告诉我结果。收到这条只需回复「好的」。`;
}
async function siteGet(q) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  try { const r = await require('electron').net.fetch(SITE + q, { signal: ctl.signal }); if (!r.ok) return null; return await r.json(); } catch { return null; } finally { clearTimeout(t); }
}
async function sitePoll() {
  if (mail.paused) return;
  const fresh = mail.siteSeq == null;
  const j = await siteGet(`/api/message?to_prefix=hark.&since_seq=${fresh ? 0 : mail.siteSeq}&limit=100`);
  if (!j || typeof j.next_seq !== 'number') { // 网站还没上线窗口级地址：继续用页面抓信
    if (site.ok) { site.ok = false; pushState(); }
    return;
  }
  if (!site.ok) {
    site.ok = true;
    // 第一次切到网站信箱：给所有窗口重发一次新说明
    mail.siteTaught = mail.siteTaught || {};
    for (const a of accounts) if (loginState[a.id] && !mail.siteTaught[a.id] && /^https:\/\/app\.hark\.com/.test(a.url || DEFAULT_URL)) {
      mail.siteTaught[a.id] = Date.now();
      mail.letters.push({ id: 'p' + Date.now().toString(36) + a.id.slice(-3), at: Date.now(), from: null, fromName: 'Hark Tools', to: a.id, toName: a.name, subject: '信箱说明（网站版）', body: '', status: 'queued', note: '', teach: true, auto: true });
    }
  }
  if (fresh) { mail.siteSeq = j.next_seq; mailSave(); pushState(); deliverQueue(); return; } // 首次只记游标，不翻旧信
  // 网站把 since_seq=0 当作“只建游标”：游标停在 0（建游标时还一封信都没有）会永远收不到第一封，这里改从完整列表补
  if (mail.siteSeq === 0 && j.next_seq > 0 && !(j.messages || []).length) {
    const all = await siteGet('/api/message');
    j.messages = ((all && all.messages) || []).filter(m => Number(m.seq) > 0 && Number(m.seq) <= j.next_seq && (m.to === 'all' || m.to === 'hark' || /^hark\./.test(m.to || ''))).sort((x, y) => x.seq - y.seq);
  }
  const hark = accounts.filter(a => /^https:\/\/app\.hark\.com/.test(a.url || DEFAULT_URL));
  const ring = new Map(); // accId -> [msg]
  for (const m of j.messages || []) {
    let targets = [];
    const w = /^hark\.([A-Z]{4})$/.exec(m.to || '');
    if (w) targets = hark.filter(a => mailAddr(a) === '#' + w[1]);
    else if (m.to === 'hark' || m.to === 'all') targets = hark.filter(a => loginState[a.id]);
    targets = targets.filter(a => siteAddr(a) !== m.from); // 不提醒发信人自己
    for (const a of targets) { if (!ring.has(a.id)) ring.set(a.id, []); ring.get(a.id).push(m); }
  }
  for (const [id, ms] of ring) {
    const a = accounts.find(x => x.id === id);
    const lines = ms.map(m => `• 来自 ${m.from}${m.title ? '「' + m.title + '」' : ''}（${m.bytes || 0} 字节）\n  读取：curl -s ${SITE}/api/message/${m.id}`).join('\n');
    const raw = `📨 你有 ${ms.length} 封新信（收件地址 ${siteAddr(a)}）\n${lines}\n\n读完请 ack：curl -s -X POST ${SITE}/api/message/<id>/ack -H "Authorization: Bearer <你的token>"。需要回信就用你的 token POST ${SITE}/api/message，to 填对方地址。规则见 ${SITE}/notice.md。`;
    const L = { id: 'b' + Date.now().toString(36) + id.slice(-3), at: Date.now(), from: null, fromName: ms.length === 1 ? ms[0].from : `${ms.length} 封网站来信`, to: id, toName: a.name, subject: ms.length === 1 ? (ms[0].title || '网站来信') : ms.map(m => m.title || m.from).join('；').slice(0, 60), body: raw, raw, status: 'queued', note: '', site: true };
    mail.letters.push(L);
  }
  mail.siteSeq = j.next_seq; mailSave(); if (ring.size) { pushState(); deliverQueue(); }
}
app.whenReady().then(() => { setTimeout(() => sitePoll().catch(() => {}), 4000); setInterval(() => { sitePoll().catch(() => {}); }, 5000); });
