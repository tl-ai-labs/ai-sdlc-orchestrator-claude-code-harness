import { loadAllPolicySummaries } from "@/lib/policies";
import Console from "@/components/Console";

// This reads plugin/config/policies/ fresh every request — a saved policy
// (or one dropped in by hand) must show up on next load without a rebuild.
export const dynamic = "force-dynamic";

export default async function Home() {
  const policies = loadAllPolicySummaries();
  return (
    <>
      <div className="real-banner">
        Reading and writing real files in <code className="mono">plugin/config/policies/</code>.
      </div>
      <Console initialPolicies={policies} />
    </>
  );
}
