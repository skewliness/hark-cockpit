// 读真机诊断，按质检「闭环所需」判定运行周期：node tests/lamp/cycle.js hark-cockpit-diag.json（PASS 退出码 0，否则 1）
// 运行周期：每个窗口主视图 / 收信视图合并成「任一视图 busy」时间线，间隔 <8s（点灯的空闲判定时长）的 busy 段并成一个周期。
// ① 周期内 live-run-pill 规则命中 ≥1；
// ② 运行结束时刻取独立的回复完成标志（lamp:'reply' state=stable 的 at，即最后一条 message-bubble 字数最后一次变化的时刻；取探针转闲后最先报出的那条，避开用户随后的新消息），不用探针自身转闲时刻；
//    结束后 ≤10s 灯灭（light on=false），且诊断在结束后至少再延续 60s、其间非预期 busy 次数 = 0（用户发新消息触发的下一次运行不算）；
// ③ 周期开始前该窗口已有 ≥60s 记录，且开始前 60s 内非预期 busy 次数 = 0（本周期由用户新消息触发时，前一周期的 busy 不算）。
// 总判：至少 1 个周期，且每个周期三条全满足，且导出时没有未结束的忙段、各窗口最后的灯为灭，才 PASS；有违反判 FAIL，只有截断判 INCOMPLETE，两者退出码均为 1。
const d = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const GAP = 8000, L = (d.lamp || []).slice().sort((a, b) => a.t - b.t);
const probes = L.filter(x => x.lamp === 'probe'), lights = L.filter(x => x.lamp === 'light'), replies = L.filter(x => x.lamp === 'reply');
const last = L.length ? L[L.length - 1].t : 0, out = [], bad = [], cut = [];
for (const acc of [...new Set(probes.map(x => x.acc))]) {
  const st = {}, tl = []; for (const p of probes.filter(x => x.acc === acc)) { st[p.view] = p.busy ? p.rule : ''; const busy = Object.values(st).some(Boolean); if (!tl.length || tl[tl.length - 1].busy !== busy) tl.push({ t: p.t, busy }); }
  const segs = []; for (let i = 0; i < tl.length; i++) if (tl[i].busy) { const s = tl[i].t, e = tl[i + 1] ? tl[i + 1].t : null; const pv = segs[segs.length - 1]; if (pv && pv.e !== null && s - pv.e < GAP) pv.e = e; else segs.push({ s, e }); }
  const first = probes.find(x => x.acc === acc).t;
  const lastLight = lights.filter(x => x.acc === acc).pop();
  if (lastLight && lastLight.on) cut.push(`窗口 ${acc} 导出时灯仍亮`);
  // 第一遍：每个周期的独立结束与灯灭
  segs.forEach((g, i) => {
    const next = segs[i + 1] ? segs[i + 1].s : Infinity;
    // 只看本周期内（到下一周期开始前）的回复记录。先取转闲后最先报出的 stable；转闲前就已稳定（pill 滞留）则取转闲前最后一条 stable。
    // 之后同一条气泡（条数 n 不变）又增长 = 回复中途停顿后继续，结束顺延到该气泡最后一次稳定；条数 n 增加 = 用户发了新消息，不算本周期。
    // 结束须在探针转闲后 30s 内，否则视为无独立结束（K13、T3）。
    const lim = Math.min(next, g.e === null ? Infinity : g.e + 30000), ge = g.e === null ? Infinity : g.e;
    const rs = replies.filter(x => x.acc === acc && x.t >= g.s && x.t < next + 6000 && (x.at || x.t) >= g.s && (x.at || x.t) < next);
    const stables = rs.filter(x => x.state === 'stable');
    let pick = stables.find(x => x.t >= ge) || stables.filter(x => x.t < ge).pop();
    if (pick) { const same = rs.filter(x => x.t > pick.t && x.n === pick.n); if (same.some(x => x.state === 'growing')) { const ls = same.filter(x => x.state === 'stable').pop(), lg = same.filter(x => x.state === 'growing').pop(); pick = ls && ls.t > lg.t ? ls : null; } }
    g.end = pick && pick.at < lim ? pick.at : null; g.n = pick ? pick.n : undefined;
    g.off = g.end === null ? null : lights.find(x => x.acc === acc && !x.on && x.t >= g.s && x.t < next);
    // 用户触发：上一周期有独立结束，且其后、本周期开始前（容许 2s）出现过气泡条数增加的增长（用户发了新消息），本周期是正常的下一次运行，不算复红
    const pv = segs[i - 1]; g.user = !!pv && pv.end !== null && replies.some(x => x.acc === acc && x.state === 'growing' && x.n > pv.n && x.t > pv.end && x.t <= g.s + 2000);
  });
  // 「非预期 busy」：不属于用户触发周期的探针命中
  const strayIn = (a, b, skipBefore) => probes.some(x => x.acc === acc && x.busy && x.t >= a && x.t < b && !segs.some(h => (h.user || (skipBefore && h.s < skipBefore.s && skipBefore.user)) && x.t >= h.s && (h.e === null || x.t <= h.e)));
  segs.forEach(g => {
    const rules = probes.filter(x => x.acc === acc && x.busy && x.t >= g.s && (g.e === null || x.t < g.e)).map(x => x.rule);
    const a1 = rules.includes('live-run-pill'), end = g.end, off = g.off, offAfter = off ? off.t - end : null;
    const a2 = g.e !== null && end !== null && !!off && offAfter >= -2000 && offAfter <= 10000 && last - end >= 60000 && !strayIn(Math.max(end, g.e) + 1, end + 60000);
    // 运行前 60s 无非预期 busy；本周期由用户新消息触发时，前一个周期的 busy 不算
    const a3 = g.s - first >= 60000 && !strayIn(g.s - 60000, g.s, g);
    const ok = a1 && a2 && a3;
    // 截断：运行前记录不足 60s、导出时仍在运行、或结束后记录不足 60s——数据不够判，不等于违反
    const trunc = !ok && (g.s - first < 60000 || g.e === null || (end !== null ? last - end : last - g.e) < 60000) && a1 && !(end !== null && off && (offAfter < -2000 || offAfter > 10000)) && !strayIn(g.s - 60000, g.s, g) && !(g.e !== null && strayIn(Math.max(end || g.e, g.e) + 1, Math.min(last, (end || g.e) + 60000)));
    if (!ok) (trunc ? cut : bad).push(`窗口 ${acc} 周期 ${new Date(g.s).toISOString()} ${trunc ? '数据截断不可判' : '未满足'}`);
    out.push({ acc, start: new Date(g.s).toISOString(), userTriggered: g.user, probeDurS: g.e ? Math.round((g.e - g.s) / 1000) : null, independentEnd: end ? new Date(end).toISOString() : null, probeLagS: end && g.e ? (g.e - end) / 1000 : null, rules: [...new Set(rules)], a1_liveRunPill: a1, a2_greenWithin10sOfReplyEnd_no60sRelapse: a2, offAfterS: offAfter === null ? null : offAfter / 1000, a3_idle60sBefore: a3, ok });
  });
}
out.forEach(r => console.log(JSON.stringify(r)));
bad.forEach(b => console.log('✗ ' + b)); cut.forEach(b => console.log('… ' + b));
const nOk = out.filter(r => r.ok).length, pass = out.length > 0 && !bad.length && !cut.length;
// PASS 退出码 0；有违反 → CYCLE FAIL 退出码 1；无违反但有截断 → CYCLE INCOMPLETE 退出码 1（同样不算通过，只区分原因）
console.log(!out.length ? 'NO RUN（诊断里没有探针命中记录）' : pass ? `CYCLE PASS（${out.length} 个周期全部满足，导出时灯已灭）` : bad.length ? `CYCLE FAIL（${bad.length} 个违反，${nOk} 个完整满足）` : `CYCLE INCOMPLETE（0 个违反，${nOk} 个完整满足，${cut.length} 处数据截断不可判）`);
process.exit(pass ? 0 : 1);
