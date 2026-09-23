import { createGeminiProvider } from './gemini.mjs';
import { createOpenAiCompatibleProvider } from './openai-compatible.mjs';

/**
 * Provider-neutral structured generation. Business logic only calls
 * `generateJson({ system, prompt, schema, images?, maxOutputTokens, signal })` and gets
 * `{ data, usage }` back; schemas are written in lower-case JSON Schema. `images`
 * ([{ mimeType, data: base64 }]) go to the model after the prompt text.
 *
 * Errors are LlmError with `kind`: unavailable | rate_limited | timeout | invalid_response | budget.
 */
export class LlmError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

const providers = { gemini: createGeminiProvider, 'openai-compatible': createOpenAiCompatibleProvider };

/** Returns null when no provider is configured; callers then use deterministic results only. */
export function createLlm({ provider = 'gemini', apiKey, model, baseUrl, fetcher = fetch, budget, timeoutMs = 45_000 } = {}) {
  if (!Object.hasOwn(providers, provider)) throw new Error(`Unknown LLM_PROVIDER: ${provider}`);
  if (!model || (provider === 'gemini' && !apiKey) || (provider === 'openai-compatible' && !baseUrl)) return null;
  const inner = providers[provider]({ apiKey, model, baseUrl, fetcher, LlmError });
  return {
    name: provider, model,
    async generateJson(request) {
      if (budget && !budget.reserve()) throw new LlmError('budget', 'daily AI request limit reached');
      const signal = AbortSignal.any([...(request.signal ? [request.signal] : []), AbortSignal.timeout(timeoutMs)]);
      try {
        const result = await inner.generateJson({ ...request, signal });
        budget?.record(model, result.usage);
        return result;
      } catch (error) {
        // Tokens of a rejected response are still billed; keep them in the usage log.
        if (error?.usage) budget?.record(model, error.usage);
        if (error instanceof LlmError) throw error;
        if (request.signal?.aborted) throw request.signal.reason ?? error;
        if (signal.aborted) throw new LlmError('timeout', 'AI request timed out');
        throw new LlmError('unavailable', 'AI provider request failed');
      }
    },
  };
}
