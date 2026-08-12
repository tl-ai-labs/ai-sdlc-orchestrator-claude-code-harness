"use client";

import { useState } from "react";
import type { PolicySummary } from "@/lib/policySchema";
import Gallery from "./Gallery";
import Editor from "./Editor";

export default function Console({
  initialPolicies,
}: {
  initialPolicies: PolicySummary[];
}) {
  const [policies, setPolicies] = useState(initialPolicies);
  const [view, setView] = useState<"gallery" | "editor">("gallery");
  const [editingBaseId, setEditingBaseId] = useState(initialPolicies[0]?.id ?? "");
  const [isNew, setIsNew] = useState(false);

  function openEditor(baseId: string, asNew: boolean) {
    setEditingBaseId(baseId);
    setIsNew(asNew);
    setView("editor");
  }

  function handleSaved(newSummary: PolicySummary) {
    setPolicies((prev) => [...prev, newSummary]);
  }

  if (view === "editor") {
    const base = policies.find((p) => p.id === editingBaseId) ?? policies[0];
    return (
      <Editor
        key={editingBaseId + String(isNew)}
        base={base}
        allPolicyIds={policies.map((p) => p.id)}
        isNew={isNew}
        onBack={() => setView("gallery")}
        onSaved={handleSaved}
      />
    );
  }

  return <Gallery policies={policies} onOpen={openEditor} />;
}
