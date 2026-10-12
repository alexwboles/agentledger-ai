# AgentLedger pilot — first real audit (2026-10-05)

Seed: `pilot-seed.json` (5 agents, all Alex's real surface). Scores computed with the
shipped risk engine (`js/risk.js`), no code changes.

## Scores

| Agent | Score | Band | Flags |
|---|---|---|---|
| Jarvis / HQ brain | 31 | medium | Excessive permissions (4 write/send scopes), touches secrets |
| Codex (desktop) | 25 | low | Excessive permissions (3 writes), touches secrets |
| Morning briefing worker | 21 | low | No human review (runs unattended 09:30) |
| Weekly AI-radar worker | 15 | low | No human review (runs unattended weekly) |
| Muse (A15 app) | 6 | low | PII only |

## Findings (engine-generated, 7 total)

- **2 agents act without human review** (cross-agent finding): the briefing + radar workers
  run on schedule with nobody approving. Mitigation on record: their stated intent is
  read-only reporting, and jarvis-hq itself keeps the approval loop + guardrail re-check
  on its own plan runs. Consider codifying "reporting-only" as an explicit permission
  profile in the seed.
- **Jarvis / HQ brain — Excessive permissions:** holds 4 write/send/admin scopes
  (local-fs write, shell write, github write, smtp send). Fix per engine: trim to least
  privilege. Counterpoint for Alex: the write scopes ARE the job (runner executes the
  approved plan). The real control is the approval loop, which exists — so this is
  "accepted risk, document it," not a trim.
- **Jarvis + Codex — Touches secrets:** both can read API keys in their working scope.
  Verified 2026-10-05: no `sk-` keys are committed anywhere in the current
  `techpartner-business-dashboard` working tree (grep over tracked source, minus
  node_modules/.git). The earlier incident — Alex's own key committed with Codex's
  HQ work (commit 0ede63b, per memory) — is not visible in the local clone's history
  either. Fix per engine: keep secrets in the vault / env, never in-tree. Status:
  currently clean; the residual risk is key material in *remote* history if the key was
  ever pushed in-tree — consider rotating the OpenAI key if it wasn't already.
- **Muse (A15)** is the cleanest entry: approval-gated actions, PII only.

## Blast radius: jarvis-hq (compromise simulation)

- Tools in blast zone: local-fs, shell, github, smtp, openai-api, ollama
- Co-reachable agents via shared tools: cron-briefing (via local-fs), cron-radar (via local-fs), codex (via local-fs, shell, github)
- Data types in the zone: code, secrets, PII

Interpretation: jarvis-hq is correctly the crown jewel. A compromise of it (or of
local-fs/shell creds) reaches 3 of the other 4 agents. The shell+github+secrets
combination is the highest-value path — worth the most guardrail attention.

## Loading the seed into the app

The app keeps its register in localStorage (`agentledger:v1`) and has no JSON-import button,
so load the seed with a one-liner in the page's devtools console, then reload:

```js
fetch('pilot/pilot-seed.json').then(r=>r.json()).then(s=>{localStorage.setItem('agentledger:v1',JSON.stringify({agents:s.agents,shadowScan:null}));location.reload();});
```

Unknown tool ids (`ollama`, `device`, `web`) render by id without breaking — the UI falls back
to the raw id when a tool isn't in its preset library (`js/app.js:177,405`).

---

# Differentiation scan: NVIDIA Open Agent Safety Platform vs AgentLedger (queued from radar scan #2)

Announced 2026-09-28 by Jensen Huang. Two components (sources below):
- **OpenShell** — open-source (Apache 2.0) runtime: sandboxes each agent, traces actions,
  enforces policy on files/credentials/tools/APIs/network endpoints. Runs on Vera CPUs,
  extendable to Arm/Intel; Linux / macOS / Windows-WSL support. (TechCrunch, RedPacket Security)
- **Sentry** — out-of-band hardware watchdog on BlueField-4 DPUs: watches from an isolated
  trust domain, quarantines boundary-crossing agents "in milliseconds." 100+ orgs signed on
  (Microsoft, Perplexity, Accenture, JPMorgan; OpenAI notably absent).

**Verdict: complementary, not competitive.**
- Different layer: NVIDIA is *runtime enforcement below the agent*; AgentLedger is the
  *governance ledger above it* (inventory, risk scoring, blast-radius simulation, audit export).
- Different buyer: NVIDIA's enforcement story is enterprise infrastructure (Sentry needs
  BlueField-4 hardware — not free, not consumer). AgentLedger is zero-infra, free,
  static-page — for solo operators who will never own a DPU.
- Validates the thesis: agent-safety is now a board-level engineering problem (Reco's $55M
  raise, OpenAI safety-leader resignation, "65% of enterprises have seen agents act out of scope").

**Positioning note for Alex:** AgentLedger can cite NVIDIA as the enforcement layer it
*documents*: a future risk factor "no runtime sandbox (OpenShell/Sentry) on this agent"
turns NVIDIA's launch into an AgentLedger feature, not a threat.

Sources: https://techcrunch.com/2026/09/28/nvidia-launches-new-platform-for-reining-in-rogue-ai-agents/ ·
https://www.redpacketsecurity.com/nvidia-launches-open-platform-to-secure-autonomous-ai-agents/ ·
https://aicybr.com/blog/nvidia-open-agent-safety-platform-openshell-sentry
