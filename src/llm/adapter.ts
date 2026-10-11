/**
 * Thin provider adapter. The pipeline only ever sees this interface, so a
 * model (including an open-weight one) can be swapped without touching any
 * stage. Only the WORKER imports adapters; the server never calls a model.
 */
export interface LlmRequest {
  system: string;
  user: string;
  /** JSON Schema the response must satisfy. Providers that support structured output enforce it; we validate again with ajv regardless. */
  jsonSchema: Record<string, unknown>;
  maxTokens?: number;
}

export interface LlmResponse {
  text: string; // raw model text (expected to be JSON)
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  refused?: boolean;
}

export interface LlmAdapter {
  readonly name: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** Test double: returns canned text, records requests. */
export class FakeLlm implements LlmAdapter {
  readonly name = 'fake';
  readonly requests: LlmRequest[] = [];
  constructor(private readonly responses: string[]) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    const text = this.responses.shift() ?? '{"claims":[]}';
    return { text, model: 'fake', usage: { inputTokens: req.user.length / 4, outputTokens: text.length / 4 } };
  }
}
