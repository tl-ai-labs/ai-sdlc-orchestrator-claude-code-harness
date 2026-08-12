"use client";

import type { PolicySummary } from "@/lib/policySchema";
import { PHASES } from "@/lib/policySchema";

function modelSummaryLines(pol: PolicySummary) {
  const counts: Record<string, number> = {};
  for (const phaseId of Object.keys(pol.routing)) {
    const mid = pol.routing[phaseId];
    counts[mid] = (counts[mid] ?? 0) + 1;
  }
  return Object.entries(counts);
}

function rateRange(pol: PolicySummary) {
  const rates = pol.models.map((m) => m.pricing.input);
  const min = Math.min(...rates);
  const max = Math.max(...rates);
  return min === max ? `$${min.toFixed(2)}/1M in` : `$${min.toFixed(2)}–$${max.toFixed(2)}/1M in`;
}

function PolicyCard({ pol, onOpen }: { pol: PolicySummary; onOpen: () => void }) {
  return (
    <div className="policy-card">
      <div className="card-head">
        <span className="card-name mono">{pol.id}</span>
        <span className={`origin-tag ${pol.origin}`}>{pol.origin}</span>
      </div>
      <p className="card-desc">{pol.desc}</p>
      <div className="card-models">
        {modelSummaryLines(pol).map(([mid, n]) => (
          <div className="model-line" key={mid}>
            <span className="mid">{mid}</span>
            <span className="n">{n} phase{n === 1 ? "" : "s"}</span>
          </div>
        ))}
      </div>
      <div className="effort-strip">
        <span className="effort-strip-label">Thinking</span>
        {PHASES.map((p) => (
          <span key={p.id} className={`effort-dot ${pol.thinking[p.id]}`} title={`${p.label}: ${pol.thinking[p.id]}`} />
        ))}
      </div>
      <div className="card-foot">
        <span className="rate-chip tnum">{rateRange(pol)}</span>
      </div>
      <button className="btn primary" onClick={onOpen}>
        Customize
      </button>
    </div>
  );
}

export default function Gallery({
  policies,
  onOpen,
}: {
  policies: PolicySummary[];
  onOpen: (baseId: string, asNew: boolean) => void;
}) {
  const defaultBase = policies.find((p) => p.id === "opus-plus-flash")?.id ?? policies[0]?.id;

  return (
    <div>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="title-row">
            <div>
              <span className="eyebrow">ai-sdlc-orchestrator · plugin/config/policies</span>
              <h1>Policies</h1>
            </div>
            <div className="pipeline-order">
              Pipeline order: <span className="mono">requirements → design → plan → codegen → tests → docs → review → security → debug</span>
            </div>
          </div>
        </div>
      </header>
      <div className="shell">
        <p className="gallery-intro">
          Every card below is a real file in <span className="mono">plugin/config/policies/</span>. Open one to customize its routing
          and thinking capacity — saving always creates a new named policy, the original is never overwritten.
        </p>
        <div className="policy-grid">
          {policies.map((pol) => (
            <PolicyCard key={pol.id} pol={pol} onOpen={() => onOpen(pol.id, false)} />
          ))}
          <div className="new-policy-card" onClick={() => onOpen(defaultBase, true)}>
            <span className="plus">+</span>
            <span>Add a new policy</span>
          </div>
        </div>
      </div>
    </div>
  );
}
