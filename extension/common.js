const API = 'http://127.0.0.1:47321';
async function getHarkCookies() {
  const all = await chrome.cookies.getAll({ domain: 'hark.com' });
  return all.filter(c => !c.name.startsWith('__cf') && c.name !== 'cf_clearance');
}
async function pushTo(accountId, opts = {}) {
  const cookies = await getHarkCookies();
  if (!cookies.length) throw new Error('浏览器里还没有登录 Hark');
  const r = await fetch(API + '/import', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId, cookies, ...opts }) });
  const j = await r.json(); if (!j.ok) throw new Error(j.error || '导入失败'); return j;
}
