/* AgentLedger risk engine — pure logic, no DOM.
 * UMD: window.AgentLedgerRisk in the browser, require() in node.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.AgentLedgerRisk = factory();
})(typeof self !== "undefined" ? self : this, function () {

  var ACTION_PERMS = ["write", "send", "admin"];

  // ---------------------------------------------------------- toxic combos
  // Two (or more) safe-looking permissions that are dangerous together.
  var TOXIC_RULES = [
    {
      id: "inbox-sender",
      name: "Inbox reader with a send button",
      severity: "block", weight: 30,
      test: function (agent) {
        var readsMail = hasPerm(agent, ["gmail"], ["read"]);
        var sendsMail = hasPerm(agent, ["gmail", "smtp"], ["send"]);
        return readsMail && sendsMail && !agent.humanReview;
      },
      problem: "Reads your inbox AND can send mail, with nobody reviewing first — a compromised or drifting agent can impersonate you.",
      fix: "Require human approval before any send, or split into a reader agent and a sender agent with a review queue between them."
    },
    {
      id: "prod-egress",
      name: "Production data with an outside exit",
      severity: "block", weight: 30,
      test: function (agent) {
        var readsProd = hasPerm(agent, ["prod-postgres"], ["read", "write", "admin"]) ||
          (agent.data || []).indexOf("prod-db") !== -1;
        var egress = hasPerm(agent, ["slack", "smtp", "gmail", "openai-api"], ["send", "write"]);
        return readsProd && egress;
      },
      problem: "Touches production data AND can push content to an outside channel — exfiltration path.",
      fix: "Remove the egress permission or scope prod access to read-only snapshots with no network exit."
    },
    {
      id: "stale-admin",
      name: "Stale credential with broad power",
      severity: "block", weight: 25,
      test: function (agent) {
        return (agent.tokenAgeDays || 0) > 180 && actionPermCount(agent) >= 3;
      },
      problem: "A credential older than 6 months still holds 3+ action permissions — high-value stale key.",
      fix: "Rotate the credential immediately and move to 90-day rotation."
    }
  ];

  function hasPerm(agent, toolIds, perms) {
    return (agent.tools || []).some(function (c) {
      return toolIds.indexOf(c.tool) !== -1 &&
        (c.perms || []).some(function (p) { return perms.indexOf(p) !== -1; });
    });
  }

  function actionPermCount(agent) {
    return (agent.tools || []).reduce(function (n, c) {
      return n + (c.perms || []).filter(function (p) { return ACTION_PERMS.indexOf(p) !== -1; }).length;
    }, 0);
  }

  // -------------------------------------------------------------- factors
  function detectFactors(agent) {
    var factors = [];
    var data = agent.data || [];

    if (!agent.registered) {
      factors.push({
        id: "shadow", label: "Shadow agent", severity: "block", weight: 30,
        problem: "Discovered in your environment but never registered or sanctioned — nobody approved this.",
        fix: "Register it with an owner and purpose and set a governance status, or revoke its access."
      });
    }

    TOXIC_RULES.forEach(function (rule) {
      if (rule.test(agent)) {
        factors.push({
          id: "toxic-" + rule.id, label: "Toxic combo: " + rule.name,
          severity: rule.severity, weight: rule.weight,
          problem: rule.problem, fix: rule.fix
        });
      }
    });

    if (!agent.humanReview) {
      factors.push({
        id: "no-review", label: "No human review", severity: "warn", weight: 15,
        problem: "Can take actions (send, post, write) with nobody approving them first.",
        fix: "Require human review on irreversible actions, or move the agent to Review status until it is configured."
      });
    }

    if (actionPermCount(agent) >= 3) {
      factors.push({
        id: "excess-perms", label: "Excessive permissions", severity: "warn", weight: 15,
        problem: "Holds " + actionPermCount(agent) + " write/send/admin scopes — more than its stated job needs.",
        fix: "Trim to least privilege and note what you removed in the agent record."
      });
    }

    if ((agent.tokenAgeDays || 0) > 90) {
      factors.push({
        id: "stale-token", label: "Stale credential", severity: "warn", weight: 12,
        problem: "Credential is " + agent.tokenAgeDays + " days old (rotation guideline: 90 days).",
        fix: "Rotate the credential now and set a 90-day rotation reminder."
      });
    }

    if (agent.drift) {
      factors.push({
        id: "drift", label: "Intent drift", severity: "warn", weight: 12,
        problem: "Behavior is drifting from its stated intent: " + (agent.driftNote || "unexplained activity."),
        fix: "Re-confirm the purpose with the owner, tighten its scope, or block it until reviewed."
      });
    }

    if (data.indexOf("secrets") !== -1) {
      factors.push({
        id: "secrets", label: "Touches secrets", severity: "warn", weight: 10,
        problem: "Can read secrets (API keys, tokens) in its working scope.",
        fix: "Scope it away from credential stores, or move secrets to a vault it cannot read."
      });
    }
    if (data.indexOf("prod-db") !== -1) {
      factors.push({
        id: "prod-db", label: "Production database", severity: "warn", weight: 10,
        problem: "Has a path to production customer data.",
        fix: "Restrict to read-only or snapshots; log every access."
      });
    }
    if (data.indexOf("PII") !== -1) {
      factors.push({
        id: "pii", label: "Handles PII", severity: "info", weight: 6,
        problem: "Processes personally identifiable information.",
        fix: "Confirm data handling is documented; minimize what it retains."
      });
    }

    if ((agent.lastActivityDays || 0) > 30) {
      factors.push({
        id: "inactive", label: "Inactive", severity: "info", weight: 6,
        problem: "No activity in " + agent.lastActivityDays + " days.",
        fix: "If it is no longer needed, remove it — dead agents are forgotten attack surface."
      });
    }

    var inc = agent.incidents || [];
    if (inc.length) {
      factors.push({
        id: "incidents", label: "Incident history (" + inc.length + ")", severity: "warn",
        weight: Math.min(20, 8 + 4 * (inc.length - 1)),
        problem: inc.length + " logged incident" + (inc.length === 1 ? "" : "s") +
          " — latest: " + (inc[inc.length - 1].title || "untitled") + ".",
        fix: "Review the incident log in the agent record; repeat offenders should be blocked, not just watched."
      });
    }

    return factors;
  }

  function scoreBand(score) {
    if (score >= 60) return "high";
    if (score >= 30) return "medium";
    return "low";
  }

  function computeRisk(agent) {
    var factors = detectFactors(agent);
    var score = Math.min(100, factors.reduce(function (s, f) { return s + f.weight; }, 0));
    return { score: score, band: scoreBand(score), factors: factors };
  }

  function riskColor(score) {
    var b = scoreBand(score);
    return b === "high" ? "#e0604f" : b === "medium" ? "#d9a441" : "#4caf7d";
  }

  // --------------------------------------------------------- blast radius
  // If this agent were compromised: every tool it can reach, every other
  // agent sharing those tools, and every data type in the blast zone.
  function blastRadius(agentId, agents) {
    var agent = agents.filter(function (a) { return a.id === agentId; })[0];
    if (!agent) return { tools: [], agents: [], dataTypes: [], via: {} };
    var toolIds = (agent.tools || []).map(function (c) { return c.tool; });
    var toolSet = {};
    toolIds.forEach(function (t) { toolSet[t] = true; });

    var coAgents = [];
    var via = {};
    agents.forEach(function (a) {
      if (a.id === agentId) return;
      var shared = (a.tools || []).map(function (c) { return c.tool; })
        .filter(function (t) { return toolSet[t]; });
      if (shared.length) { coAgents.push(a.id); via[a.id] = shared; }
    });

    var dataTypes = {};
    [agent].concat(agents.filter(function (a) { return coAgents.indexOf(a.id) !== -1; }))
      .forEach(function (a) { (a.data || []).forEach(function (d) { dataTypes[d] = true; }); });

    return { tools: toolIds, agents: coAgents, dataTypes: Object.keys(dataTypes), via: via };
  }

  // ------------------------------------------------------------- findings
  function buildFindings(agents) {
    var findings = [];
    agents.forEach(function (agent) {
      var risk = computeRisk(agent);
      risk.factors.forEach(function (f) {
        if (f.severity === "block") {
          findings.push({
            level: "block", agentId: agent.id, agentName: agent.name,
            title: f.label,
            detail: f.problem,
            action: f.fix
          });
        }
      });
      risk.factors.forEach(function (f) {
        if (f.severity === "warn") {
          findings.push({
            level: "warn", agentId: agent.id, agentName: agent.name,
            title: f.label,
            detail: f.problem,
            action: f.fix
          });
        }
      });
    });
    // global infos
    var shadow = agents.filter(function (a) { return !a.registered; }).length;
    if (shadow > 0) {
      findings.push({
        level: "info", agentId: null, agentName: null,
        title: shadow + " shadow agent" + (shadow > 1 ? "s" : "") + " in the estate",
        detail: "Discovery found agents nobody registered. Shadow agents skip every control you set up.",
        action: "Run the shadow check below and register or revoke each one."
      });
    }
    var unreviewed = agents.filter(function (a) { return !a.humanReview && (a.tools || []).length; }).length;
    if (unreviewed > 0) {
      findings.push({
        level: "info", agentId: null, agentName: null,
        title: unreviewed + " agent" + (unreviewed > 1 ? "s" : "") + " act without human review",
        detail: "Autonomous action is fine for drafts and reads — risky for sends, writes and money.",
        action: "Put an approval step in front of every irreversible action."
      });
    }
    var order = { block: 0, warn: 1, info: 2 };
    findings.sort(function (a, b) { return order[a.level] - order[b.level]; });
    return findings;
  }

  // ------------------------------------------------------------ shadow
  function shadowDiff(agents, discovery) {
    // "On the books" = every agent in the register, including recorded shadows.
    // A rescan stays clean once shadow agents have been added to the register;
    // their unregistered status is tracked separately as a risk factor.
    var onTheBooks = agents.map(function (a) { return a.name; });
    var found = {};
    discovery.forEach(function (src) {
      (src.found || []).forEach(function (n) { found[n] = true; });
    });
    var foundNames = Object.keys(found);
    var known = {};
    onTheBooks.forEach(function (n) { known[n.toLowerCase()] = true; });
    var shadow = foundNames.filter(function (n) { return !known[n.toLowerCase()]; });
    var matched = foundNames.filter(function (n) { return known[n.toLowerCase()]; });
    return {
      registeredCount: agents.filter(function (a) { return a.registered; }).length,
      foundCount: foundNames.length,
      matched: matched,
      shadow: shadow
    };
  }

  // ----------------------------------------------------------- validate
  function validateAgent(a) {
    var errors = [];
    if (!a.name || !String(a.name).trim()) errors.push("Name is required.");
    if (!a.owner || !String(a.owner).trim()) errors.push("Owner is required.");
    if (!a.purpose || !String(a.purpose).trim()) errors.push("Purpose is required.");
    if (!(a.tools || []).length) errors.push("At least one tool/connection is required.");
    if (["sanctioned", "review", "blocked"].indexOf(a.status) === -1) errors.push("Status must be sanctioned, review or blocked.");
    return errors;
  }

  // -------------------------------------------------------------- export
  function money(n) {
    var v = Number(n) || 0;
    return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function auditMarkdown(state, hourlyRate) {
    var agents = state.agents;
    var date = new Date().toISOString().slice(0, 10);
    var lines = [];
    lines.push("# AgentLedger audit pack — " + date);
    lines.push("");
    lines.push("Self-hosted agent inventory & risk register. This pack *documents and scores* the agent estate; it does not enforce anything — revocations below are recommendations.");
    lines.push("");
    var risks = agents.map(function (a) { return { a: a, r: computeRisk(a) }; });
    var high = risks.filter(function (x) { return x.r.band === "high"; }).length;
    var shadow = agents.filter(function (a) { return !a.registered; }).length;
    var avg = risks.length ? Math.round(risks.reduce(function (s, x) { return s + x.r.score; }, 0) / risks.length) : 0;
    lines.push("## Summary");
    lines.push("");
    lines.push("- Total agents: " + agents.length);
    lines.push("- Shadow / unregistered: " + shadow);
    lines.push("- High risk: " + high);
    lines.push("- Average risk score: " + avg + "/100");
    lines.push("");
    lines.push("## Inventory");
    lines.push("");
    lines.push("| Agent | Owner | Status | Risk | Tools | Data | Human review | Cost/mo | Hrs saved/mo |");
    lines.push("|---|---|---|---|---|---|---|---|---|");
    risks.forEach(function (x) {
      var a = x.a;
      lines.push("| " + a.name + " | " + a.owner + " | " + a.status + " | " +
        x.r.score + "/100 (" + x.r.band + ")" + " | " +
        (a.tools || []).map(function (c) { return c.tool; }).join(", ") + " | " +
        (a.data || []).join(", ") + " | " + (a.humanReview ? "yes" : "no") + " | " +
        money(a.costPerMonth) + " | " + a.hoursSaved + " |");
    });
    lines.push("");
    lines.push("## Risk factors");
    lines.push("");
    risks.forEach(function (x) {
      lines.push("### " + x.a.name + " — " + x.r.score + "/100 (" + x.r.band + ")");
      lines.push("");
      if (!x.r.factors.length) { lines.push("No risk factors found."); lines.push(""); return; }
      x.r.factors.forEach(function (f) {
        lines.push("- **[" + f.severity.toUpperCase() + "] " + f.label + "** (" + f.weight + " pts)");
        lines.push("  - Problem: " + f.problem);
        lines.push("  - Fix: " + f.fix);
      });
      lines.push("");
    });
    lines.push("## Findings & recommended actions");
    lines.push("");
    buildFindings(agents).forEach(function (f) {
      lines.push("- **[" + f.level.toUpperCase() + "]** " + (f.agentName ? f.agentName + ": " : "") + f.title);
      lines.push("  - " + f.detail);
      lines.push("  - Recommended: " + f.action);
    });
    lines.push("");
    lines.push("## Remediation plan");
    lines.push("");
    var fixes = pendingFixes(agents);
    if (!fixes.length) {
      lines.push("Every risk factor in the estate has a checked-off fix. Nothing pending.");
    } else {
      lines.push("Pending fixes, heaviest first. Carrying all of these out would drop the " +
        "estate's total risk weight substantially — check each one off in the agent drawer as you complete it.");
      lines.push("");
      fixes.forEach(function (f) {
        lines.push("- **[" + f.severity.toUpperCase() + "] " + f.agentName + " — " + f.label + "** (" + f.weight + " pts)");
        lines.push("  - Do this: " + f.fix);
      });
    }
    lines.push("");
    lines.push("## Value");
    lines.push("");
    var totalCost = agents.reduce(function (s, a) { return s + (Number(a.costPerMonth) || 0); }, 0);
    var totalHrs = agents.reduce(function (s, a) { return s + (Number(a.hoursSaved) || 0); }, 0);
    var value = totalHrs * (hourlyRate || 80);
    lines.push("- Total cost: " + money(totalCost) + "/mo · Time saved: ~" + totalHrs + " hrs/mo ≈ " + money(value) + " of operator time");
    lines.push("- Net: " + money(value - totalCost) + "/mo");
    lines.push("");
    lines.push("_Generated by AgentLedger (self-hosted). Verify before acting._");
    return lines.join("\n");
  }

  // ----------------------------------------------------- review cadence
  function addDaysISO(iso, days) {
    var d = new Date(iso + "T12:00:00");
    d.setDate(d.getDate() + days);
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  function todayISO() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  /** Review cadence in days: riskier agents get reviewed more often. */
  function reviewCadence(agent) {
    var band = computeRisk(agent).band;
    return band === "high" ? 30 : band === "medium" ? 90 : 180;
  }

  /** Next review date: lastReviewDate + cadence. Never reviewed → due now. */
  function nextReviewISO(agent, today) {
    var now = today || todayISO();
    if (!agent.lastReviewDate) return now;
    return addDaysISO(agent.lastReviewDate, reviewCadence(agent));
  }

  /** Agents whose next review is today or overdue, riskiest first. */
  function reviewsDue(agents, today) {
    var now = today || todayISO();
    return (agents || []).filter(function (a) { return nextReviewISO(a, now) <= now; })
      .map(function (a) {
        return { agent: a, risk: computeRisk(a), nextReview: nextReviewISO(a, now) };
      })
      .sort(function (x, y) { return y.risk.score - x.risk.score; });
  }

  // ----------------------------------------------------- risk history
  // One score snapshot per day per agent (persisted in agent.scoreHistory).
  // Lets the ledger show whether an agent is getting safer or scarier.
  function recordRiskSnapshot(agent, today) {
    var now = today || todayISO();
    agent.scoreHistory = agent.scoreHistory || [];
    var last = agent.scoreHistory[agent.scoreHistory.length - 1];
    var score = computeRisk(agent).score;
    if (last && last.d === now) last.s = score; // refresh today's snapshot
    else agent.scoreHistory.push({ d: now, s: score });
    if (agent.scoreHistory.length > 90) agent.scoreHistory = agent.scoreHistory.slice(-90);
    return agent;
  }

  // Score delta vs the earliest snapshot inside the last `days` days.
  // Returns null when there are fewer than two days of history.
  function riskTrend(agent, days) {
    var hist = agent.scoreHistory || [];
    if (hist.length < 2) return null;
    days = days || 30;
    var now = hist[hist.length - 1];
    var cutoff = addDaysISO(now.d, -days);
    var old = null;
    for (var i = 0; i < hist.length; i++) {
      if (hist[i].d >= cutoff) { old = hist[i]; break; }
    }
    if (!old || old.d === now.d) return null;
    return { delta: now.s - old.s, from: old, to: now };
  }

  // -------------------------------------------------- remediation planner
  // Each risk factor already carries a concrete fix. The planner turns them
  // into a checkable to-do list per agent and estimates the score after the
  // checked fixes are carried out. Progress persists on the agent record.
  function fixPlanProgress(agent) {
    var factors = computeRisk(agent).factors;
    var total = factors.reduce(function (s, f) { return s + f.weight; }, 0);
    var score = Math.min(100, total);
    var plan = agent.fixPlan || {};
    var done = factors.filter(function (f) { return plan[f.id] && plan[f.id].done; });
    var doneW = done.reduce(function (s, f) { return s + f.weight; }, 0);
    return {
      factors: factors,
      score: score,
      doneCount: done.length,
      pendingCount: factors.length - done.length,
      projected: Math.max(0, score - doneW)
    };
  }

  function toggleFix(agent, factorId, today) {
    agent.fixPlan = agent.fixPlan || {};
    var cur = agent.fixPlan[factorId];
    if (cur && cur.done) delete agent.fixPlan[factorId];
    else agent.fixPlan[factorId] = { done: true, date: today || todayISO() };
    return agent;
  }

  /** Estate-wide pending fixes, heaviest first — for the audit pack. */
  function pendingFixes(agents) {
    var out = [];
    (agents || []).forEach(function (a) {
      var p = fixPlanProgress(a);
      p.factors.forEach(function (f) {
        var planned = (a.fixPlan || {})[f.id];
        if (!planned || !planned.done) {
          out.push({ agentName: a.name, label: f.label, weight: f.weight,
            severity: f.severity, fix: f.fix });
        }
      });
    });
    out.sort(function (x, y) { return y.weight - x.weight; });
    return out;
  }

  // ----------------------------------------------------- ledger backup
  function exportLedger(state) {
    return JSON.stringify({
      format: "agentledger/v1",
      exportedAt: new Date().toISOString(),
      agents: state.agents || []
    }, null, 2);
  }

  /**
   * Parse a ledger backup file. Returns {agents, errors, skipped}.
   * Every agent must pass validateAgent and have a unique id.
   */
  function importLedger(text) {
    var obj;
    try { obj = JSON.parse(text); }
    catch (e) { return { agents: [], errors: ["Not valid JSON."], skipped: 0 }; }
    var list = obj.agents || obj;
    if (!Array.isArray(list)) {
      return { agents: [], errors: ["No agent list found in this file."], skipped: 0 };
    }
    var errors = [], agents = [], seen = {};
    list.forEach(function (a, i) {
      var errs = validateAgent(a);
      if (!a.id || seen[a.id]) errs.push("Duplicate or missing id.");
      if (errs.length) {
        errors.push("Agent #" + (i + 1) + " (" + ((a && a.name) || "unnamed") + "): " + errs.join(" "));
        return;
      }
      seen[a.id] = true;
      agents.push(a);
    });
    return { agents: agents, errors: errors, skipped: list.length - agents.length };
  }

  return {
    TOXIC_RULES: TOXIC_RULES,
    detectFactors: detectFactors,
    computeRisk: computeRisk,
    scoreBand: scoreBand,
    riskColor: riskColor,
    blastRadius: blastRadius,
    buildFindings: buildFindings,
    shadowDiff: shadowDiff,
    validateAgent: validateAgent,
    auditMarkdown: auditMarkdown,
    money: money,
    actionPermCount: actionPermCount,
    reviewCadence: reviewCadence,
    nextReviewISO: nextReviewISO,
    reviewsDue: reviewsDue,
    recordRiskSnapshot: recordRiskSnapshot,
    riskTrend: riskTrend,
    fixPlanProgress: fixPlanProgress,
    toggleFix: toggleFix,
    pendingFixes: pendingFixes,
    exportLedger: exportLedger,
    importLedger: importLedger,
    todayISO: todayISO
  };
});
