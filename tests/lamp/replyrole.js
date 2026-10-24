// 质检 R2-3d/U-2：replyJs 的 u 字段（最后一个气泡是否用户本人发的）在真浏览器里实跑。node tests/lamp/replyrole.js（需 CHROME 或 PLAYWRIGHT_BROWSERS_PATH）
const fs = require('fs'), path = require('path'), { chromium } = require('playwright-core');
const s = fs.readFileSync(path.join(__dirname, '../../app/main.js'), 'utf8');
const js = eval(s.match(/const replyJs = (`[^`]*`);/)[1]);
let pass = 0, fail = 0; const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const page = (last, attr) => `<div role="log" style="width:800px;display:flex;flex-direction:column">
<div data-testid="message-bubble" ${attr ? 'data-message-author-role="user"' : ''} style="align-self:flex-end;width:300px">你好</div>
<div data-testid="message-bubble" ${attr ? 'data-message-author-role="assistant"' : ''} style="align-self:flex-start;width:500px">回复一</div>
${last === 'a2' ? `<div data-testid="message-bubble" ${attr ? 'data-message-author-role="assistant"' : ''} style="align-self:flex-start;width:500px">回复二</div>` : ''}
${last === 'u' ? `<div data-testid="message-bubble" ${attr ? 'data-message-author-role="user"' : ''} style="align-self:flex-end;width:300px">追问</div>` : ''}
</div>`;
(async () => {
  let exe = process.env.CHROME;
  if (!exe) { const base = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(require('os').homedir(), '.cache/ms-playwright'); const d = fs.readdirSync(base).find(x => /^chromium-\d/.test(x)) || fs.readdirSync(base).find(x => /^chromium_headless_shell-\d/.test(x)); const sub = fs.readdirSync(path.join(base, d)).find(x => x.startsWith('chrome-')); exe = ['chrome.exe', 'chrome', 'headless_shell', 'chrome-headless-shell.exe', 'chrome-headless-shell'].map(n => path.join(base, d, sub, n)).find(f => fs.existsSync(f)); }
  const b = await chromium.launch({ executablePath: exe }); const p = await b.newPage();
  for (const attr of [true, false]) for (const [last, want, n] of [['a', false, 2], ['a2', false, 3], ['u', true, 3]]) {
    await p.setContent(page(last, attr)); const v = await p.evaluate(js);
    ok(`${attr ? '有 author-role 属性' : '只凭左右位置'} 最后=${last} → u=${v.u} n=${v.n}，只含 n/len/u 三个数值或布尔`, v.u === want && v.n === n && Object.keys(v).sort().join() === 'len,n,u' && typeof v.len === 'number');
  }
  await p.setContent('<div role="log" style="width:800px"><div data-testid="message-bubble" style="width:800px">满宽</div></div>'); const v = await p.evaluate(js);
  ok(`判不出（满宽）→ u 不带：${JSON.stringify(v)}`, v.u === undefined && !('u' in JSON.parse(JSON.stringify(v))));
  await b.close(); console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
