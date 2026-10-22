importScripts('common.js');
let timer = null;
chrome.cookies.onChanged.addListener(({ cookie }) => {
  const host = cookie.domain.replace(/^\./, '');
  const isHark = /(^|\.)hark\.com$/.test(host);
  const isMuse = /(^|\.)muse\.ai$/.test(host);
  if ((!isHark && !isMuse) || cookie.name.startsWith('__cf')) return;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const { syncAccountId, syncKind } = await chrome.storage.local.get(['syncAccountId', 'syncKind']);
    if (!syncAccountId) return;
    const kind = syncKind === 'muse' || isMuse ? (isMuse && !isHark ? 'muse' : (syncKind || 'hark')) : 'hark';
    // Only sync when cookie domain matches the bound product
    const wantMuse = (syncKind || 'hark') === 'muse';
    if (wantMuse !== isMuse) return;
    try {
      await pushTo(syncAccountId, { silent: true, kind: wantMuse ? 'muse' : 'hark' });
    } catch (e) { /* 软件没开时忽略 */ }
  }, 2000);
});
