/**
 * Enforces the policy's `hard_cost_cap_usd`. Every shipped policy declares the
 * field and the docs promise that a run stops when it is reached; before this
 * file nothing read it.
 *
 * The spend is summed from the run's telemetry FILE, never from memory: the
 * server restarts between sessions, and a cap that forgets what an earlier
 * session spent is no cap. Dispatched and direct-tier events land in the same
 * file, so both count.
 *
 * Failure direction: a missing or unreadable file means "nothing known to be
 * spent", and the dispatch goes ahead. Refusing on doubt would stop every run
 * whose telemetry path is simply not set yet.
 */
import { existsSync, readFileSync } from "node:fs";

export function runSpendUsd(events: Array<{ cost_usd?: unknown }>): number {
  let total = 0;
  for (const e of events) if (typeof e?.cost_usd === "number" && Number.isFinite(e.cost_usd)) total += e.cost_usd;
  return total;
}

export function checkCostCap(policy: { hard_cost_cap_usd?: unknown }, telemetryPath?: string): { ok: boolean; spent: number; cap: number | null } {
  const cap = typeof policy?.hard_cost_cap_usd === "number" && policy.hard_cost_cap_usd > 0 ? policy.hard_cost_cap_usd : null;
  if (cap === null || !telemetryPath || !existsSync(telemetryPath)) return { ok: true, spent: 0, cap };
  const events: Array<{ cost_usd?: unknown }> = [];
  try {
    for (const line of readFileSync(telemetryPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* a torn line is not spend */ }
    }
  } catch {
    return { ok: true, spent: 0, cap };
  }
  // Rounded to micro-dollars so 20 + 29.5 + 0.5 compares as exactly 50.
  const spent = Math.round(runSpendUsd(events) * 1e6) / 1e6;
  return { ok: spent < cap, spent, cap };
}
