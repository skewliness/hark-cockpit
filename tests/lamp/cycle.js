// 读真机诊断，按质检「闭环所需」判定运行周期：node tests/lamp/cycle.js hark-cockpit-diag.json（PASS 退出码 0，否则 1）
// 运行周期：每个窗口主视图 / 收信视图合并成「任一视图 busy」时间线，间隔 <8s（点灯的空闲判定时长）的 busy 段并成一个周期。
// ① 周期内 live-run-pill 规则命中 ≥1；
// ② 运行结束时刻取独立的回复完成标志（lamp:'reply' state=stable 的 at，即最后一条 message-bubble 字数最后一次变化的时刻），不用探针自身转闲时刻；
//    结束后 ≤10s 灯灭（light on=false），且诊断在结束后至少再延续 60s、其间探针 busy 次数 = 0；
// ③ 周期开始前该窗口已有 ≥60s 记录，且开始前 60s 内探针 busy 次数 = 0。
// 总判：至少 1 个周期，且每个周期三条全满足，且导出时没有未结束的忙段、各窗口最后的灯为灭，才 PASS；有违反判 FAIL，只有截断判 INCOMPLETE，两者退出码均为 1。
const d = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const GAP = 8000, L = (d.lamp || []).slice().sort((a, b) => a.t - b.t);
const probes = L.filter(x => x.lamp === 'probe'), lights = L.filter(x => x.lamp === 'light'), replies = L.filter(x => x.lamp === 'reply');
const last = L.length ? L[L.length - 1].t : 0, out = [], bad = [], cut = [];
for (const acc of [...new Set(probes.map(x => x.acc))]) {
  const st = {}, tl = []; for (const p of probes.filter(x => x.acc === acc)) { st[p.view] = p.busy ? p.rule : ''; const busy = Object.values(st).some(Boolean); if (!tl.length || tl[tl.length - 1].busy !== busy) tl.push({ t: p.t, busy }); }
  const segs = []; for (let i = 0; i < tl.length; i++) if (tl[i].busy) { const s = tl[i].t, e = tl[i + 1] ? tl[i + 1].t : null; const pv = segs[segs.length - 1]; if (pv && pv.e !== null && s - pv.e < GAP) pv.e = e; else segs.push({ s, e }); }
  const first = probes.find(x => x.acc === acc).t, busyIn = (a, b) => probes.some(x => x.acc === acc && x.busy && x.t >= a && x.t < b);
  const lastLight = lights.filter(x => x.acc === acc).pop();
  if (lastLight && lastLight.on) cut.push(`窗口 ${acc} 导出时灯仍亮`);
  segs.forEach((g, i) => {
    const next = segs[i + 1] ? segs[i + 1].s : Infinity;
    const rules = probes.filter(x => x.acc === acc && x.busy && x.t >= g.s && (g.e === null || x.t < g.e)).map(x => x.rule);
    const a1 = rules.includes('live-run-pill');
    // 独立结束：周期开始后、下一周期开始前出现的最后一条 stable 回复记录的 at（其后不再有 growing）
    // 只看探针转闲后 30s 内的回复记录，免得把下一次运行前用户新发的消息算进本周期（pill 滞留不受影响：真实结束早于探针转闲）
    const lim = Math.min(next, g.e === null ? Infinity : g.e + 30000);
    const rs = replies.filter(x => x.acc === acc && x.t >= g.s && x.t < lim + 6000 && (x.at || x.t) >= g.s && (x.at || x.t) < lim);
    const lastStable = rs.filter(x => x.state === 'stable').pop(), growAfter = lastStable && rs.some(x => x.state === 'growing' && x.t > lastStable.t);
    const end = lastStable && !growAfter ? lastStable.at : null;
    const off = end === null ? null : lights.find(x => x.acc === acc && !x.on && x.t >= g.s && x.t < next);
    const offAfter = off ? off.t - end : null;
    const a2 = g.e !== null && end !== null && !!off && offAfter >= -2000 && offAfter <= 10000 && last - end >= 60000 && !busyIn(Math.max(end, g.e), end + 60000);
    const a3 = g.s - first >= 60000 && !busyIn(g.s - 60000, g.s);
    const ok = a1 && a2 && a3;
    // 截断：运行前记录不足 60s、导出时仍在运行、或结束后记录不足 60s——数据不够判，不等于违反
    const trunc = !ok && (g.s - first < 60000 || g.e === null || (end !== null ? last - end : last - g.e) < 60000) && a1 && !(end !== null && off && (offAfter < -2000 || offAfter > 10000)) && !busyIn(g.s - 60000, g.s) && !(g.e !== null && busyIn(Math.max(end || g.e, g.e), Math.min(last, (end || g.e) + 60000)));
    if (!ok) (trunc ? cut : bad).push(`窗口 ${acc} 周期 ${new Date(g.s).toISOString()} ${trunc ? '数据截断不可判' : '未满足'}`);
    out.push({ acc, start: new Date(g.s).toISOString(), probeDurS: g.e ? Math.round((g.e - g.s) / 1000) : null, independentEnd: end ? new Date(end).toISOString() : null, probeLagS: end && g.e ? (g.e - end) / 1000 : null, rules: [...new Set(rules)], a1_liveRunPill: a1, a2_greenWithin10sOfReplyEnd_no60sRelapse: a2, offAfterS: offAfter === null ? null : offAfter / 1000, a3_idle60sBefore: a3, ok });
  });
}
out.forEach(r => console.log(JSON.stringify(r)));
bad.forEach(b => console.log('✗ ' + b)); cut.forEach(b => console.log('… ' + b));
const nOk = out.filter(r => r.ok).length, pass = out.length > 0 && !bad.length && !cut.length;
// PASS 退出码 0；有违反 → CYCLE FAIL 退出码 1；无违反但有截断 → CYCLE INCOMPLETE 退出码 1（同样不算通过，只区分原因）
console.log(!out.length ? 'NO RUN（诊断里没有探针命中记录）' : pass ? `CYCLE PASS（${out.length} 个周期全部满足，导出时灯已灭）` : bad.length ? `CYCLE FAIL（${bad.length} 个违反，${nOk} 个完整满足）` : `CYCLE INCOMPLETE（0 个违反，${nOk} 个完整满足，${cut.length} 处数据截断不可判）`);
process.exit(pass ? 0 : 1);
