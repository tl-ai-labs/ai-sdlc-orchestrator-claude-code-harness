"""gemini_worker.py — the Gemini agent worker behind the `antigravity-worker` adapter.

WHAT: one subprocess per delegated call, launched by the MCP server's
AntigravityWorkerAdapter. It runs Gemini as an AGENT rather than as a model:
instead of receiving a prompt that another party assembled and replying with
prose, it is given a task description and a working directory, and it explores
that directory, runs shell commands and edits files itself. The work is done on
Gemini through the Antigravity SDK (`google-antigravity`).

WHY THIS EXISTS ALONGSIDE THE FLASH ADAPTER. The bundled MCP server already
talks to Gemini — `GeminiFlashAdapter` makes a single `generateContent` call
with no tools, so the orchestrating session reads every file, composes the whole
prompt, gets prose back and writes the result itself. That is a model call. This
worker is the other half of the axis: the same vendor, the same Vertex project,
reached through a doorway that lets the model act. Which of the two a run uses
is a policy choice (`select: gemini-flash`), not a code change.

WHY THE SDK AND NOT A CLI: an agent CLI prints prose only and reports no usage
numbers, so every call it serves records a null cost and a null model pin. The
SDK returns real `UsageMetadata` — prompt/candidate/thought/cached token counts
and the resolved model — which this script writes to a sidecar the server reads
back. That telemetry is the SDK's whole point here: a delegated call has to be
priceable and attributable, or the run cannot report what it spent.

The SDK's Gemini path is the verified-working one and the only path this worker
serves. Its Anthropic path is deliberately untouched: the SDK returns tool
results as `assistant` messages, which the Anthropic API rejects with a 400.

Autonomy: `policies=[policy.allow_all()]` plus `run_command` is what gives the
worker real agency — it edits files in the workspace and runs shell commands.
The call shape below (LocalAgentConfig / ModelTarget / VertexEndpoint /
GeminiModelOptions / Agent async-context / resolve()/text()/usage_metadata) is
not guessed API: it is a shape that has run live against Vertex and returned
real token counts.

Contract (all args required unless noted):
  --task-file PATH   file holding the caller-composed task description
  --model NAME       SDK model id, e.g. gemini-3.5-flash — always supplied by
                     the policy leaf; this file pins no model of its own
  --region NAME      OPTIONAL Vertex location, e.g. global or asia-south1. When
                     given it WINS over GOOGLE_CLOUD_LOCATION — see the
                     precedence note at the LOCATION assignment below.
  --workdir PATH     the working directory the worker is allowed to act in —
                     its only workspace. Everything it edits, it edits here.
  --out-dir PATH     where the usage sidecar and the SDK's save dir go
  --usage-file PATH  sidecar this worker WRITES: {model, thinking, usage, text,
                     tool_call_count, tool_calls, tool_calls_truncated}. The
                     tool_calls projection is what makes the WORKER's actions
                     visible at all — see _project_tool_call below.
  --thinking LEVEL   HIGH|MEDIUM|LOW|NONE (default NONE); resolved via getattr
                     so an unknown level fails loudly instead of at import
  --timeout SECONDS  hard cap on resolve() (default 540)

Cost is NOT computed here: token counts are recorded raw; dollar cost is applied
by the server against the rates declared on the policy leaf, never a rate
hardcoded in the worker. That is the same convention `pricing.ts` already
follows for every other model the server dispatches to.

Runtime: Python >= 3.10 with `google-antigravity` installed (see
worker/requirements.txt), and Google application default credentials that can
reach the Vertex project. Both are checked by the plugin's setup and preflight
before any paid call is made.
"""
from __future__ import annotations

import argparse
import asyncio
import inspect
import json
import os
import sys

import google.antigravity as ag
from google.antigravity import types
from google.antigravity.hooks import policy

# SDK IDENTITY, recorded into every sidecar.
#
# Without this, a run's artifacts prove "a Gemini model answered" but not "the
# Antigravity SDK is what reached it" — and which doorway was used is precisely
# the thing a delegated call exists to demonstrate, so it should not rest on the
# reader trusting a file header. importlib.metadata reads the version from the
# INSTALLED distribution, so an environment rebuilt on a newer SDK reports the
# newer number without anyone remembering to edit a constant.
#
# Wrapped because the dist name can be absent in an editable or vendored
# install: an unknown version must degrade to a string, never take down a call
# that was going to succeed. Evidence is worth less than the run.
try:
    from importlib.metadata import version as _dist_version
    SDK_VERSION = _dist_version("google-antigravity")
except Exception:  # not installed as a distribution — record it as unknown
    SDK_VERSION = "unknown"
SDK_NAME = "google-antigravity"

# PROJECT AND REGION HAVE NO DEFAULTS HERE, AND THAT IS THE POINT.
#
# The version of this worker that ran inside a private experiment repo defaulted
# the project to that repo's own Google Cloud project and the region to
# asia-south1, because there it was always the right answer and one-off scripts
# invoked the worker with no flags at all. Neither assumption survives being
# published: a default project silently bills somebody else's account, and a
# default region silently sends a stranger's tokens to Mumbai. So both are
# resolved from the caller, and their absence is a loud failure rather than a
# quiet guess.
#
# REGION PRECEDENCE: --region > GOOGLE_CLOUD_LOCATION > hard error. The flag
# outranks the environment because the policy leaf is what declares the region,
# and that declaration is what the run's manifest records and what the report
# prices the call against. If the environment could win, a policy could say
# `global` while every token was billed in asia-south1 and no artifact anywhere
# would disagree — a receipt that cannot contradict its environment is not
# evidence of anything.
#
# It matters concretely, not just in principle: some models are served on the
# `global` endpoint only and return 404 "Publisher model ... not found"
# elsewhere, so a mis-steered policy dies on its first delegated call — several
# phases into a paid run — with the correct region sitting plainly in the file
# it was launched with.
#
# The environment is still honoured when --region is absent, so an operator can
# retarget a one-off invocation with an export instead of editing a policy.
PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT")
LOCATION = os.environ.get("GOOGLE_CLOUD_LOCATION")


async def _maybe(v):
    # ChatResponse methods may be sync or awaitable depending on SDK version.
    # Await only when awaitable.
    return await v if inspect.isawaitable(v) else v


# How many worker tool calls the sidecar records in full. An earlier value of 50
# was binding rather than theoretical: a sweep of the delegated calls on record
# found some sitting at exactly 50 — i.e. clipped — while their receipts read
# like complete counts.
#
# Raising it costs nothing. `resp.resolve()` in run() drains the whole stream
# into the ChatResponse's internal buffer BEFORE _drain iterates it, so every
# ToolCall object is already materialised in memory by then; the cap never saved
# an allocation, it only discarded evidence on the way out. The ceiling stays
# finite solely to bound the sidecar against a runaway agent.
TOOL_CALL_CAP = 1000

# Per-argument character ceiling for the recorded projection. A create_file call
# carries an entire file body in its args and the receipt does not need it: what
# landed in the tree is on disk, byte for byte. What the receipt DOES need is
# the SHAPE of the call — which tool, which path, which command — and 2000
# characters holds any realistic shell command whole while keeping even a
# 1000-call sidecar bounded.
ARG_VALUE_CAP = 2000


async def _drain(gen, cap=TOOL_CALL_CAP):
    # .tool_calls is an ASYNC GENERATOR (not a property) — reading it as an
    # attribute returns a bound method and looks like an empty result. Iterate it.
    #
    # Returns (items, truncated). The second value is the whole point: a list
    # that hit the ceiling must SAY it hit the ceiling, otherwise a count of
    # 1000 reads as a measurement when the truth is "1000 or more, we stopped
    # looking". Same never-state-an-unmeasured-number rule this repo already
    # applies to cost: an unknown price is reported absent, never as $0.0000.
    out = []
    truncated = False
    try:
        async for item in gen:
            out.append(item)
            if len(out) >= cap:
                truncated = True
                break
    except Exception:
        pass
    return out, truncated


def _project_tool_call(tc):
    """One ToolCall reduced to the fields a reader of the run needs.

    WHY A PROJECTION AND NOT JUST A COUNT. In a delegated call the worker is the
    party with hands on the working directory — the orchestrating session hands
    over a task and waits. A bare `tool_call_count` therefore leaves the run
    able to describe everything the orchestrator did and nothing the worker did,
    which is backwards. A count cannot answer "which files did it touch" or
    "what commands did it run".

    The SDK gives us everything needed already — types.ToolCall is a pydantic
    model carrying `name` (a BuiltinTools member such as run_command /
    edit_file / read_url_content, or a plain string), `args` as a
    JSON-serialisable dict, and `canonical_path`, the Connection layer's
    normalised filesystem path for file tools. model_dump(mode="json") renders
    the enum as its string value, which is what the JS side matches on.

    Every arg VALUE is rendered to a string here and clipped at ARG_VALUE_CAP.
    Uniform strings keep the consumer trivial (it matches text and never has to
    type-switch), and the clip keeps a file body out of a receipt that exists to
    record intent. `args_clipped` marks it when it happens, for the same reason
    `tool_calls_truncated` marks the list-level ceiling.
    """
    d = tc.model_dump(mode="json") if hasattr(tc, "model_dump") else dict(tc)
    args, clipped = {}, False
    for k, v in (d.get("args") or {}).items():
        s = v if isinstance(v, str) else json.dumps(v, default=str)
        if len(s) > ARG_VALUE_CAP:
            s, clipped = s[:ARG_VALUE_CAP], True
        args[k] = s
    return {
        "name": d.get("name"),
        "args": args,
        "canonical_path": d.get("canonical_path"),
        "args_clipped": clipped,
    }


def _thinking_level(name):
    name = (name or "NONE").upper()
    if name in ("", "NONE"):
        return None
    # getattr, not a module-level dict: referencing types.ThinkingLevel.MEDIUM
    # at import time would crash the whole worker if that member does not exist
    # in the installed SDK. Only HIGH is proven; others degrade to a clear error
    # rather than an import failure.
    level = getattr(types.ThinkingLevel, name, None)
    if level is None:
        raise SystemExit(f"gemini_worker: unknown --thinking level {name!r}")
    return level


async def run(args):
    with open(args.task_file, encoding="utf-8") as f:
        task = f.read()

    thinking = _thinking_level(args.thinking)
    opts = types.GeminiModelOptions(thinking_level=thinking) if thinking else None

    # The policy's declared region when the caller passed one, else the ambient
    # environment, else a refusal. Bound ONCE here and used for the endpoint, the
    # agent config and the sidecar, so the region the call went to and the region
    # the receipt claims cannot drift apart. See the precedence note above.
    location = args.region or LOCATION
    if not location:
        raise SystemExit(
            "gemini_worker: no Vertex region. Pass --region (the policy leaf's "
            "`region:`) or set GOOGLE_CLOUD_LOCATION. This worker pins no "
            "default because a wrong region is a silent billing and 404 hazard."
        )
    if not PROJECT:
        raise SystemExit(
            "gemini_worker: no Vertex project. Set GOOGLE_CLOUD_PROJECT to the "
            "project your application default credentials are authorised for. "
            "This worker pins no default because a wrong project bills the "
            "wrong account."
        )
    os.environ["GOOGLE_CLOUD_PROJECT"] = PROJECT
    os.environ["GOOGLE_CLOUD_LOCATION"] = location

    cfg = ag.LocalAgentConfig(
        model=types.ModelTarget(
            name=args.model, types=[types.ModelType.TEXT],
            endpoint=types.VertexEndpoint(
                project=PROJECT, location=location, options=opts),
        ),
        vertex=True, project=PROJECT, location=location,
        policies=[policy.allow_all()],
        # Single workspace = the directory the caller nominated. The worker can
        # act here and nowhere else; the server records what changed inside it.
        workspaces=[args.workdir],
        save_dir=os.path.join(args.out_dir, "_gemini_worker_save"),
    )

    text, usage, tool_calls, tool_calls_truncated = "", None, [], False
    async with ag.Agent(cfg) as agent:
        resp = await _maybe(agent.chat(task))
        await asyncio.wait_for(_maybe(resp.resolve()), timeout=args.timeout)
        try:
            text = await _maybe(resp.text())
        except Exception as e:  # never lose the usage numbers over a text error
            text = f"<worker text() error: {type(e).__name__}: {e}>"
        tool_calls, tool_calls_truncated = await _drain(resp.tool_calls)
        u = await _maybe(resp.usage_metadata)
        usage = u.model_dump() if hasattr(u, "model_dump") else (dict(u) if u else None)

    # Sidecar the server reads back (real token counts + resolved model).
    # cost_usd deliberately ABSENT — priced by the server against the rates on
    # the policy leaf, never invented here.
    with open(args.usage_file, "w", encoding="utf-8") as f:
        json.dump({
            "model": args.model,
            "thinking": (args.thinking or "NONE").upper(),
            # WHICH CABLE reached that model, and where it executed. Named
            # explicitly so the artifact answers "Antigravity SDK, version X,
            # against Vertex project P in region R" on its own, without the
            # reader inferring it from the script's name. See SDK_VERSION.
            "sdk": SDK_NAME,
            "sdk_version": SDK_VERSION,
            "vertex_project": PROJECT,
            "vertex_location": location,
            "usage": usage,
            "tool_call_count": len(tool_calls),
            # WHAT the worker did, not just how many times it did something.
            # These two fields are what lets the run's report say anything at
            # all about the delegated half of the work. See _project_tool_call.
            # `tool_calls_truncated` says out loud when the list stopped at
            # TOOL_CALL_CAP, so a ceiling is never mistaken for a total.
            "tool_calls_truncated": tool_calls_truncated,
            "tool_calls": [_project_tool_call(tc) for tc in tool_calls],
            "text": text,
        }, f, indent=2)

    print(text)  # the caller reads the reply on stdout


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--task-file", required=True)
    p.add_argument("--model", required=True)
    # OPTIONAL, and the only knob here whose default is "defer to the env".
    # The policy declares the region, the adapter passes it through, and when it
    # does it WINS over GOOGLE_CLOUD_LOCATION (see the precedence note at the
    # LOCATION constant). Absent, the environment applies; absent both, run()
    # refuses rather than guessing.
    p.add_argument("--region", default=None)
    p.add_argument("--workdir", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--usage-file", required=True)
    p.add_argument("--thinking", default="NONE")
    p.add_argument("--timeout", type=int, default=540)
    args = p.parse_args()
    try:
        asyncio.run(run(args))
    except Exception as e:
        # Non-zero exit + reason on stderr so the caller sees the failure and
        # can report it as a failed delegation rather than as work it did alone.
        print(f"gemini_worker failed: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
