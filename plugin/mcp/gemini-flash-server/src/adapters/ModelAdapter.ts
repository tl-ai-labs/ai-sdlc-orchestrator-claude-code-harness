/**
 * The ModelAdapter interface — every model (Anthropic, Google, OpenAI,
 * internal LLM) implements this so the orchestrator can call any of them
 * uniformly. Adding a third vendor = implementing one of these.
 */

import type { ExecutionResult, ModelConfig, RunContext, TaskPacket } from "../types.js";

export interface ModelAdapter {
  readonly id: string;
  readonly modelConfig: ModelConfig;

  /**
   * Execute one TaskPacket. Caller passes a cacheContext key — for vendors
   * supporting explicit context caching (e.g. Gemini), the adapter manages
   * a cache keyed on this value to amortize the stable project header.
   *
   * `runContext` says WHERE the run is happening — the workspace on disk and
   * where the run's telemetry is being written. Adapters that send text and
   * get text back ignore it entirely; adapters that delegate to an agent with
   * a working directory cannot function without it. It is optional so that
   * implementations which do not read it need no signature at all: TypeScript
   * accepts a two-parameter method wherever a three-parameter one is expected,
   * which is why adding this broke neither existing adapter.
   */
  execute(
    packet: TaskPacket,
    cacheContext?: string,
    runContext?: RunContext,
  ): Promise<ExecutionResult>;
}

export type AdapterFactory = (config: ModelConfig) => ModelAdapter;
