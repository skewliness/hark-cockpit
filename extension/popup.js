const acc = document.getElementById('acc'), nm = document.getElementById('nm'), go = document.getElementById('go'),
  sync = document.getElementById('sync'), msg = document.getElementById('msg');
const say = (t, cls = '') => { msg.textContent = t; msg.className = cls; };
async function load() {
  const { syncAccountId } = await chrome.storage.local.get('syncAccountId');
  try {
    const r = await (await fetch(API + '/accounts')).json();
    acc.innerHTML = '';
    for (const a of r.accounts) acc.add(new Option(a.name, a.id));
    acc.add(new Option('＋ 新建账号', '__new__'));
    acc.value = syncAccountId && r.accounts.some(a => a.id === syncAccountId) ? syncAccountId : (r.activeId || '__new__');
    sync.checked = !!syncAccountId && acc.value === syncAccountId;
    nm.style.display = acc.value === '__new__' ? '' : 'none';
    const c = await getHarkCookies();
    say(c.length ? '已检测到浏览器中的 Hark 登录' : '请先在这个浏览器登录 app.hark.com', c.length ? 'ok' : 'err');
  } catch { go.disabled = true; say('没连上 Hark Cockpit，请先打开桌面软件', 'err'); }
}
acc.onchange = async () => {
  nm.style.display = acc.value === '__new__' ? '' : 'none';
  const { syncAccountId } = await chrome.storage.local.get('syncAccountId');
  sync.checked = syncAccountId === acc.value;
};
go.onclick = async () => {
  go.disabled = true; say('导入中…');
  try {
    const j = await pushTo(acc.value, { newName: nm.value.trim() || undefined });
    if (sync.checked) await chrome.storage.local.set({ syncAccountId: j.accountId });
    say(`导入成功（${j.count} 项），已切换到桌面软件`, 'ok'); await load();
  } catch (e) { say(e.message, 'err'); }
  go.disabled = false;
};
sync.onchange = async () => {
  if (sync.checked && acc.value !== '__new__') { await chrome.storage.local.set({ syncAccountId: acc.value }); say('已开启实时同步：浏览器登录变化会自动同步到这个账号', 'ok'); }
  else if (sync.checked) { say('先导入一次，再开启实时同步', 'err'); sync.checked = false; }
  else { await chrome.storage.local.remove('syncAccountId'); say('已关闭实时同步'); }
};
load();
