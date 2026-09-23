// Board page logic. Every value is written with textContent; nothing on this
// page is ever built as markup from data, so a path or label containing
// markup is shown as the plain characters it is.
(function () {
  "use strict";
  const token = new URLSearchParams(location.search).get("t") || "";
  const $ = (id) => document.getElementById(id);
  const usd = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(4);
  const count = (n, word) => n + " " + word + (n === 1 ? "" : "s");
  const time = (iso) => (iso ? new Date(iso).toLocaleTimeString() : "not yet");

  function fill(parent, rows) {
    while (parent.firstChild) parent.removeChild(parent.firstChild);
    for (const row of rows) parent.appendChild(row);
  }
  function el(tag, text, cls) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (cls) node.className = cls;
    return node;
  }
  function emptyRow(cols, text) {
    const tr = document.createElement("tr");
    const td = el("td", text, "empty");
    td.colSpan = cols;
    tr.appendChild(td);
    return tr;
  }

  function side(prefix, s) {
    fill($("steps" + prefix), s ? s.steps.map((st) => el("li", st.text)) : [el("li", "No session yet. Start one and it appears here.", "empty")]);
    $("touch" + prefix).textContent = count(s ? s.touches : 0, "prompt") + " typed";
    $("sum" + prefix).textContent = s ? usd(s.total_usd) + (s.done ? "" : " so far") : "$0.0000";
  }

  function render(d) {
    $("updated").textContent = "Updated " + time(d.generated_at) + " · cache prices: " + d.cache_tier + (d.headline.unpriced_requests ? " · " + d.headline.unpriced_requests + " requests ran on a model with no price card and are not in the dollars" : "") +
      (d.headline.worker_calls_unpriced ? " · " + d.headline.worker_calls_unpriced + " worker call" + (d.headline.worker_calls_unpriced === 1 ? "" : "s") + " got no answer; the vendor reports no usage for those, so they are not in the dollars" : "");
    const saved = d.headline.ledger_saved_usd;
    $("saved").textContent = usd(saved);
    $("saved").className = "num " + (saved < 0 ? "loss" : saved > 0 ? "gain" : "");
    $("savedCap").textContent = d.headline.actions === 0
      ? "The orchestrator has not shortened a file or handed work to a cheaper model yet, so nothing has been kept out."
      : "Dollars kept out so far across " + count(d.headline.actions, "action") + ", priced from what really happened after each one. Losses count as losses.";
    $("share").textContent = (100 * d.headline.worker_share).toFixed(1) + "%";
    $("counted").textContent = String(d.headline.sessions_total);
    $("countedCap").textContent = count(d.headline.sessions_total, "chat") + " recorded: " + count(d.headline.sessions_counted, "chat") + " with the orchestrator on, " + count(d.headline.sessions_rules_only || 0, "chat") + " rules only (no hand-overs), " + count(d.headline.sessions_total - d.headline.sessions_counted - (d.headline.sessions_rules_only || 0), "chat") + " plain.";

    // Side B is described from its record (data.mjs pair.b_kind), so a like-for-like B is never called "plain".
    const sideB = d.pair.b_kind === "plain" ? "Side B is plain Claude Code: no orchestrator at all."
      : d.pair.b_kind === "rules-only" ? "Side B runs the same orchestrator with hand-overs switched off, so the only difference between the sides is the hand-over itself."
      : "Side B runs without hand-overs; its box says whether that is the same orchestrator with hand-overs switched off, or plain Claude Code.";
    $("lead").textContent = "The same task is run twice. Side A runs with the intelligent orchestrator: it makes big file reads smaller, hands bulk typing (bug-fix code, repeated edits, new files, tests) to a cheaper model after code checks the work, and keeps the chat on the main model. " + sideB + " Everything on this page is read from real records on this machine; nothing is a sample.";
    $("headB").textContent = d.pair.b_kind === "plain" ? "B · plain Claude Code" : d.pair.b_kind === "rules-only" ? "B · rules only, no hand-overs" : "B · without hand-overs";
    side("A", d.pair.a);
    side("B", d.pair.b);
    $("pairNote").textContent = d.pair.note;
    const v = $("verdict");
    if (d.pair.both_done) {
      const gap = usd(Math.abs(d.pair.saving_usd)) + " (" + Math.abs(100 * d.pair.saving_share).toFixed(1) + "%)";
      const cheaper = d.pair.saving_usd >= 0 ? "A was " + gap + " cheaper than B." : "A was " + gap + " dearer than B.";
      v.className = "verdict";
      if (d.pair.a_actions === 0) {
        v.textContent = "Both finished. " + cheaper + " The orchestrator took no action in A, so this gap is normal run-to-run variation, not a saving.";
      } else {
        v.textContent = "Both finished. " + cheaper + " The orchestrator took " + count(d.pair.a_actions, "action") + " in A. " + (d.pair.like_for_like ? "B ran the same reading rules with cheaper-model jobs off, so this gap is the delegation alone. " : "B ran with nothing on, so this gap mixes the reading rules with the delegation. ") + "One pair is not proof either way; the 'kept out' figure at the top is what the orchestrator itself can account for.";
      }
    } else {
      v.className = "verdict wait";
      v.textContent = "The difference is shown only when both sides have finished, so a half-done side never looks cheap.";
    }

    fill($("sessions"), d.sessions.length ? d.sessions.map((s) => {
      const tr = document.createElement("tr");
      const armCell = document.createElement("td");
      armCell.appendChild(el("span", s.side === "on" ? "A · orchestrator" : s.side === "rules-only" ? "B · rules only" : "B · plain", "pill " + (s.side === "on" ? "on" : s.side === "rules-only" ? "rules" : "control")));
      tr.appendChild(armCell);
      tr.appendChild(el("td", s.label));
      tr.appendChild(el("td", s.repo_kind === "greenfield" ? "new project" : s.repo_kind === "brownfield" ? "existing code" : ""));
      tr.appendChild(el("td", s.done ? time(s.finished_at) : "running", "n"));
      tr.appendChild(el("td", s.touches, "n"));
      // The thinker's dollars include the chat's helper agents (Claude Code's Agent tool); say so when there were any.
      tr.appendChild(el("td", usd(s.thinker_usd) + (s.helper_agent_requests ? " (incl. " + s.helper_agent_requests + " helper-agent requests, " + usd(s.helper_agent_usd) + ")" : ""), "n"));
      tr.appendChild(el("td", usd(s.worker_usd), "n"));
      tr.appendChild(el("td", usd(s.total_usd), "n"));
      tr.appendChild(el("td", s.side === "on" && s.ledger_counted ? usd(s.ledger_saved_usd) : "not counted", "n"));
      return tr;
    }) : [emptyRow(9, "No sessions recorded yet. Turn ambient mode on and start a chat.")]);

    fill($("seeds"), d.seeds.length ? d.seeds.map((r) => {
      const tr = document.createElement("tr");
      for (const key of ["job", "files", "worker", "measured", "evidence", "decision", "source"]) tr.appendChild(el("td", r[key]));
      return tr;
    }) : [emptyRow(7, "No seed table found.")]);

    fill($("numbers"), (d.numbers || []).map((n) => {
      const tr = document.createElement("tr");
      tr.appendChild(el("td", n.name));
      tr.appendChild(el("td", n.value, "n"));
      tr.appendChild(el("td", n.from));
      return tr;
    }));
  }

  async function tick() {
    try {
      const res = await fetch("/data.json?t=" + encodeURIComponent(token), { cache: "no-store" });
      if (res.ok) render(await res.json());
    } catch (e) { /* the server was stopped; keep the last view */ }
  }
  tick();
  setInterval(tick, 2000);
})();
