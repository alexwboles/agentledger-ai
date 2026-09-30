# AgentLedger — the register of agents

A free, self-hosted **agent inventory & risk register** for a solo operator. It answers the
questions enterprise tools like Reco, Zenity, Dataiku and Noma answer — *what agents do I have,
what can each one reach, how risky is it, and what should I do about it?* — without the
enterprise price tag, the cloud account, or the SSO integration.

AgentLedger **documents and scores**. It suggests what to revoke; it does not pretend to be a
firewall. Every recommendation in the UI is a suggestion for you to carry out.

## Problem

AI agents multiply quietly: a coding agent here, an n8n workflow there, a browser extension
with page access, a cron script somebody wrote six months ago. Each one holds credentials and
permissions. Nobody keeps the list — so nobody sees the blast radius when one of them is
compromised, drifts off-mission, or was never approved in the first place.

## Solution

One static page that keeps the ledger:

- **Risk map** — node-link graph: agents on the inner ring, tools/APIs/MCPs on the outer ring, colored by risk score.
- **Compromise simulation** — click any agent to light up its full blast radius: tools it can reach, agents sharing those tools, data types in the zone.
- **Decomposed risk scoring** — 0–100 dial plus factor chips, each with a plain-English *problem* and *how to fix it*.
- **Toxic-combination detection** — pairs of innocent-looking permissions that are dangerous together (e.g. *read inbox + send email + no human review*).
- **Tri-state governance** — Sanctioned / Review / Blocked, one click, big visual payoff.
- **Detail drawer** — Reach (connections), Risk factors, Data flows (taint journey: where secrets/PII enter → where they could exit), Activity & intent drift, Tests.
- **Findings feed** — BLOCK / WARN / INFO verdicts, each with a recommended action.
- **Shadow check** — simulated local discovery (MCP configs, CLI tools, browser extensions, SaaS OAuth, daemons) compared against your registered agents: *"you registered 7, we found 9."*
- **Value line** — cost/mo + hours saved → estimated operator-time value per agent.
- **Audit pack export** — one click downloads the full inventory + risk summary as Markdown.

## Run it

No build step. No dependencies. No network calls. Data persists in `localStorage`.

```bash
cd agentledger-ai
npx serve .          # then open the printed URL
# or: python3 -m http.server 8080
```

To restore the seeded demo data at any time: **Restore demo** (top right).

## Tests

```bash
bash test/smoke.sh   # file presence, JS syntax, risk-engine spot checks — 15/15 green
bash test/e2e.sh     # full flows: add agent, blast radius, toxic combos, governance, shadow check, export — 13/13 green
```

Both suites must be green before a release.

## Project structure

```
agentledger-ai/
├── index.html          # page shell: masthead, KPIs, map + findings, registry, shadow check, drawer, modal
├── css/style.css       # "Auditor's Register" theme (deep ink, parchment, amber accent)
├── js/
│   ├── data.js         # seed data: 13 tools, 9 agents, discovery sources, preset library (UMD)
│   ├── risk.js         # pure risk engine: scoring, toxic combos, blast radius, findings, export (UMD)
│   └── app.js          # browser UI: map SVG, drawer, registry CRUD, shadow flow, persistence
├── data/sample.json    # the seed dataset as portable JSON (generated from js/data.js)
├── test/
│   ├── smoke.sh
│   └── e2e.sh
└── README.md
```

`js/risk.js` is dependency-free pure logic and is `require()`-able from node, which is what
the test suites exercise. `js/app.js` is DOM-only rendering on top of it.

## Design identity

**"The Auditor's Register"** — a deep warm-ink console crossed with a bound ledger book.
Parchment type on near-black ink, serif display headings (Georgia) like register entries,
hairline rules, folio numbering ("FIG. 1", "ENTRY Nº"), and a single amber-gold accent.
Emerald marks sanctioned/low-risk, red marks blocked/high-risk — the accent never multiplies.

A dark theme was chosen deliberately: the risk map is a SOC-console artifact and reads best
on ink, while the warm amber/parchment palette keeps it an *auditor's* tool rather than a
generic dev-tool dark mode. No gradients, no emoji chrome, no boxy uniform cards — the KPI
strip reads as ledger figures, the map as a plotted chart, the registry as ruled entries.

## Honest limits

- The shadow check **simulates** discovery from a fixed list of local sources; it does not
  actually inspect your machine. Treat it as a guided checklist.
- Risk scores are heuristic weights, not a security audit.
- Changing a governance status updates the record only — you revoke the real credential yourself.
- Nothing leaves the browser. There is no server to harden because there is no server.
