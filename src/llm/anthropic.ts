/**
 * Anthropic implementation of LlmAdapter.
 *
 * - Model from AUTOPIA_MODEL (default claude-opus-5-5).
 * - Structured output: output_config.format with our JSON Schema, so the
 *   response is schema-shaped at the source. We STILL validate with ajv.
 * - Streaming + finalMessage() so long outputs never hit HTTP timeouts.
 * - Server-side refusal fallback ("default" routing) is enabled so a policy
 *   decline re-runs on a fallback model inside the same call.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { LlmAdapter, LlmRequest, LlmResponse } from './adapter.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';

export class AnthropicAdapter implements LlmAdapter {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: { apiKey?: string; model?: string } = {}) {
    this.model = opts.model ?? process.env.AUTOPIA_MODEL ?? DEFAULT_MODEL;
    this.name = `anthropic:${this.model}`;
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const stream = this.client.beta.messages.stream({
      model: this.model,
      max_tokens: req.maxTokens ?? 16_000,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema', schema: req.jsonSchema } },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    const msg = await stream.finalMessage();
    const text = msg.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return {
      text,
      model: msg.model,
      usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
      refused: msg.stop_reason === 'refusal',
    };
  }
}

/** Returns an adapter if credentials are configured, else null (rules-only run). */
export function adapterFromEnv(): LlmAdapter | null {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return null;
  return new AnthropicAdapter();
}
