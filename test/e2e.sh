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

console.log('---');
console.log('e2e: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
NODEEOF
