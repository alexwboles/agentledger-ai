#!/bin/bash
# AgentLedger smoke tests — file presence, JS syntax, risk-engine spot checks.
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

# 1. expected files exist
for f in index.html css/style.css js/data.js js/risk.js js/app.js data/sample.json README.md test/e2e.sh; do
  [ -f "$f" ] && ok "file exists: $f" || bad "missing file: $f"
done

# 2. JS syntax valid
for f in js/data.js js/risk.js js/app.js; do
  node --check "$f" 2>/dev/null && ok "syntax ok: $f" || bad "syntax error: $f"
done

# 3. index.html wires up the scripts in order
grep -q 'js/data.js' index.html && grep -q 'js/risk.js' index.html && grep -q 'js/app.js' index.html \
  && ok "index.html loads data.js, risk.js, app.js" || bad "index.html missing script tags"

# 4. CSS has no forbidden styling (purple/blue gradients, emoji-heavy chrome)
if grep -qiE "linear-gradient\([^)]*(purple|#6|#4f|blue|#00f|violet|indigo)" css/style.css; then
  bad "css contains a suspicious purple/blue gradient"
else
  ok "css: no purple/blue gradients"
fi
grep -q "prefers-reduced-motion" css/style.css && ok "css respects prefers-reduced-motion" || bad "css missing reduced-motion"

# 5+. logic checks via node
node << 'NODEEOF'
const R = require('/home/hatch/workspace/agentledger-ai/js/risk.js');
const D = require('/home/hatch/workspace/agentledger-ai/js/data.js');
const fs = require('fs');
let pass = 0, fail = 0;
const ok  = (n) => { pass++; console.log('PASS: ' + n); };
const bad = (n) => { fail++; console.log('FAIL: ' + n); };
const byId = (id) => D.AGENTS.filter(a => a.id === id)[0];

// --- seed shape
(byId('automailer') && D.AGENTS.length === 9 && Object.keys(D.TOOLS).length === 13)
  ? ok('seed: 9 agents, 13 tools') : bad('seed shape wrong');

// --- sample.json agrees with data.js
const sample = JSON.parse(fs.readFileSync('/home/hatch/workspace/agentledger-ai/data/sample.json', 'utf8'));
(JSON.stringify(sample.agents.map(a => a.id).sort()) === JSON.stringify(D.AGENTS.map(a => a.id).sort()))
  ? ok('sample.json agent ids match data.js') : bad('sample.json out of sync with data.js');

// --- risk bands on the demo-critical agents
const am = R.computeRisk(byId('automailer'));
(am.band === 'high' && am.score >= 60) ? ok('automailer scores high (' + am.score + ')') : bad('automailer band: ' + am.band + ' ' + am.score);
const iw = R.computeRisk(byId('invoice-watcher'));
(iw.band === 'high') ? ok('invoice-watcher (shadow) scores high (' + iw.score + ')') : bad('invoice-watcher band: ' + iw.band);
const cb = R.computeRisk(byId('chatgpt-browser'));
(cb.band === 'high') ? ok('chatgpt-browser (shadow) scores high (' + cb.score + ')') : bad('chatgpt-browser band: ' + cb.band);
const cp = R.computeRisk(byId('copilot'));
(cp.band === 'low') ? ok('copilot scores low (' + cp.score + ') — healthy contrast on the map') : bad('copilot band: ' + cp.band);

// --- toxic combo fires on automailer and carries a fix
const toxic = am.factors.filter(f => f.id.indexOf('toxic-') === 0);
(toxic.length >= 1 && toxic[0].problem.length > 20 && toxic[0].fix.length > 20)
  ? ok('toxic combo detected: ' + toxic[0].label) : bad('toxic combo missed on automailer');

// --- decomposed factors always have plain-English problem + fix
const allOk = D.AGENTS.every(a => R.computeRisk(a).factors.every(f => f.problem && f.fix && f.weight > 0));
allOk ? ok('every risk factor ships problem + fix text') : bad('some factor missing problem/fix');

// --- score caps at 100
const mega = JSON.parse(JSON.stringify(byId('automailer')));
mega.registered = false; mega.tokenAgeDays = 400; mega.humanReview = false; mega.drift = true;
mega.tools.push({ tool: 'prod-postgres', perms: ['read', 'write', 'admin'] });
mega.data = ['PII', 'secrets', 'prod-db'];
const ms = R.computeRisk(mega);
(ms.score <= 100 && ms.band === 'high') ? ok('worst-case agent caps at 100 (' + ms.score + ')') : bad('score cap broken: ' + ms.score);

// --- blast radius
const b = R.blastRadius('automailer', D.AGENTS);
(b.tools.indexOf('gmail') !== -1 && b.tools.indexOf('smtp') !== -1)
  ? ok('blast: automailer reaches gmail + smtp') : bad('blast tools: ' + b.tools.join(','));
(b.agents.indexOf('n8n-triage') !== -1 && b.agents.indexOf('invoice-watcher') !== -1)
  ? ok('blast: co-accessed agents n8n-triage + invoice-watcher') : bad('blast agents: ' + b.agents.join(','));
(b.dataTypes.indexOf('PII') !== -1) ? ok('blast: PII in the blast zone') : bad('blast data missing PII');
const bq = R.blastRadius('nope', D.AGENTS);
(bq.tools.length === 0 && bq.agents.length === 0) ? ok('blast: unknown agent -> empty') : bad('blast unknown not empty');

// --- findings: BLOCK level exists, sorted block > warn > info
const findings = R.buildFindings(D.AGENTS);
const blocks = findings.filter(f => f.level === 'block');
blocks.length >= 2 ? ok(findings.length + ' findings, ' + blocks.length + ' BLOCK-level') : bad('expected >=2 BLOCK findings, got ' + blocks.length);
const order = { block: 0, warn: 1, info: 2 };
const sorted = findings.every((f, i) => i === 0 || order[findings[i-1].level] <= order[f.level]);
sorted ? ok('findings sorted BLOCK > WARN > INFO') : bad('findings not sorted');
findings.every(f => f.action && f.action.length > 10) ? ok('every finding has a recommended action') : bad('finding missing action');

// --- shadow diff
const diff = R.shadowDiff(D.AGENTS.filter(a => a.registered), D.DISCOVERY);
(diff.registeredCount === 7 && diff.foundCount === 9 && diff.shadow.length === 2)
  ? ok('shadow check: registered 7, found 9, 2 shadow (' + diff.shadow.join(', ') + ')') : bad('shadow diff: ' + JSON.stringify(diff));

// --- validation
const errs = R.validateAgent({ name: '', owner: '', purpose: '', tools: [], status: 'bogus' });
errs.length >= 4 ? ok('validateAgent rejects junk (' + errs.length + ' errors)') : bad('validation too lax: ' + errs.length);
R.validateAgent(byId('cursor')).length === 0 ? ok('validateAgent accepts a good agent') : bad('validation rejects good agent');

// --- risk colors
(R.riskColor(75) === '#e0604f' && R.riskColor(45) === '#d9a441' && R.riskColor(10) === '#4caf7d')
  ? ok('risk colors: high red / medium amber / low emerald') : bad('risk colors wrong');

console.log('NODE_PASS=' + pass + ' NODE_FAIL=' + fail);
process.exit(fail ? 1 : 0);
NODEEOF
[ $? -eq 0 ] && ok "node logic checks green" || bad "node logic checks had failures"

echo "---"
echo "smoke: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
