"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ADAPTER_LABEL,
  KNOWN_ADAPTERS,
  PHASES,
  defaultAuthEnv,
  thinkingSupport,
  type KnownAdapter,
  type ModelConfig,
  type PolicySummary,
  type Tier,
} from "@/lib/policySchema";
import { buildCustomPolicy, renderPolicyYaml } from "@/lib/buildPolicy";
import { savePolicy } from "@/app/actions";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const TIER_LABEL: Record<Tier, string> = { off: "off", minimal: "min", low: "low", medium: "med", high: "high", xhigh: "xh", max: "max" };

const BLANK_MODEL_FORM = {
  id: "",
  adapter: "mcp:gemini-flash-server" as KnownAdapter,
  model_name: "",
  input: "",
  input_cached: "",
  output: "",
  authEnv: defaultAuthEnv("mcp:gemini-flash-server"),
};

export default function Editor({
  base,
  allPolicyIds,
  isNew,
  onBack,
  onSaved,
}: {
  base: PolicySummary;
  allPolicyIds: string[];
  isNew: boolean;
  onBack: () => void;
  onSaved: (summary: PolicySummary) => void;
}) {
  const router = useRouter();
  const [models, setModels] = useState<ModelConfig[]>([...base.models]);
  const [routing, setRouting] = useState<Record<string, string>>({ ...base.routing });
  const [thinking, setThinking] = useState<Record<string, Tier>>({ ...base.thinking });
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ ok: boolean; errors: string[]; path?: string } | null>(null);
  const [addingModel, setAddingModel] = useState(false);
  const [modelForm, setModelForm] = useState(BLANK_MODEL_FORM);

  const modelIds = models.map((m) => m.id);
  const modelById = (mid: string) => models.find((m) => m.id === mid);

  function setPhaseModel(phaseId: string, modelId: string) {
    setRouting((r) => ({ ...r, [phaseId]: modelId }));
    // A tier the new model doesn't support would fail validation silently
    // until save — clamp it here so the picker never shows a stale,
    // now-invalid selection.
    const model = modelById(modelId);
    const supported = model ? thinkingSupport(model) : [];
    setThinking((t) => (supported.includes(t[phaseId]) ? t : { ...t, [phaseId]: "off" }));
  }

  const modelFormErrors = useMemo(() => {
    const errs: string[] = [];
    const id = modelForm.id.trim();
    if (!id) errs.push("Model id is required.");
    else {
      if (!NAME_PATTERN.test(id)) errs.push("Model id must be lowercase, filesystem-safe (letters, digits, hyphens).");
      if (modelIds.includes(id)) errs.push(`Model id "${id}" is already used in this policy.`);
    }
    if (!modelForm.model_name.trim()) errs.push("Model name (the vendor's real model string) is required.");
    for (const [label, v] of [["Input", modelForm.input], ["Cached input", modelForm.input_cached], ["Output", modelForm.output]] as const) {
      const n = Number(v);
      if (v.trim() === "" || Number.isNaN(n) || n < 0) errs.push(`${label} price must be a number ≥ 0.`);
    }
    return errs;
  }, [modelForm, modelIds]);

  function addModel() {
    if (modelFormErrors.length) return;
    const newModel: ModelConfig = {
      id: modelForm.id.trim(),
      adapter: modelForm.adapter,
      model_name: modelForm.model_name.trim(),
      pricing: { input: Number(modelForm.input), input_cached: Number(modelForm.input_cached), output: Number(modelForm.output) },
      auth: { env: modelForm.authEnv.trim() || defaultAuthEnv(modelForm.adapter) },
    };
    setModels((m) => [...m, newModel]);
    setModelForm(BLANK_MODEL_FORM);
    setAddingModel(false);
  }

  const hasChanges = useMemo(
    () =>
      JSON.stringify(routing) !== JSON.stringify(base.routing) ||
      JSON.stringify(thinking) !== JSON.stringify(base.thinking) ||
      models.length !== base.models.length,
    [routing, thinking, models, base]
  );

  const validation = useMemo(() => {
    const errs: string[] = [];
    const trimmed = name.trim();
    if (trimmed) {
      if (allPolicyIds.includes(trimmed)) {
        errs.push(`Name "${trimmed}" already exists — pick a name that isn't ${allPolicyIds.join(", ")}.`);
      }
      if (!NAME_PATTERN.test(trimmed)) {
        errs.push("Name must be lowercase, filesystem-safe (letters, digits, hyphens).");
      }
    }
    return { errs, name: trimmed };
  }, [name, allPolicyIds]);

  const previewYaml = useMemo(() => {
    const draft = buildCustomPolicy(
      { version: 1, select: base.select, structural: base.structural },
      { baseId: base.id, name: validation.name || "<name>", models, routing, thinking }
    );
    return renderPolicyYaml(draft, base.id);
  }, [models, routing, thinking, validation.name, base]);

  async function handleSave() {
    if (validation.errs.length || !validation.name) return;
    setSaving(true);
    const result = await savePolicy({ baseId: base.id, name: validation.name, models, routing, thinking });
    setSaving(false);
    setSaveResult(result);
    if (result.ok) {
      onSaved({
        id: validation.name,
        origin: "custom",
        desc: `Customized from ${base.id}.`,
        models,
        select: base.select,
        routing: { ...routing },
        thinking: { ...thinking },
        structural: base.structural,
      });
      router.refresh();
    }
  }

  return (
    <div>
      <div className="real-banner">
        Saving writes a real file to <code className="mono">plugin/config/policies/</code>. The base policy is never modified.
      </div>
      <header className="topbar">
        <div className="topbar-inner">
          <button className="back-link" onClick={onBack}>
            ← Back to policies
          </button>
          <div className="title-row">
            <div>
              <span className="eyebrow">ai-sdlc-orchestrator · plugin/config/policies</span>
              <h1>{isNew ? "Add a new policy" : `Customize “${base.id}”`}</h1>
            </div>
            <div className="pipeline-order">
              Pipeline order: <span className="mono">requirements → design → plan → codegen → tests → docs → review → security → debug</span>
            </div>
          </div>
          <div className="controls-row">
            <div className="field">
              <label>Base policy</label>
              <input type="text" value={base.id} disabled />
            </div>
            <div className="field">
              <label htmlFor="policyName">Save as</label>
              <input
                id="policyName"
                type="text"
                placeholder="e.g. strict-review"
                autoComplete="off"
                spellCheck={false}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="spacer" />
            <button
              className="btn ghost"
              onClick={() => {
                setModels([...base.models]);
                setRouting({ ...base.routing });
                setThinking({ ...base.thinking });
                setName("");
                setSaveResult(null);
              }}
            >
              Reset changes
            </button>
            <button className="btn" onClick={onBack}>
              Use as-is
            </button>
            <button
              className="btn primary"
              disabled={saving || validation.errs.length > 0 || !validation.name}
              onClick={handleSave}
            >
              {saving ? "Saving…" : "Save & continue"}
            </button>
          </div>
        </div>
      </header>

      <div className="shell">
        <section className="module route">
          <div className="module-head">
            <span className="swatch" />
            <div>
              <h2>Models in this policy</h2>
              <p>Every phase below routes to one of these. Add a model to make it selectable — it's written into the saved policy's own <span className="mono">models:</span> block.</p>
            </div>
          </div>
          <div className="model-list">
            {models.map((m) => (
              <div className="model-chip" key={m.id}>
                <span className="mid mono">{m.id}</span>
                <span className="adapter-badge">{ADAPTER_LABEL[m.adapter as KnownAdapter] ?? m.adapter}</span>
                <span className="mono">{m.model_name}</span>
                <span className="rate tnum">${m.pricing.input.toFixed(2)} in / ${m.pricing.output.toFixed(2)} out /1M</span>
              </div>
            ))}
          </div>
          {addingModel ? (
            <div className="add-model-form">
              <div className="field">
                <label>Model id</label>
                <input type="text" placeholder="e.g. gemini-3-pro" value={modelForm.id} onChange={(e) => setModelForm((f) => ({ ...f, id: e.target.value }))} />
              </div>
              <div className="field">
                <label>Adapter</label>
                <select
                  value={modelForm.adapter}
                  onChange={(e) => {
                    const adapter = e.target.value as KnownAdapter;
                    setModelForm((f) => ({ ...f, adapter, authEnv: defaultAuthEnv(adapter) }));
                  }}
                >
                  {KNOWN_ADAPTERS.map((a) => (
                    <option key={a} value={a}>
                      {ADAPTER_LABEL[a]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Model name (vendor string)</label>
                <input type="text" placeholder="e.g. gemini-3.0-pro" value={modelForm.model_name} onChange={(e) => setModelForm((f) => ({ ...f, model_name: e.target.value }))} />
              </div>
              <div className="field">
                <label>Credential env var</label>
                <input type="text" value={modelForm.authEnv} onChange={(e) => setModelForm((f) => ({ ...f, authEnv: e.target.value }))} />
              </div>
              <div className="field">
                <label>Input $/1M</label>
                <input type="text" inputMode="decimal" placeholder="0.00" value={modelForm.input} onChange={(e) => setModelForm((f) => ({ ...f, input: e.target.value }))} />
              </div>
              <div className="field">
                <label>Cached input $/1M</label>
                <input type="text" inputMode="decimal" placeholder="0.00" value={modelForm.input_cached} onChange={(e) => setModelForm((f) => ({ ...f, input_cached: e.target.value }))} />
              </div>
              <div className="field">
                <label>Output $/1M</label>
                <input type="text" inputMode="decimal" placeholder="0.00" value={modelForm.output} onChange={(e) => setModelForm((f) => ({ ...f, output: e.target.value }))} />
              </div>
              <div className="add-model-actions">
                {modelFormErrors.length > 0 && (
                  <ul className="form-errors">
                    {modelFormErrors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                )}
                <div>
                  <button className="btn ghost" onClick={() => { setAddingModel(false); setModelForm(BLANK_MODEL_FORM); }}>
                    Cancel
                  </button>
                  <button className="btn primary" disabled={modelFormErrors.length > 0} onClick={addModel}>
                    Add model
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <button className="btn ghost add-model-btn" onClick={() => setAddingModel(true)}>
              + Add model
            </button>
          )}
        </section>

        <section className="module route">
          <div className="module-head">
            <span className="swatch" />
            <div>
              <h2>Routing &amp; thinking capacity — per phase</h2>
              <p>
                The thinking picker sits next to each model and shows that model&rsquo;s own real range — Gemini&rsquo;s named levels,
                Opus&rsquo;s effort levels (see <span className="mono">plugin/policy-console/README.md</span>).
              </p>
            </div>
          </div>
          <div className="rows">
            {PHASES.map((phase) => {
              const routingChanged = routing[phase.id] !== base.routing[phase.id];
              const thinkingChanged = thinking[phase.id] !== base.thinking[phase.id];
              const model = modelById(routing[phase.id]);
              const supported = model ? thinkingSupport(model) : [];
              return (
                <div className={`row${routingChanged || thinkingChanged ? " changed" : ""}`} key={phase.id}>
                  <div className="phase">
                    {phase.label}
                    <small>{phase.note}{phase.id === "codegen" ? " · shared by 16 task types" : ""}</small>
                  </div>
                  <div className="model-thinking-pair">
                    <select value={routing[phase.id]} onChange={(e) => setPhaseModel(phase.id, e.target.value)}>
                      {modelIds.map((mid) => (
                        <option key={mid} value={mid}>
                          {mid}
                        </option>
                      ))}
                    </select>
                    {supported.length > 0 ? (
                      <div className="seg">
                        {supported.map((tier) => (
                          <button
                            key={tier}
                            type="button"
                            className={thinking[phase.id] === tier ? "active" : ""}
                            title={`Thinking: ${tier}`}
                            onClick={() => setThinking((t) => ({ ...t, [phase.id]: tier }))}
                          >
                            {TIER_LABEL[tier]}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <span className="no-thinking" title={`${model?.id ?? "This model"} has no graded thinking range to pick from`}>
                        Not available
                      </span>
                    )}
                  </div>
                  <div className="rate tnum">
                    {model && (
                      <>
                        <b>${model.pricing.input.toFixed(2)}</b> in / <b>${model.pricing.output.toFixed(2)}</b> out /1M
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <div className="validation">
          <div className={`valid-banner ${saveResult ? (saveResult.ok ? "ok" : "err") : validation.errs.length ? "err" : "ok"}`}>
            {saveResult ? (
              saveResult.ok ? (
                <div>
                  <strong>Saved.</strong> {saveResult.path} written. It&rsquo;s also now listed on the Policies screen.{" "}
                  <button className="btn ghost" style={{ marginTop: 8 }} onClick={onBack}>
                    View in Policies →
                  </button>
                </div>
              ) : (
                <div>
                  <strong>Save failed</strong>
                  <ul>
                    {saveResult.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </div>
              )
            ) : validation.errs.length ? (
              <div>
                <strong>Cannot save yet</strong>
                <ul>
                  {validation.errs.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            ) : !validation.name ? (
              <div>
                Give the customized policy a name to enable <strong>Save &amp; continue</strong>.{" "}
                {hasChanges ? "Changes detected against the base policy." : `No changes yet — “Use as-is” goes back to the gallery.`}
              </div>
            ) : (
              <div>
                Valid. Will write <strong>plugin/config/policies/{validation.name}.yaml</strong>.
              </div>
            )}
          </div>
        </div>

        <div className="output">
          <div className="output-head">
            <h2>Generated policy YAML</h2>
            <span className="path mono">plugin/config/policies/{validation.name || "<name>"}.yaml</span>
          </div>
          <pre className="mono">{previewYaml}</pre>
        </div>
      </div>
    </div>
  );
}
