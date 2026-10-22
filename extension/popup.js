const acc = document.getElementById('acc'), nm = document.getElementById('nm'), go = document.getElementById('go'),
  sync = document.getElementById('sync'), msg = document.getElementById('msg'), kinds = document.getElementById('kinds');
let kind = 'hark';
const say = (t, cls = '') => { msg.textContent = t; msg.className = cls; };
function currentKind() {
  const el = kinds.querySelector('input[name=kind]:checked');
  return el && el.value === 'muse' ? 'muse' : 'hark';
}
function setKind(k) {
  kind = k === 'muse' ? 'muse' : 'hark';
  kinds.querySelectorAll('label').forEach(l => {
    const v = l.querySelector('input').value;
    l.querySelector('input').checked = v === kind;
    l.classList.toggle('on', v === kind);
  });
}
async function load() {
  kind = currentKind();
  const stored = await chrome.storage.local.get(['syncAccountId', 'syncKind']);
  try {
    const r = await (await fetch(API + '/accounts')).json();
    acc.innerHTML = '';
    const list = (r.accounts || []).filter(a => !a.kind || a.kind === kind);
    for (const a of list) acc.add(new Option(a.name, a.id));
    acc.add(new Option('+ 新建账号', '__new__'));
    const syncId = stored.syncAccountId;
    acc.value = syncId && list.some(a => a.id === syncId) ? syncId : (list.find(a => a.id === r.activeId)?.id || '__new__');
    sync.checked = !!syncId && acc.value === syncId && (stored.syncKind || 'hark') === kind;
    nm.style.display = acc.value === '__new__' ? '' : 'none';
    nm.placeholder = kind === 'muse' ? '新 Muse 账号名称' : '新 Hark 账号名称';
    const c = await getProductCookies(kind);
    const site = kind === 'muse' ? 'muse.ai' : 'app.hark.com';
    say(c.length ? `已检测到浏览器中的 ${kind === 'muse' ? 'Muse' : 'Hark'} 登录` : `请先在这个浏览器登录 ${site}`, c.length ? 'ok' : 'err');
  } catch { go.disabled = true; say('没连上 Hark Cockpit，请先打开桌面软件', 'err'); }
}
kinds.addEventListener('change', () => { setKind(currentKind()); load(); });
acc.onchange = async () => {
  nm.style.display = acc.value === '__new__' ? '' : 'none';
  const { syncAccountId, syncKind } = await chrome.storage.local.get(['syncAccountId', 'syncKind']);
  sync.checked = syncAccountId === acc.value && (syncKind || 'hark') === kind;
};
go.onclick = async () => {
  kind = currentKind();
  go.disabled = true; say('导入中…');
  try {
    const j = await pushTo(acc.value, { newName: nm.value.trim() || undefined, kind });
    if (sync.checked) await chrome.storage.local.set({ syncAccountId: j.accountId, syncKind: kind });
    say(`导入成功（${j.count} 项），已切换到桌面软件`, 'ok'); await load();
  } catch (e) { say(e.message, 'err'); }
  go.disabled = false;
};
sync.onchange = async () => {
  kind = currentKind();
  if (sync.checked && acc.value !== '__new__') {
    await chrome.storage.local.set({ syncAccountId: acc.value, syncKind: kind });
    say('已开启实时同步：浏览器登录变化会自动同步到这个账号', 'ok');
  } else if (sync.checked) {
    say('先导入一次，再开启实时同步', 'err'); sync.checked = false;
  } else {
    await chrome.storage.local.remove(['syncAccountId', 'syncKind']);
    say('已关闭实时同步');
  }
};
(async () => {
  const stored = await chrome.storage.local.get(['syncKind']);
  if (stored.syncKind === 'muse' || stored.syncKind === 'hark') setKind(stored.syncKind);
  else setKind('hark');
  load();
})();