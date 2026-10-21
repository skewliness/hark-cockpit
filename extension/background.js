importScripts('common.js');
let timer = null;
chrome.cookies.onChanged.addListener(({ cookie }) => {
  if (!/(^|\.)hark\.com$/.test(cookie.domain.replace(/^\./, '')) || cookie.name.startsWith('__cf')) return;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const { syncAccountId } = await chrome.storage.local.get('syncAccountId');
    if (!syncAccountId) return;
    try { await pushTo(syncAccountId, { silent: true }); } catch (e) { /* 软件没开时忽略 */ }
  }, 2000);
});
