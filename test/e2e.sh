#!/bin/bash
# AgentLedger e2e tests — full flows against the pure risk engine
# (the browser UI in js/app.js is DOM-only; all math lives in js/risk.js).
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
node << 'NODEEOF'
const R = require('/home/hatch/workspace/agentledger-ai/js/risk.js');
const D = require('/home/hatch/workspace/agentledger-ai/js/data.js');
let pass = 0, fail = 0;
const ok  = (n) => { pass++; console.log('PASS: ' + n); };
const bad = (n) => { fail++; console.log('FAIL: ' + n); };
const clone = (o) => JSON.parse(JSON.stringify(o));
let agents = clone(D.AGENTS.filter(a => a.registered)); // registry as the app boots: 7 registered

// Flow 1: add agent -> validates clean -> appears with computed risk
const newcomer = {
  id: 'a-xyz', name: 'DeployBot', owner: 'Alex', platform: 'Custom script',
  purpose: 'Deploys the site on git push', intent: 'Deploy on push to main only.',
  drift: false, driftNote: '', status: 'sanctioned', registered: true,
  tools: [{ tool: 'github', perms: ['read', 'write'] }, { tool: 'shell', perms: ['write'] }],
  data: ['code'], humanReview: true, tokenAgeDays: 10, lastActivityDays: 0,
  costPerMonth: 0, hoursSaved: 3
};
(R.validateAgent(newcomer).length === 0) ? ok('flow1: new agent validates clean') : bad('flow1: validation failed');
agents.push(newcomer);
const nr = R.computeRisk(newcomer);
(nr.score >= 0 && nr.band) ? ok('flow1: DeployBot added, risk ' + nr.score + '/100 (' + nr.band + ')') : bad('flow1: no risk computed');

// Flow 2: compromise simulation — select a risky agent, blast radius is sane
const blast = R.blastRadius('automailer', agents);
const sel = agents.filter(a => a.id === 'automailer')[0];
const bsel = R.blastRadius(sel.id, agents);
(bsel.tools.length >= 2 && bsel.agents.length >= 1 && bsel.dataTypes.length >= 1)
  ? ok('flow2: selecting automailer -> ' + bsel.tools.length + ' tools, ' + bsel.agents.length + ' co-agents, data: ' + bsel.dataTypes.join(','))
  : bad('flow2: blast radius too small');
(blast.agents.indexOf('automailer') === -1) ? ok('flow2: agent excluded from its own blast zone') : bad('flow2: self in blast zone');

// Flow 3: toxic combination on a synthetic agent (prod-db read + slack send)
const risky = clone(newcomer);
risky.id = 'a-tox'; risky.name = 'LeakyReporter';
risky.tools = [{ tool: 'prod-postgres', perms: ['read'] }, { tool: 'slack', perms: ['send'] }];
risky.data = ['prod-db', 'PII']; risky.humanReview = false;
const tr = R.computeRisk(risky);
const prodEgress = tr.factors.filter(f => f.id === 'toxic-prod-egress');
(prodEgress.length === 1 && tr.band === 'high')
  ? ok('flow3: prod-egress toxic combo flagged, band high (' + tr.score + ')') : bad('flow3: toxic-prod-egress missed: ' + JSON.stringify(tr.factors.map(f => f.id)));
const findings = R.buildFindings([risky]);
(findings.filter(f => f.level === 'block').length >= 1)
  ? ok('flow3: toxic combo surfaces as BLOCK finding') : bad('flow3: no BLOCK finding');

// Flow 4: governance toggle — blocked agent still scored, still listed
const gov = clone(agents.filter(a => a.id === 'automailer')[0]);
gov.status = 'blocked';
const gr = R.computeRisk(gov);
(gr.band === 'high') ? ok('flow4: blocked automailer still scores high (' + gr.score + ') — status is a record, not a silencer') : bad('flow4: blocked agent risk changed');

// Flow 5: shadow check end-to-end — run scan, add shadows, rescan is clean
let diff = R.shadowDiff(agents, D.DISCOVERY);
(diff.shadow.length === 2) ? ok('flow5: scan finds 2 shadow agents') : bad('flow5: expected 2 shadow, got ' + diff.shadow.length);
diff.shadow.forEach(name => {
  const seed = D.AGENTS.filter(a => a.name.toLowerCase() === name.toLowerCase())[0];
  if (seed && !agents.filter(a => a.id === seed.id).length) agents.push(clone(seed));
});
(agents.length === 10) ? ok('flow5: shadows added to registry (now ' + agents.length + ' agents)') : bad('flow5: registry size ' + agents.length);
diff = R.shadowDiff(agents, D.DISCOVERY);
(diff.shadow.length === 0) ? ok('flow5: rescan after registering shadows is clean') : bad('flow5: rescan still shows shadow: ' + diff.shadow.join(','));

// Flow 6: export — audit pack contains every section and every agent
const md = R.auditMarkdown({ agents: agents }, D.HOURLY_RATE);
const sections = ['## Summary', '## Inventory', '## Risk factors', '## Findings', '## Value'];
const missing = sections.filter(s => md.indexOf(s) === -1);
const missingAgents = agents.filter(a => md.indexOf(a.name) === -1);
(missing.length === 0 && missingAgents.length === 0 && md.indexOf('does not enforce') !== -1)
  ? ok('flow6: audit pack has all sections, all ' + agents.length + ' agents, and the honest disclaimer')
  : bad('flow6: export incomplete (missing sections: ' + missing.join(',') + '; missing agents: ' + missingAgents.map(a => a.name).join(',') + ')');

// Flow 7: remove agent — findings shrink accordingly
const before = R.buildFindings(agents).filter(f => f.agentId === 'automailer').length;
agents = agents.filter(a => a.id !== 'automailer');
const after = R.buildFindings(agents).filter(f => f.agentId === 'automailer').length;
(before > 0 && after === 0) ? ok('flow7: removing automailer clears its ' + before + ' finding(s)') : bad('flow7: findings not cleared');

// Flow 8: empty estate does not crash
try {
  const e = { agents: [] };
  R.buildFindings(e.agents); R.blastRadius('x', e.agents);
  const m = R.auditMarkdown(e, 80);
  (m.indexOf('Total agents: 0') !== -1) ? ok('flow8: empty estate exports cleanly') : bad('flow8: empty export wrong');
} catch (err) { bad('flow8: threw on empty estate: ' + err.message); }


// Flow 9: review cadence — riskier agents reviewed more often, never-reviewed is due now
const hi = clone(newcomer); hi.id = 'a-hi'; hi.name = 'Hi';
hi.tools = [{ tool: 'prod-postgres', perms: ['read'] }, { tool: 'slack', perms: ['send'] },
  { tool: 'gmail', perms: ['read', 'send'] }];
hi.humanReview = false;
const lo = clone(newcomer); lo.id = 'a-lo'; lo.name = 'Lo';
lo.tools = [{ tool: 'github', perms: ['read'] }]; lo.data = ['code']; lo.humanReview = true; lo.tokenAgeDays = 5;
(R.reviewCadence(hi) === 30) ? ok('flow9: high-risk agent cadence 30d') : bad('flow9 hi cadence=' + R.reviewCadence(hi));
(R.reviewCadence(lo) === 180) ? ok('flow9: low-risk agent cadence 180d') : bad('flow9 lo cadence=' + R.reviewCadence(lo));
const due9 = R.reviewsDue([hi, lo], '2026-10-12');
(due9.length === 2 && due9[0].agent.id === 'a-hi')
  ? ok('flow9: never-reviewed agents are due, riskiest first') : bad('flow9 due=' + JSON.stringify(due9.map(x => x.agent.id)));
hi.lastReviewDate = '2026-10-01';
const due9b = R.reviewsDue([hi, lo], '2026-10-12');
(due9b.length === 1 && due9b[0].agent.id === 'a-lo')
  ? ok('flow9: recently-reviewed high-risk agent drops off the due list') : bad('flow9b due=' + JSON.stringify(due9b.map(x => x.agent.id)));
(R.nextReviewISO(hi, '2026-10-12') === '2026-10-31')
  ? ok('flow9: next review = lastReview + 30d cadence') : bad('flow9 next=' + R.nextReviewISO(hi, '2026-10-12'));

// Flow 10: incident log — incidents raise the risk score, then clear
const inc = clone(newcomer); inc.id = 'a-inc'; inc.name = 'Inc';
const baseScore = R.computeRisk(inc).score;
inc.incidents = [{ date: '2026-10-01', title: 'Sent mail without approval', detail: 'test' }];
const s1 = R.computeRisk(inc);
(s1.score > baseScore && s1.factors.some(f => f.id === 'incidents'))
  ? ok('flow10: logged incident raises risk ' + baseScore + ' -> ' + s1.score) : bad('flow10: incident not factored');
inc.incidents.push({ date: '2026-10-05', title: 'Second incident', detail: '' });
const s2 = R.computeRisk(inc);
(s2.score > s1.score) ? ok('flow10: repeat incidents compound (' + s1.score + ' -> ' + s2.score + ')') : bad('flow10: no compounding');

// Flow 11: ledger backup round-trips through export/import
const json = R.exportLedger({ agents: agents });
const back = R.importLedger(json);
(back.errors.length === 0 && back.agents.length === agents.length)
  ? ok('flow11: export -> import round-trips ' + back.agents.length + ' agents cleanly') : bad('flow11: ' + JSON.stringify(back.errors));
const badImport = R.importLedger('{"agents":[{"name":"NoId"}]}');
(badImport.agents.length === 0 && badImport.errors.length === 1 && badImport.skipped === 1)
  ? ok('flow11: invalid agents rejected with errors') : bad('flow11: bad import accepted');
const notJson = R.importLedger('nope');
(notJson.errors.length === 1) ? ok('flow11: non-JSON rejected') : bad('flow11: non-JSON accepted');

// Flow 12: risk history — snapshots accumulate daily, trend reflects score changes
const th = clone(newcomer); th.id = 'a-tr'; th.name = 'TrendBot';
R.recordRiskSnapshot(th, '2026-09-13');
const scoreEarly = R.computeRisk(th).score;
th.tools.push({ tool: 'smtp', perms: ['send'] }); // riskier a month later
th.humanReview = false;
R.recordRiskSnapshot(th, '2026-10-13');
const trend = R.riskTrend(th, 30);
const scoreLate = R.computeRisk(th).score;
(trend && trend.delta === scoreLate - scoreEarly && trend.delta > 0)
  ? ok('flow12: risk trend climbs after new egress permission (' + scoreEarly + ' -> ' + scoreLate + ')')
  : bad('flow12: trend wrong: ' + JSON.stringify(trend));
const flat = clone(newcomer); flat.id = 'a-fl';
R.recordRiskSnapshot(flat, '2026-10-13');
(R.riskTrend(flat) === null)
  ? ok('flow12: single-day history has no trend yet')
  : bad('flow12: phantom trend');

// Flow 13: remediation plan — fix the heaviest factor, projected score drops
const fx = clone(newcomer); fx.id = 'a-fx'; fx.name = 'FixBot';
fx.tools = [{ tool: 'prod-postgres', perms: ['read'] }, { tool: 'slack', perms: ['send'] }];
fx.data = ['prod-db', 'PII']; fx.humanReview = false; fx.tokenAgeDays = 200;
const fp0 = R.fixPlanProgress(fx);
if (!(fp0.score >= 60 && fp0.pendingCount > 0)) throw new Error('flow13 setup: expected a high-risk agent');
const sorted = fp0.factors.slice().sort((x, y) => y.weight - x.weight);
sorted.forEach(f => R.toggleFix(fx, f.id)); // carry out everything
const fpAll = R.fixPlanProgress(fx);
(fpAll.pendingCount === 0 && fpAll.projected === 0)
  ? ok('flow13: completing all fixes projects 0/100 (from ' + fp0.score + ')')
  : bad('flow13: projected=' + fpAll.projected + ' pending=' + fpAll.pendingCount);
const pendAll = R.pendingFixes([fx]);
(pendAll.length === 0) ? ok('flow13: no pending fixes once everything is checked off') : bad('flow13: phantom pending fixes');
const fx2 = clone(newcomer); fx2.id = 'a-fx2'; fx2.name = 'FixBot2';
fx2.tools = fx.tools; fx2.data = fx.data; fx2.humanReview = false; fx2.tokenAgeDays = 200;
const pendSome = R.pendingFixes([fx2]);
(pendSome.length > 0 && pendSome.every(f => f.agentName && f.fix))
  ? ok('flow13: pending fixes list names agent + concrete fix (' + pendSome.length + ' items)')
  : bad('flow13: pendingFixes shape wrong');

console.log('---');
console.log('---');
console.log('e2e: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
NODEEOF
