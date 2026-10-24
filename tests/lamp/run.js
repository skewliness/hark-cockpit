// 状态灯回归用例：node tests/lamp/run.js
// 依赖：npm i --no-save playwright-core；Chromium 路径用 CHROME 环境变量指定（缺省找 ~/.cache/ms-playwright 里的 chromium）
// 夹具文件名以 -true / -false 结尾，表示期望判为工作中与否；.xfail.html 为已知未解决用例（不计失败，单独列出）；qa-b-* 为消息区底部对齐布局；real-*.html 是从真实 hark.com 导出的 DOM（拿到后放进来）
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../app/main.js'), 'utf8');
const i = src.indexOf('const stopJs = () => `'), j = src.indexOf('})()`;', i);
const PICK_COMPOSER = eval('`' + src.match(/const PICK_COMPOSER = `([\s\S]*?)`;/)[1] + '`');   // 与 main.js 一样按模板字符串求值
const probe = eval('`' + src.slice(i + 22, j + 4) + '`');
let fail = 0, pass = 0, xfail = 0, xpass = 0;
const ok = (name, got, want) => { const good = got === want; good ? pass++ : fail++; console.log((good ? 'PASS ' : 'FAIL ') + name + ' -> ' + got); };
// 1) 纯函数：主机名匹配、事件形状
const fn = n => eval('(' + src.match(new RegExp('const ' + n + ' = ([\\s\\S]*?);\\n'))[1] + ')');
const isHarkHost = fn('isHarkHost');
for (const [u, w] of [['https://hark.com/api/chat', true], ['https://api.hark.com/x', true], ['https://evilhark.com/x', false], ['https://x.com/?u=hark.com', false], ['https://hark.com.evil.io/', false], ['https://HARK.COM./x', true], ['bad', false]]) ok('host ' + u, isHarkHost(u), w);
const evShape = eval('(' + src.match(/function evShape\(data\) \{[\s\S]*?\n/)[0].replace('function evShape', 'function') + ')');
ok('evShape no content', JSON.stringify(evShape('{"type":"delta","text":"secret"}')).includes('secret'), false);
ok('evShape kind', evShape('{"type":"delta","text":"x"}').kind, 'type=delta');
ok('evShape non-json', evShape('ping').kind, 'non-json');
// 1b) 网络流不点灯（P1-1/2/3）：busyAt 只在 workTick 里由页面探针写入，watchUsage 里没有任何写 busyAt / working 的路径
ok('busyAt writers == 1 (workTick only)', (src.match(/busyAt = /g) || []).length, 1);
const wu = src.slice(src.indexOf('function watchUsage'), src.indexOf("wc.on('destroyed'", src.indexOf('function watchUsage')));
ok('watchUsage never touches work state', /busyAt|\.working\b|workOf\(|workPulse/.test(wu), false);
// 2) 页面探针：每个夹具在无头 Chromium 里跑一遍
(async () => {
  const { chromium } = require('playwright-core');
  let exe = process.env.CHROME;
  if (!exe) { const base = path.join(require('os').homedir(), '.cache/ms-playwright'); const d = fs.readdirSync(base).find(x => /^chromium-\d/.test(x)); const sub = fs.readdirSync(path.join(base, d)).find(x => x.startsWith('chrome-')); exe = path.join(base, d, sub, process.platform === 'win32' ? 'chrome.exe' : 'chrome'); }
  const b = await chromium.launch({ executablePath: exe }); const page = await b.newPage({ viewport: { width: 1280, height: 720 } });
  const dir = path.join(__dirname, 'fixtures');
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.html')).sort()) {
    await page.setContent('<!doctype html><body style="margin:0">' + fs.readFileSync(path.join(dir, f), 'utf8') + '</body>');
    await page.evaluate(() => document.querySelectorAll('.scroller').forEach(s => { s.scrollTop = 1e6; }));
    const v = await page.evaluate(probe);
    // 隐私（P0）：探针返回值里不得出现页面上任何消息 / 气泡原文（只允许固定前缀）
    const texts = await page.evaluate(() => [...document.querySelectorAll('.bub, div, span, article')].filter(e => e.children.length === 0).map(e => e.textContent.trim()).filter(t => t.length > 3));
    const json = JSON.stringify(v); ok(f + ' no-text-in-diag', texts.some(t => json.includes(t)), false);
    const want = /-true(\.xfail)?\.html$/.test(f), name = f + (v.rule ? ' [' + v.rule + ']' : '') + (v.seen.length ? ' {' + v.seen.map(x => x.verdict).join(',') + '}' : '');
    if (/\.xfail\.html$/.test(f)) { v.busy === want ? (xpass++, console.log('XPASS ' + name)) : (xfail++, console.log('XFAIL ' + name + ' -> ' + v.busy + '（已知：合成 DOM 下与对立用例不可区分，待真实 Hark DOM）')); }
    else ok(name, v.busy, want);
  }
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed, ${xfail} known-fail (xfail), ${xpass} xpass`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
