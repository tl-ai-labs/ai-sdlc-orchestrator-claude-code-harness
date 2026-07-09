/**
 * The ModelAdapter interface — every model (Anthropic, Google, OpenAI,
 * internal LLM) implements this so the orchestrator can call any of them
 * uniformly. Adding a third vendor = implementing one of these.
 */

import type { ExecutionResult, ModelConfig, TaskPacket } from "../types.js";

export interface ModelAdapter {
  readonly id: string;
  readonly modelConfig: ModelConfig;

  /**
   * Execute one TaskPacket. Caller passes a cacheContext key — for vendors
   * supporting explicit context caching (e.g. Gemini), the adapter manages
   * a cache keyed on this value to amortize the stable project header.
   */
  execute(packet: TaskPacket, cacheContext?: string): Promise<ExecutionResult>;
}

export type AdapterFactory = (config: ModelConfig) => ModelAdapter;
