const API = 'http://127.0.0.1:47321';
async function getProductCookies(kind) {
  const k = kind === 'muse' ? 'muse' : 'hark';
  const domain = k === 'muse' ? 'muse.ai' : 'hark.com';
  const all = await chrome.cookies.getAll({ domain });
  return all.filter(c => !c.name.startsWith('__cf') && c.name !== 'cf_clearance');
}
/** @deprecated use getProductCookies */
async function getHarkCookies() { return getProductCookies('hark'); }
async function pushTo(accountId, opts = {}) {
  const kind = opts.kind === 'muse' ? 'muse' : 'hark';
  const cookies = await getProductCookies(kind);
  if (!cookies.length) throw new Error(kind === 'muse' ? '浏览器里还没有登录 Muse' : '浏览器里还没有登录 Hark');
  const body = { accountId, cookies, kind, ...opts };
  delete body.kind; // re-set explicitly
  body.kind = kind;
  const r = await fetch(API + '/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || '导入失败');
  return j;
}
