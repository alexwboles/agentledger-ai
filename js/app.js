/* AgentLedger UI — renders the register, risk map, findings, drawer, shadow check.
 * Browser-only. All risk math lives in js/risk.js; seed data in js/data.js.
 */
(function () {
  "use strict";
  var D = window.AgentLedgerData;
  var R = window.AgentLedgerRisk;
  var LS_KEY = "agentledger:v1";
  var REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var S = {
    agents: [],
    selected: null,
    blast: null,
    drawer: null,
    drawerTab: "reach",
    shadowScan: null,   // {done:true, result:{...}}
    editingId: null
  };

  // ---------------------------------------------------------------- state
  function blankState() {
    return { agents: D.AGENTS.filter(function (a) { return a.registered; }), shadowScan: null };
  }
  function loadState() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var s = JSON.parse(raw);
        if (s && Array.isArray(s.agents) && s.agents.length) {
          S.agents = s.agents;
          S.shadowScan = s.shadowScan || null;
          return;
        }
      }
    } catch (e) {}
    var b = blankState();
    S.agents = b.agents;
    S.shadowScan = b.shadowScan;
  }
  function saveState() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ agents: S.agents, shadowScan: S.shadowScan }));
    } catch (e) {}
  }
  function resetDemo() {
    var b = blankState();
    S.agents = b.agents; S.shadowScan = null;
    S.selected = null; S.blast = null; S.drawer = null;
    saveState(); renderAll();
    toast("Register restored to the seeded demo data.");
  }

  function getAgent(id) {
    return S.agents.filter(function (a) { return a.id === id; })[0] || null;
  }
  function riskOf(agent) { return R.computeRisk(agent); }
  function byId(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function agentName(id) { var a = getAgent(id); return a ? a.name : id; }

  // ---------------------------------------------------------------- toast
  var toastTimer = null;
  function toast(msg) {
    var t = byId("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }

  // ----------------------------------------------------------------- KPIs
  function renderKpis() {
    var risks = S.agents.map(riskOf);
    var high = risks.filter(function (r) { return r.band === "high"; }).length;
    var shadow = S.agents.filter(function (a) { return !a.registered; }).length;
    var conns = S.agents.reduce(function (n, a) { return n + (a.tools || []).length; }, 0);
    var avg = risks.length ? Math.round(risks.reduce(function (s, r) { return s + r.score; }, 0) / risks.length) : 0;
    var cards = [
      { label: "Agents on the books", value: String(S.agents.length), sub: "registered + shadow" },
      { label: "Shadow / unregistered", value: String(shadow), sub: shadow ? "needs a decision" : "none outstanding", alert: shadow > 0 },
      { label: "High risk", value: String(high), sub: "score 60–100", alert: high > 0 },
      { label: "Connections mapped", value: String(conns), sub: "agent → tool edges" },
      { label: "Average risk", value: avg + "/100", sub: "across the estate" }
    ];
    byId("kpis").innerHTML = cards.map(function (c, i) {
      return '<div class="kpi' + (c.alert ? " alert" : "") + '">' +
        '<div class="kpi-folio">FIG. ' + (i + 1) + '</div>' +
        '<div class="kpi-value">' + esc(c.value) + '</div>' +
        '<div class="kpi-label">' + esc(c.label) + '</div>' +
        '<div class="kpi-sub">' + esc(c.sub) + '</div></div>';
    }).join("");
  }

  // -------------------------------------------------------------- risk map
  var KIND_GLYPH = { saas: "S", api: "A", db: "D", mcp: "M", cli: "C", extension: "E", local: "L" };

  function mapModel() {
    var agents = S.agents;
    var toolIds = [];
    var seen = {};
    agents.forEach(function (a) {
      (a.tools || []).forEach(function (c) {
        if (!seen[c.tool]) { seen[c.tool] = true; toolIds.push(c.tool); }
      });
    });
    // Order tools by the angle of their first connected agent so edges stay
    // short and crossings stay rare.
    var nA = Math.max(agents.length, 1);
    var agentAngle = {};
    agents.forEach(function (a, i) { agentAngle[a.id] = (i / nA) * Math.PI * 2; });
    var firstAngle = {};
    agents.forEach(function (a) {
      (a.tools || []).forEach(function (c) {
        if (!(c.tool in firstAngle)) firstAngle[c.tool] = agentAngle[a.id];
      });
    });
    toolIds.sort(function (x, y) { return (firstAngle[x] || 0) - (firstAngle[y] || 0); });
    return { agents: agents, toolIds: toolIds };
  }

  function renderMap() {
    var m = mapModel();
    var W = 960, H = 660, cx = 480, cy = 330;
    var rA = 168, rT = 288;
    var nA = m.agents.length, nT = m.toolIds.length;
    var blast = S.blast;

    function agentPos(i) {
      var t = (i / Math.max(nA, 1)) * Math.PI * 2 - Math.PI / 2;
      return { x: cx + rA * Math.cos(t), y: cy + rA * Math.sin(t) };
    }
    function toolPos(j) {
      var t = (j / Math.max(nT, 1)) * Math.PI * 2 - Math.PI / 2;
      return { x: cx + rT * Math.cos(t), y: cy + rT * Math.sin(t) };
    }
    var toolIndex = {};
    m.toolIds.forEach(function (t, j) { toolIndex[t] = j; });

    var svg = [];
    svg.push('<svg viewBox="0 0 ' + W + ' ' + H + '" class="map-svg" role="img" aria-label="Agent risk map">');

    // faint ledger rings
    [rA, rT].forEach(function (r) {
      svg.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" class="map-ring"/>');
    });
    svg.push('<circle cx="' + cx + '" cy="' + cy + '" r="34" class="map-core"/>' +
      '<text x="' + cx + '" y="' + (cy + 5) + '" text-anchor="middle" class="map-core-t">YOU</text>');

    // edges
    m.agents.forEach(function (a, i) {
      var p = agentPos(i);
      (a.tools || []).forEach(function (c) {
        var q = toolPos(toolIndex[c.tool]);
        var mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
        var dx = mx - cx, dy = my - cy;
        var len = Math.sqrt(dx * dx + dy * dy) || 1;
        var bend = 0.22;
        var ccx = mx + (dx / len) * bend * len, ccy = my + (dy / len) * bend * len;
        var cls = "map-edge";
        if (blast) {
          var hit = (a.id === S.selected) || blast.tools.indexOf(c.tool) !== -1;
          cls += hit ? " hot" : " dim";
        }
        svg.push('<path d="M' + p.x.toFixed(1) + ',' + p.y.toFixed(1) +
          ' Q' + ccx.toFixed(1) + ',' + ccy.toFixed(1) + ' ' + q.x.toFixed(1) + ',' + q.y.toFixed(1) +
          '" class="' + cls + '" data-edge-agent="' + esc(a.id) + '" data-edge-tool="' + esc(c.tool) + '"/>');
      });
    });

    // tool nodes
    m.toolIds.forEach(function (tid, j) {
      var t = D.TOOLS[tid] || { name: tid, kind: "api" };
      var p = toolPos(j);
      var cls = "map-tool";
      if (blast) cls += blast.tools.indexOf(tid) !== -1 ? " hot" : " dim";
      svg.push('<g class="' + cls + '" transform="translate(' + p.x.toFixed(1) + ',' + p.y.toFixed(1) + ')">' +
        '<rect x="-19" y="-19" width="38" height="38" rx="9" class="map-tool-box"/>' +
        '<text y="6" text-anchor="middle" class="map-tool-g">' + (KIND_GLYPH[t.kind] || "?") + '</text>' +
        '<text y="36" text-anchor="middle" class="map-node-l">' + esc(t.name) + '</text></g>');
    });

    // agent nodes
    m.agents.forEach(function (a, i) {
      var p = agentPos(i);
      var r = riskOf(a);
      var cls = "map-agent" + (a.id === S.selected ? " sel" : "") + (a.registered ? "" : " shadow");
      if (blast && a.id !== S.selected && blast.agents.indexOf(a.id) === -1) cls += " dim";
      svg.push('<g class="' + cls + '" data-agent="' + esc(a.id) + '" transform="translate(' + p.x.toFixed(1) + ',' + p.y.toFixed(1) + ')" tabindex="0" role="button" aria-label="' + esc(a.name) + ', risk ' + r.score + '">' +
        '<circle r="30" class="map-agent-halo" style="stroke:' + R.riskColor(r.score) + '"/>' +
        '<circle r="23" class="map-agent-dot" style="fill:' + R.riskColor(r.score) + '"/>' +
        '<text y="6" text-anchor="middle" class="map-agent-s">' + r.score + '</text>' +
        '<text y="44" text-anchor="middle" class="map-node-l">' + esc(a.name) + '</text>' +
        '<text y="58" text-anchor="middle" class="map-node-s">' + esc(a.status) + '</text></g>');
    });

    svg.push("</svg>");
    byId("mapwrap").innerHTML = svg.join("");

    // wire clicks
    Array.prototype.forEach.call(byId("mapwrap").querySelectorAll(".map-agent"), function (g) {
      function pick() { selectAgent(g.getAttribute("data-agent")); }
      g.addEventListener("click", function (e) { e.stopPropagation(); pick(); });
      g.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
    });
    byId("mapwrap").querySelector(".map-svg").addEventListener("click", function () { selectAgent(null); });

    renderBlast();
  }

  function selectAgent(id) {
    S.selected = id;
    S.blast = id ? R.blastRadius(id, S.agents) : null;
    renderMap();
    renderRegistry();
  }

  function renderBlast() {
    var el = byId("blast");
    if (!S.selected || !S.blast) {
      el.innerHTML = '<div class="blast-idle"><span class="blast-idle-t">Compromise simulation</span>' +
        '<p>Click any agent on the map to simulate a compromise — every tool it can reach, every agent sharing those tools, and every data type in the blast zone lights up.</p></div>';
      return;
    }
    var a = getAgent(S.selected);
    var b = S.blast;
    var plural = function (n, one, many) { return n === 1 ? one : many; };
    var html = '<div class="blast-head"><span class="blast-k">COMPROMISE SIMULATION</span>' +
      '<button class="linkbtn" id="blast-clear">clear</button></div>' +
      '<div class="blast-title">If <strong>' + esc(a.name) + '</strong> were compromised…</div>' +
      '<div class="blast-nums">' +
      '<div><b>' + b.tools.length + '</b><span>' + plural(b.tools.length, "tool", "tools") + ' reachable</span></div>' +
      '<div><b>' + b.agents.length + '</b><span>co-accessed ' + plural(b.agents.length, "agent", "agents") + '</span></div>' +
      '<div><b>' + b.dataTypes.length + '</b><span>' + plural(b.dataTypes.length, "data type", "data types") + ' at risk</span></div></div>';
    if (b.tools.length) {
      html += '<div class="blast-sec"><div class="blast-sec-t">Tools in reach</div><div class="chips">' +
        b.tools.map(function (t) { return '<span class="chip hot">' + esc((D.TOOLS[t] || {}).name || t) + '</span>'; }).join("") +
        "</div></div>";
    }
    if (b.agents.length) {
      html += '<div class="blast-sec"><div class="blast-sec-t">Agents sharing those tools</div><div class="chips">' +
        b.agents.map(function (id) {
          return '<button class="chip hot link" data-jump="' + esc(id) + '">' + esc(agentName(id)) +
            ' <span class="via">via ' + b.via[id].map(function (t) { return esc((D.TOOLS[t] || {}).name || t); }).join(", ") + '</span></button>';
        }).join("") + "</div></div>";
    }
    if (b.dataTypes.length) {
      html += '<div class="blast-sec"><div class="blast-sec-t">Data in the blast zone</div><div class="chips">' +
        b.dataTypes.map(function (d) { return '<span class="chip warn">' + esc(d) + '</span>'; }).join("") +
        "</div></div>";
    }
    var r = riskOf(a);
    var topFactor = r.factors.filter(function (f) { return f.severity === "block"; })[0];
    if (topFactor) {
      html += '<div class="blast-rec"><span class="blast-sec-t">First move</span><p>' + esc(topFactor.fix) + '</p></div>';
    }
    el.innerHTML = html;
    byId("blast-clear").addEventListener("click", function () { selectAgent(null); });
    Array.prototype.forEach.call(el.querySelectorAll("[data-jump]"), function (btn) {
      btn.addEventListener("click", function () { selectAgent(btn.getAttribute("data-jump")); });
    });
  }

  // -------------------------------------------------------------- findings
  function renderFindings() {
    var f = R.buildFindings(S.agents);
    var pill = { block: "BLOCK", warn: "WARN", info: "INFO" };
    byId("findings").innerHTML =
      '<div class="feed-head"><span class="feed-k">FINDINGS</span><span class="feed-n">' + f.length + '</span></div>' +
      '<div class="feed-list">' +
      (f.length ? f.map(function (x) {
        return '<article class="finding ' + x.level + '">' +
          '<div class="finding-top"><span class="lvl ' + x.level + '">' + pill[x.level] + '</span>' +
          (x.agentName ? '<button class="linkbtn" data-agent="' + esc(x.agentId) + '">' + esc(x.agentName) + '</button>' : '<span class="finding-est">estate-wide</span>') +
          '</div><div class="finding-t">' + esc(x.title) + '</div>' +
          '<p class="finding-d">' + esc(x.detail) + '</p>' +
          '<p class="finding-a"><span>Recommended:</span> ' + esc(x.action) + '</p></article>';
      }).join("") : '<p class="empty">No findings. The estate is clean — for now.</p>') + "</div>";
    Array.prototype.forEach.call(byId("findings").querySelectorAll("[data-agent]"), function (btn) {
      btn.addEventListener("click", function () { openDrawer(btn.getAttribute("data-agent"), "risk"); });
    });
  }

  // -------------------------------------------------------------- registry
  function dial(score, size) {
    size = size || 64;
    var frac = Math.max(0, Math.min(1, score / 100));
    var r = (size / 2) - 7;
    var cx = size / 2, cy = size / 2;
    var a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    function pt(a) { return (cx + r * Math.cos(a)).toFixed(1) + "," + (cy + r * Math.sin(a)).toFixed(1); }
    var large = frac > 0.5 ? 1 : 0;
    var ae = a0 + frac * (a1 - a0);
    var arc = frac > 0.001 ?
      '<path d="M' + pt(a0) + ' A' + r + ',' + r + ' 0 ' + large + ' 1 ' + pt(ae) + '" class="dial-arc" style="stroke:' + R.riskColor(score) + '"/>' : "";
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" class="dial">' +
      '<path d="M' + pt(a0) + ' A' + r + ',' + r + ' 0 1 1 ' + pt(a1) + '" class="dial-bg"/>' + arc +
      '<text x="' + cx + '" y="' + (cy + 5) + '" text-anchor="middle" class="dial-n">' + score + '</text></svg>';
  }

  function renderRegistry() {
    var rows = S.agents.map(function (a) {
      var r = riskOf(a);
      var value = (Number(a.hoursSaved) || 0) * D.HOURLY_RATE;
      var segs = ["sanctioned", "review", "blocked"].map(function (st) {
        return '<button class="seg' + (a.status === st ? " on " + st : "") + '" data-status="' + st + '" data-id="' + esc(a.id) + '">' + st + '</button>';
      }).join("");
      return '<article class="agent st-' + a.status + (a.id === S.selected ? " sel" : "") + '" data-id="' + esc(a.id) + '">' +
        '<div class="agent-dial">' + dial(r.score) +
        '<div class="band ' + r.band + '">' + r.band + ' risk</div></div>' +
        '<div class="agent-main">' +
        '<div class="agent-top"><h3>' + esc(a.name) + (a.registered ? "" : ' <span class="shadowtag">SHADOW</span>') + '</h3>' +
        '<span class="plat">' + esc(a.platform) + ' · ' + esc(a.owner) + '</span></div>' +
        '<p class="agent-purpose">' + esc(a.purpose) + '</p>' +
        '<div class="agent-value">Value line — <b>' + R.money(a.costPerMonth) + '/mo</b> cost · <b>~' + a.hoursSaved + ' hrs</b> saved ≈ <b>' + R.money(value) + '</b> of operator time</div>' +
        '<div class="agent-gov"><span class="gov-k">Governance</span><div class="segs">' + segs + '</div></div></div>' +
        '<div class="agent-actions">' +
        '<button class="btn ghost" data-act="details" data-id="' + esc(a.id) + '">Details</button>' +
        '<button class="btn ghost" data-act="edit" data-id="' + esc(a.id) + '">Edit</button>' +
        '<button class="btn ghost danger" data-act="remove" data-id="' + esc(a.id) + '">Remove</button>' +
        '</div></article>';
    }).join("");
    byId("registry").innerHTML = rows ||
      '<p class="empty">No agents on the books. Register your first agent to start the ledger.</p>';

    Array.prototype.forEach.call(byId("registry").querySelectorAll(".seg"), function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        setStatus(btn.getAttribute("data-id"), btn.getAttribute("data-status"));
      });
    });
    Array.prototype.forEach.call(byId("registry").querySelectorAll("[data-act]"), function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var id = btn.getAttribute("data-id"), act = btn.getAttribute("data-act");
        if (act === "details") openDrawer(id, "reach");
        if (act === "edit") openModal(id);
        if (act === "remove") removeAgent(id);
      });
    });
  }

  function setStatus(id, status) {
    var a = getAgent(id);
    if (!a) return;
    a.status = status;
    saveState(); renderAll();
    toast(a.name + " marked " + status.toUpperCase() + ".");
  }

  function removeAgent(id) {
    var a = getAgent(id);
    if (!a) return;
    if (!window.confirm("Remove " + a.name + " from the ledger? This only deletes the record — it does not revoke any real access.")) return;
    S.agents = S.agents.filter(function (x) { return x.id !== id; });
    if (S.selected === id) { S.selected = null; S.blast = null; }
    if (S.drawer === id) closeDrawer();
    saveState(); renderAll();
    toast(a.name + " removed from the ledger.");
  }

  // ---------------------------------------------------------------- drawer
  function openDrawer(id, tab) {
    S.drawer = id;
    S.drawerTab = tab || "reach";
    renderDrawer();
    byId("drawer").classList.add("open");
    byId("scrim").classList.add("open");
  }
  function closeDrawer() {
    S.drawer = null;
    byId("drawer").classList.remove("open");
    byId("scrim").classList.remove("open");
  }

  function renderDrawer() {
    var a = getAgent(S.drawer);
    if (!a) { closeDrawer(); return; }
    var r = riskOf(a);
    var tabs = [["reach", "Reach"], ["risk", "Risk factors"], ["flows", "Data flows"], ["activity", "Activity & drift"], ["tests", "Tests"]];
    var html = '<div class="drawer-head">' +
      '<div><div class="drawer-k">ENTRY Nº ' + esc(a.id.toUpperCase()) + '</div>' +
      '<h2>' + esc(a.name) + (a.registered ? "" : ' <span class="shadowtag">SHADOW</span>') + '</h2>' +
      '<div class="drawer-sub">' + esc(a.platform) + ' · owner ' + esc(a.owner) + ' · <span class="st-pill ' + a.status + '">' + a.status + '</span></div></div>' +
      '<div class="drawer-dial">' + dial(r.score, 76) + '</div>' +
      '<button class="xbtn" id="drawer-close" aria-label="Close">×</button></div>' +
      '<div class="drawer-tabs">' + tabs.map(function (t) {
        return '<button class="dtab' + (S.drawerTab === t[0] ? " on" : "") + '" data-tab="' + t[0] + '">' + t[1] + '</button>';
      }).join("") + '</div><div class="drawer-body">' + drawerTab(a, r) + "</div>";
    byId("drawer").innerHTML = html;
    byId("drawer-close").addEventListener("click", closeDrawer);
    Array.prototype.forEach.call(byId("drawer").querySelectorAll(".dtab"), function (btn) {
      btn.addEventListener("click", function () { S.drawerTab = btn.getAttribute("data-tab"); renderDrawer(); });
    });
  }

  function drawerTab(a, r) {
    if (S.drawerTab === "reach") {
      return '<table class="reach-t"><thead><tr><th>Connection</th><th>Kind</th><th>Permissions</th></tr></thead><tbody>' +
        (a.tools || []).map(function (c) {
          var t = D.TOOLS[c.tool] || { name: c.tool, kind: "api" };
          return "<tr><td><b>" + esc(t.name) + "</b><div class='td-sub'>" + esc(t.desc || "") + "</div></td>" +
            "<td><span class='kind'>" + esc(t.kind) + "</span></td>" +
            "<td>" + (c.perms || []).map(function (p) {
              var hot = ["write", "send", "admin"].indexOf(p) !== -1;
              return '<span class="perm' + (hot ? " hot" : "") + '">' + esc(p) + "</span>";
            }).join(" ") + "</td></tr>";
        }).join("") + "</tbody></table>";
    }
    if (S.drawerTab === "risk") {
      if (!r.factors.length) return '<p class="empty">No risk factors — this agent is clean by every rule in the book.</p>';
      return r.factors.map(function (f) {
        return '<div class="factor ' + f.severity + '"><div class="factor-top">' +
          '<span class="lvl ' + f.severity + '">' + f.severity.toUpperCase() + '</span>' +
          '<b>' + esc(f.label) + '</b><span class="fwt">+' + f.weight + '</span></div>' +
          '<p><span class="pk">Problem —</span> ' + esc(f.problem) + '</p>' +
          '<p><span class="pk fix">Fix —</span> ' + esc(f.fix) + '</p></div>';
      }).join("");
    }
    if (S.drawerTab === "flows") {
      var ins = [], outs = [];
      (a.tools || []).forEach(function (c) {
        var t = D.TOOLS[c.tool] || { name: c.tool };
        (c.perms || []).forEach(function (p) {
          if (p === "read") ins.push(t.name);
          if (["write", "send"].indexOf(p) !== -1) outs.push(t.name + " (" + p + ")");
        });
      });
      var uniq = function (arr) { return arr.filter(function (x, i) { return arr.indexOf(x) === i; }); };
      return '<div class="flowstrip">' +
        '<div class="flow-col"><div class="flow-t">Enters here</div>' +
        ((a.data || []).map(function (d) { return '<span class="chip warn">' + esc(d) + '</span>'; }).join("") || '<span class="dim">no sensitive data</span>') +
        '<div class="flow-via">via ' + (uniq(ins).join(", ") || "—") + '</div></div>' +
        '<div class="flow-arrow">→</div>' +
        '<div class="flow-col agent"><div class="flow-t">' + esc(a.name) + '</div><span class="dim">processes &amp; decides</span></div>' +
        '<div class="flow-arrow">→</div>' +
        '<div class="flow-col"><div class="flow-t">Could exit via</div>' +
        (uniq(outs).map(function (o) { return '<span class="chip hot">' + esc(o) + '</span>'; }).join("") || '<span class="dim">no egress permissions</span>') +
        '</div></div>' +
        '<p class="flow-note">Taint journey: where sensitive data enters, and every channel it could leave through. Follow the strip when scoping a revocation.</p>';
    }
    if (S.drawerTab === "activity") {
      var pct = Math.min(100, Math.round(((a.tokenAgeDays || 0) / 365) * 100));
      return '<div class="act-block"><div class="act-k">Stated intent</div><blockquote>' + esc(a.intent || a.purpose) + '</blockquote></div>' +
        (a.drift ? '<div class="act-block warnbox"><div class="act-k">Drift detected</div><p>' + esc(a.driftNote || "Behavior differs from stated intent.") + '</p></div>' : '<div class="act-block okbox"><div class="act-k">Drift</div><p>No drift detected — activity matches stated intent.</p></div>') +
        '<div class="act-grid">' +
        '<div><div class="act-k">Credential age</div><div class="meter"><div class="meter-fill' + ((a.tokenAgeDays || 0) > 90 ? " bad" : "") + '" style="width:' + pct + '%"></div></div><div class="act-v">' + a.tokenAgeDays + ' days (guideline: 90)</div></div>' +
        '<div><div class="act-k">Last activity</div><div class="act-v">' + (a.lastActivityDays === 0 ? "today" : a.lastActivityDays + " day(s) ago") + '</div></div>' +
        '<div><div class="act-k">Human review</div><div class="act-v">' + (a.humanReview ? "required on actions" : "NOT required — autonomous") + '</div></div>' +
        '<div><div class="act-k">Owner</div><div class="act-v">' + esc(a.owner) + '</div></div></div>';
    }
    // tests
    var checks = [
      { name: "Registered in the ledger", pass: !!a.registered, note: a.registered ? "on the books" : "shadow — register or revoke" },
      { name: "Human review on actions", pass: !!a.humanReview, note: a.humanReview ? "approval step present" : "acts autonomously" },
      { name: "Least privilege", pass: R.actionPermCount(a) < 3, note: R.actionPermCount(a) + " action permission(s)" },
      { name: "Credential fresh (≤90d)", pass: (a.tokenAgeDays || 0) <= 90, note: (a.tokenAgeDays || 0) + " days old" },
      { name: "No toxic permission combos", pass: !r.factors.some(function (f) { return f.id.indexOf("toxic-") === 0; }), note: "combo rules clean" },
      { name: "Intent documented", pass: !!(a.intent && a.intent.length > 10), note: a.intent ? "intent on file" : "no intent recorded" }
    ];
    var passed = checks.filter(function (c) { return c.pass; }).length;
    return '<div class="tests-score">' + passed + ' / ' + checks.length + ' checks passing</div>' +
      checks.map(function (c) {
        return '<div class="check ' + (c.pass ? "pass" : "fail") + '"><span class="checkmark">' + (c.pass ? "✓" : "✕") + '</span>' +
          '<div><b>' + esc(c.name) + '</b><div class="td-sub">' + esc(c.note) + '</div></div></div>';
      }).join("");
  }

  // ---------------------------------------------------------------- shadow
  function renderShadow() {
    var el = byId("shadow");
    var res = S.shadowScan && S.shadowScan.result;
    var srcCards = D.DISCOVERY.map(function (s) {
      var foundList = res ? '<div class="src-found">' + s.found.map(function (n) {
        var isShadow = res.shadow.map(function (x) { return x.toLowerCase(); }).indexOf(n.toLowerCase()) !== -1;
        return '<span class="chip' + (isShadow ? " hot" : "") + '">' + esc(n) + '</span>';
      }).join("") + "</div>" : '<div class="src-found dim">not scanned yet</div>';
      return '<div class="src"><div class="src-t">' + esc(s.name) + '</div>' +
        '<div class="src-w">' + esc(s.where) + '</div>' + foundList + "</div>";
    }).join("");

    var resultHtml = "";
    if (res) {
      resultHtml = '<div class="shadow-verdict">' +
        '<div class="sv-nums"><div><b>' + res.registeredCount + '</b><span>you registered</span></div>' +
        '<div><b>' + res.foundCount + '</b><span>discovery found</span></div>' +
        '<div class="' + (res.shadow.length ? "bad" : "good") + '"><b>' + res.shadow.length + '</b><span>unaccounted</span></div></div>' +
        (res.shadow.length
          ? '<p class="sv-p">These showed up in your environment but are not on the books:</p>' +
            '<div class="chips">' + res.shadow.map(function (n) { return '<span class="chip hot">' + esc(n) + '</span>'; }).join("") + '</div>' +
            '<button class="btn primary" id="shadow-add">Add ' + res.shadow.length + ' to the registry as shadow</button>'
          : '<p class="sv-p good">Everything discovered is on the books. Nice — no shadow agents.</p>') +
        "</div>";
    } else {
      resultHtml = '<div class="shadow-idle"><p>Discovery scans five local sources — MCP configs, CLI tools, browser extensions, SaaS OAuth grants, local daemons — and compares what it finds against your registered agents.</p>' +
        '<button class="btn primary" id="shadow-run">Run discovery scan</button></div>';
    }

    el.innerHTML = '<div class="shadow-grid"><div class="srcs">' + srcCards + '</div><div class="shadow-side">' + resultHtml + "</div></div>";

    var run = byId("shadow-run");
    if (run) run.addEventListener("click", runShadowScan);
    var add = byId("shadow-add");
    if (add) add.addEventListener("click", addShadowAgents);
  }

  function runShadowScan() {
    var result = R.shadowDiff(S.agents, D.DISCOVERY);
    S.shadowScan = { done: true, result: result };
    saveState(); renderShadow();
    toast("Discovery found " + result.foundCount + " agents — " + result.shadow.length + " unaccounted.");
  }

  function addShadowAgents() {
    var res = S.shadowScan && S.shadowScan.result;
    if (!res) return;
    var added = 0;
    res.shadow.forEach(function (name) {
      var seed = D.AGENTS.filter(function (a) { return a.name.toLowerCase() === name.toLowerCase(); })[0];
      if (!seed) return;
      if (getAgent(seed.id)) return;
      S.agents.push(JSON.parse(JSON.stringify(seed)));
      added++;
    });
    S.shadowScan = null; // scan again to confirm clean
    saveState(); renderAll();
    toast(added ? added + " shadow agent(s) added to the registry." : "Already on the books.");
  }

  // ----------------------------------------------------------------- modal
  function openModal(id) {
    S.editingId = id || null;
    var a = id ? getAgent(id) : null;
    var toolRows = D.PRESET_TOOLS.map(function (t) {
      var conn = a && (a.tools || []).filter(function (c) { return c.tool === t.id; })[0];
      var perms = conn ? conn.perms : [];
      return '<label class="toolrow"><input type="checkbox" class="m-tool" value="' + t.id + '"' + (conn ? " checked" : "") + '> ' +
        '<span class="toolrow-n">' + esc(t.name) + ' <i>' + esc(t.kind) + '</i></span>' +
        '<span class="toolrow-p">' + ["read", "write", "send", "admin"].map(function (p) {
          return '<label><input type="checkbox" class="m-perm" data-tool="' + t.id + '" value="' + p + '"' +
            (perms.indexOf(p) !== -1 ? " checked" : "") + "> " + p + "</label>";
        }).join("") + "</span></label>";
    }).join("");
    var dataTypes = ["PII", "secrets", "prod-db", "code", "none"].map(function (d) {
      var on = a && (a.data || []).indexOf(d) !== -1;
      return '<label class="inl"><input type="checkbox" class="m-data" value="' + d + '"' + (on ? " checked" : "") + "> " + d + "</label>";
    }).join("");
    var presetOpts = D.PRESET_AGENTS.map(function (p) {
      return '<option value="' + esc(p.name) + '">' + esc(p.name) + " — " + esc(p.platform) + "</option>";
    }).join("");

    byId("modal-body").innerHTML =
      '<h2>' + (a ? "Edit agent" : "Register an agent") + '</h2>' +
      (a ? "" : '<label class="fld"><span>Start from a preset</span><select id="m-preset"><option value="">— pick one —</option>' + presetOpts + "</select></label>") +
      '<div class="fld2">' +
      '<label class="fld"><span>Name *</span><input id="m-name" value="' + esc(a ? a.name : "") + '"></label>' +
      '<label class="fld"><span>Owner *</span><input id="m-owner" value="' + esc(a ? a.owner : "Alex") + '"></label></div>' +
      '<div class="fld2">' +
      '<label class="fld"><span>Platform</span><input id="m-platform" value="' + esc(a ? a.platform : "") + '"></label>' +
      '<label class="fld"><span>Status</span><select id="m-status">' +
      ["sanctioned", "review", "blocked"].map(function (st) {
        return '<option value="' + st + '"' + (a && a.status === st ? " selected" : "") + ">" + st + "</option>";
      }).join("") + "</select></label></div>" +
      '<label class="fld"><span>Purpose *</span><input id="m-purpose" value="' + esc(a ? a.purpose : "") + '"></label>' +
      '<label class="fld"><span>Stated intent</span><input id="m-intent" value="' + esc(a ? a.intent : "") + '" placeholder="What it is supposed to do — and not do"></label>' +
      '<div class="fld"><span>Connections — pick tools, tick permissions</span><div class="toolrows">' + toolRows + "</div></div>" +
      '<div class="fld"><span>Data types touched</span><div>' + dataTypes + "</div></div>" +
      '<div class="fld2">' +
      '<label class="fld"><span>Credential age (days)</span><input id="m-token" type="number" min="0" value="' + (a ? a.tokenAgeDays : 30) + '"></label>' +
      '<label class="fld"><span>Last activity (days ago)</span><input id="m-active" type="number" min="0" value="' + (a ? a.lastActivityDays : 0) + '"></label></div>' +
      '<div class="fld2">' +
      '<label class="fld"><span>Cost / month ($)</span><input id="m-cost" type="number" min="0" value="' + (a ? a.costPerMonth : 0) + '"></label>' +
      '<label class="fld"><span>Hours saved / month</span><input id="m-hours" type="number" min="0" value="' + (a ? a.hoursSaved : 0) + '"></label></div>' +
      '<label class="inl big"><input type="checkbox" id="m-review"' + (!a || a.humanReview ? " checked" : "") + "> Human review required before actions</label>" +
      '<div class="modal-foot"><span class="m-err" id="m-err"></span>' +
      '<button class="btn ghost" id="m-cancel">Cancel</button>' +
      '<button class="btn primary" id="m-save">' + (a ? "Save changes" : "Add to ledger") + "</button></div>";

    byId("modal").classList.add("open");
    byId("scrim").classList.add("open");

    var preset = byId("m-preset");
    if (preset) preset.addEventListener("change", function () {
      var p = D.PRESET_AGENTS.filter(function (x) { return x.name === preset.value; })[0];
      if (p) { byId("m-name").value = p.name; byId("m-platform").value = p.platform; byId("m-purpose").value = p.purpose; }
    });
    byId("m-cancel").addEventListener("click", closeModal);
    byId("m-save").addEventListener("click", saveModal);
  }
  function closeModal() {
    S.editingId = null;
    byId("modal").classList.remove("open");
    if (!S.drawer) byId("scrim").classList.remove("open");
  }

  function saveModal() {
    function val(id) { return byId(id).value.trim(); }
    var tools = [];
    Array.prototype.forEach.call(document.querySelectorAll(".m-tool:checked"), function (cb) {
      var perms = [];
      Array.prototype.forEach.call(document.querySelectorAll('.m-perm[data-tool="' + cb.value + '"]:checked'), function (p) {
        perms.push(p.value);
      });
      if (!perms.length) perms = ["read"];
      tools.push({ tool: cb.value, perms: perms });
    });
    var data = [];
    Array.prototype.forEach.call(document.querySelectorAll(".m-data:checked"), function (cb) { data.push(cb.value); });

    var obj = {
      id: S.editingId || ("a-" + Date.now().toString(36)),
      name: val("m-name"),
      owner: val("m-owner"),
      platform: val("m-platform") || "unspecified",
      purpose: val("m-purpose"),
      intent: val("m-intent"),
      drift: false, driftNote: "",
      status: val("m-status"),
      registered: true,
      tools: tools,
      data: data,
      humanReview: byId("m-review").checked,
      tokenAgeDays: Math.max(0, parseInt(byId("m-token").value, 10) || 0),
      lastActivityDays: Math.max(0, parseInt(byId("m-active").value, 10) || 0),
      costPerMonth: Math.max(0, parseFloat(byId("m-cost").value) || 0),
      hoursSaved: Math.max(0, parseFloat(byId("m-hours").value) || 0)
    };
    var errors = R.validateAgent(obj);
    if (errors.length) { byId("m-err").textContent = errors[0]; return; }

    if (S.editingId) {
      var i = S.agents.findIndex(function (x) { return x.id === S.editingId; });
      if (i !== -1) S.agents[i] = obj;
      toast(obj.name + " updated.");
    } else {
      S.agents.push(obj);
      toast(obj.name + " added to the ledger.");
    }
    closeModal(); saveState(); renderAll();
  }

  // ---------------------------------------------------------------- export
  function exportPack() {
    var md = R.auditMarkdown({ agents: S.agents }, D.HOURLY_RATE);
    var date = new Date().toISOString().slice(0, 10);
    var blob = new Blob([md], { type: "text/markdown" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "agentledger-audit-" + date + ".md";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    toast("Audit pack exported as Markdown.");
  }

  // --------------------------------------------------------------- render
  function renderAll() {
    renderKpis();
    renderMap();
    renderFindings();
    renderRegistry();
    renderShadow();
    if (S.drawer) renderDrawer();
  }

  function wire() {
    byId("btn-export").addEventListener("click", exportPack);
    byId("btn-add").addEventListener("click", function () { openModal(null); });
    byId("btn-reset").addEventListener("click", function () {
      if (window.confirm("Restore the seeded demo data? Your local changes will be discarded.")) resetDemo();
    });
    byId("scrim").addEventListener("click", function () { closeDrawer(); closeModal(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeDrawer(); closeModal(); }
    });
  }

  // ----------------------------------------------------------------- boot
  loadState();
  wire();
  renderAll();
})();
