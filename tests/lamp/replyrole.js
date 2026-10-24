// 质检 u-real：replyJs 的 u（最后一个气泡是否用户本人发的）/ us（判出来源）/ bk（kind 值词表类别）在真浏览器里实跑。
// 结构按 1.3.33 真机 DOM 链：message-list > [data-transcript-row][data-entry-kind] > div > message-bubble[data-bubble-kind][data-bubble-scope] > message-text；
// 用户气泡带 data-flight-text/mask/holder，回复气泡没有。node tests/lamp/replyrole.js（需 CHROME 或 PLAYWRIGHT_BROWSERS_PATH）
const fs = require('fs'), path = require('path'), { chromium } = require('playwright-core');
const s = fs.readFileSync(path.join(__dirname, '../../app/main.js'), 'utf8');
const js = eval(s.match(/const replyJs = (`[^`]*`);/)[1]);
let pass = 0, fail = 0; const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
// o: { role, kindU, kindA, entryU, entryA, flight, align } 生成两条或三条消息，最后一条由 last 决定
const bub = (who, o) => { const user = who === 'u'; const kind = user ? o.kindU : o.kindA, entry = user ? o.entryU : o.entryA;
  const fl = user && o.flight ? ' data-flight-text="" data-flight-mask=""' : '';
  const al = o.align ? (user ? 'margin-left:auto;width:300px' : 'margin-right:auto;width:500px') : 'width:100%';
  return `<div data-transcript-row="" ${entry != null ? `data-entry-kind="${entry}"` : ''} style="width:100%"><div style="width:100%">
  <div data-testid="message-bubble" ${kind != null ? `data-bubble-kind="${kind}"` : ''} data-bubble-scope="s1" ${o.role ? `data-message-author-role="${user ? 'user' : 'assistant'}"` : ''}${fl} style="width:100%">
  ${user && o.flight ? '<span data-flight-holder=""></span>' : ''}<div data-testid="message-text" style="${al}">${user ? '追问内容' : '回复内容'}</div></div></div></div>`; };
const page = (seq, o) => `<div data-testid="message-list" style="width:800px">${seq.map(w => bub(w, o)).join('')}</div>`;
const cases = [
  ['author-role 属性', { role: 1 }, 1],
  ['bubble-kind 值 user/assistant', { kindU: 'user', kindA: 'assistant' }, 2],
  ['entry-kind 值 user-message/agent-message', { entryU: 'user-message', entryA: 'agent-message' }, 2],
  ['kind 值不在词表 + 用户气泡 data-flight-*，回复按位置', { kindU: 'k7', kindA: 'k8', flight: 1, align: 1 }, [3, 4]],
  ['kind 值不在词表、无 flight，message-text 左右位置（气泡满宽）', { kindU: 'k7', kindA: 'k8', align: 1 }, 4],
];
(async () => {
  let exe = process.env.CHROME;
  if (!exe) { const base = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(require('os').homedir(), '.cache/ms-playwright'); const d = fs.readdirSync(base).find(x => /^chromium-\d/.test(x)) || fs.readdirSync(base).find(x => /^chromium_headless_shell-\d/.test(x)); const sub = fs.readdirSync(path.join(base, d)).find(x => x.startsWith('chrome-')); exe = ['chrome.exe', 'chrome', 'headless_shell', 'chrome-headless-shell.exe', 'chrome-headless-shell'].map(n => path.join(base, d, sub, n)).find(f => fs.existsSync(f)); }
  const b = await chromium.launch({ executablePath: exe }); const p = await b.newPage();
  for (const [name, o, src] of cases) for (const [seq, want] of [[['u', 'a'], false], [['u', 'a', 'a'], false], [['u', 'a', 'u'], true]]) {
    await p.setContent(page(seq, o)); const v = JSON.parse(JSON.stringify(await p.evaluate(js)));
    const wantSrc = Array.isArray(src) ? (want ? src[0] : src[1]) : src;
    ok(`${name} 最后=${seq.join('')} → u=${v.u} us=${v.us} bk=${v.bk} n=${v.n}`, v.u === want && v.us === wantSrc && v.n === seq.length && Object.keys(v).every(k => ['n', 'len', 'u', 'us', 'bk'].includes(k)) && Number.isInteger(v.bk));
  }
  await p.setContent(page(['u', 'a'], { kindU: 'k7', kindA: 'k8' })); const v = JSON.parse(JSON.stringify(await p.evaluate(js)));
  ok(`判不出（kind 不在词表、无 flight、满宽）→ 不带 u/us，bk=9：${JSON.stringify(v)}`, !('u' in v) && !('us' in v) && v.bk === 9);
  await b.close(); console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
