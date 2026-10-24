// 状态灯回归用例：node tests/lamp/run.js
// 依赖：npm i --no-save playwright-core；Chromium 路径用 CHROME 环境变量指定（缺省找 ~/.cache/ms-playwright 里的 chromium）
// 夹具文件名以 -true / -false 结尾，表示期望判为工作中与否；.xfail.html 为已知未解决用例（不计失败，单独列出）；qa-b-* 为消息区底部对齐布局；real-structure-*.html 按真机诊断祖先链重建（非 outerHTML）
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
// R4 诊断不含正文：事件形状只留标识符；请求路径去掉 query、ID、非标识符片段
ok('R4 evShape drops non-id values', JSON.stringify(evShape('{"type":"我的文件 报告.pdf","event":"a b","op":"delta","你好":1,"text":"secret"}')).match(/我的|报告|你好|secret|a b/g), null);
ok('R4 evShape keeps id values', evShape('{"type":"message.delta"}').kind, 'type=message.delta');
ok('R4 evShape QA op/type values', JSON.stringify([evShape('{"op":"Tokyo/Hilton/2026-11-03"}'), evShape('{"type":"alicechen"}'), evShape('{"alicechen":1,"tokyo-trip":2}')]).match(/Tokyo|Hilton|2026-11-03|alicechen|tokyo-trip/g), null);
const lampPath = fn('lampPath');
for (const [u, w] of [['https://app.hark.com/api/messages/send?text=hello%20secret&u=me@x.com', '/api/messages/send'], ['https://app.hark.com/api/presence/sessions/e49660a8-2955-49ae-bf10-88a902b0ebb5', '/api/presence/sessions/:id'], ['https://app.hark.com/api/c/abcdefab/stream', '/api/:x/:x/stream'], ['https://app.hark.com/api/u/1234567/x', '/api/:x/:n/:x'], ['https://app.hark.com/api/f/%E6%88%91%E7%9A%84.pdf', '/api/:x/:x'],
  ['https://hark.com/api/users/alice.chen@example.com/threads', '/api/users/:x/threads'], ['https://hark.com/api/chat/k3J9xPqZ7mWv/messages', '/api/chat/:x/messages'], ['https://hark.com/api/search/%E8%88%AA%E7%8F%AD%20%E9%A6%99%E6%B8%AF', '/api/search/:x'], ['https://hark.com/api/t/550e8400-e29b-41d4-a716-446655440000/m/12345678', '/api/t/:id/m/:n'],
  ['https://app.hark.com/trpc/personalization.getPreferences', '/trpc/personalization.getPreferences'], ['https://app.hark.com/api/otlp/v1/traces', '/api/otlp/v1/traces'], ['https://app.hark.com/_mp/track/', '/_mp/track/'], ['https://app.hark.com/api/x/foo.bar', '/api/:x/:x'], ['https://hark.com/api/users/alice.chen/profile', '/api/users/:x/profile'], ['https://hark.com/api/share/MyTripToTokyo/view', '/api/share/:x/view'], ['https://hark.com/api/share/tokyo-trip-with-mom/view', '/api/share/:x/view'], ['https://hark.com/api/users/alicechen/profile', '/api/users/:x/profile'], ['https://app.hark.com/api/auth/get-session', '/api/auth/get-session'], ['https://app.hark.com/api/sky/air-quality', '/api/sky/air-quality']]) ok('R4 lampPath ' + u.slice(u.indexOf('/', 9), 70), lampPath(u), w);
{ const outs = ['https://hark.com/api/users/alice.chen@example.com/threads', 'https://hark.com/api/chat/k3J9xPqZ7mWv/messages', 'https://hark.com/api/search/%E8%88%AA%E7%8F%AD%20%E9%A6%99%E6%B8%AF', 'https://hark.com/api/t/550e8400-e29b-41d4-a716-446655440000/m/12345678'].map(lampPath).join(' ');
  ok('R4 lampPath @ / %XX / mixed alnum>=8 hits', (outs.match(/@|%[0-9A-F]{2}|(?=[^/]*\d)(?=[^/]*[a-z])[a-z0-9]{8,}/gi) || []).length, 0); }
// R5 lamp 缓冲：分类配额，心跳刷满后新到的生成通道样本仍记得下，不碰 diag 主缓冲
{ const code = src.match(/const lampLog = \[\];[^\n]*\n/)[0] + src.match(/const LAMP_QUOTA = [^\n]*\n/)[0] + src.match(/function lampAdd\(x\)[^\n]*\n/)[0] + 'let lampStreamCount = 0;' + src.match(/function lampStreamDiag\(x\)[^\n]*\n/)[0];
  const diag = [{ k: 'main' }]; const f = new Function(code + 'return { lampLog, lampAdd, lampStreamDiag };')();
  for (let n = 0; n < 200; n++) f.lampStreamDiag({ lamp: 'sse', ev: 'ping', n }); for (let n = 0; n < 120; n++) f.lampAdd({ lamp: 'dom', n });
  f.lampStreamDiag({ lamp: 'long-req', path: '/api/chat/stream', ms: 45000 });
  ok('R5 long-req recorded after saturation', f.lampLog.some(x => x.lamp === 'long-req'), true);
  ok('R5 sse kept newest 100', f.lampLog.filter(x => x.lamp === 'sse').map(x => x.n).join(), Array.from({ length: 100 }, (_, n) => n + 100).join());
  ok('R5 dom kept newest 60', f.lampLog.filter(x => x.lamp === 'dom')[0].n, 60);
  ok('R5 total bounded', f.lampLog.length <= 480, true); ok('R5 diag untouched', diag.length, 1); }
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
    await page.evaluate(() => document.querySelectorAll('.scroller, ._1rkfhlb2').forEach(s => { s.scrollTop = 1e6; }));
    const v = await page.evaluate(probe);
    // 隐私（P0）：探针返回值里不得出现页面上任何消息 / 气泡原文（只允许固定前缀）
    const texts = await page.evaluate(() => [...document.querySelectorAll('.bub, div, span, article')].filter(e => e.children.length === 0).map(e => e.textContent.trim()).filter(t => t.length > 3));
    const json = JSON.stringify(v); ok(f + ' no-text-in-diag', texts.some(t => json.includes(t)), false);
    const attrs = await page.evaluate(() => [...document.querySelectorAll('[data-testid],[data-phase]')].flatMap(e => [e.getAttribute('data-testid'), e.getAttribute('data-phase')]).filter(t => t && t.length > 1 && !/^[A-Za-z0-9_.:-]+$/.test(t)));
    ok(f + ' R4 no-attr-text-in-diag', attrs.some(t => json.includes(t)), false);
    const want = /-true(\.xfail)?\.html$/.test(f), name = f + (v.rule ? ' [' + v.rule + ']' : '') + (v.seen.length ? ' {' + v.seen.map(x => x.verdict).join(',') + '}' : '');
    if (/\.xfail\.html$/.test(f)) { v.busy === want ? (xpass++, console.log('XPASS ' + name)) : (xfail++, console.log('XFAIL ' + name + ' -> ' + v.busy + '（已知：合成 DOM 下与对立用例不可区分，待真实 Hark DOM）')); }
    else ok(name, v.busy, want);
  }
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed, ${xfail} known-fail (xfail), ${xpass} xpass`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
