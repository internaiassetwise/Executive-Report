// Any server that implements the OpenAI Chat Completions API with JSON-schema
// output: OpenAI itself, or a self-hosted model (vLLM, Ollama, LM Studio) when
// company data must not leave the network. Set LLM_BASE_URL to its /v1 root.

export function createOpenAiCompatibleProvider({ apiKey, model, baseUrl, fetcher, LlmError }) {
  const endpoint = `${String(baseUrl).replace(/\/$/, '')}/chat/completions`;
  return {
    async generateJson({ system, prompt, schema, maxOutputTokens = 4000, temperature = 0.2, signal }) {
      const response = await fetcher(endpoint, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({
          model, temperature, max_tokens: maxOutputTokens,
          messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
          response_format: { type: 'json_schema', json_schema: { name: 'result', schema, strict: false } },
        }),
      });
      if (response.status === 429) throw new LlmError('rate_limited', 'LLM rate limit reached');
      if (!response.ok) throw new LlmError('unavailable', `LLM returned ${response.status}`);
      const body = await response.json();
      const text = body.choices?.[0]?.message?.content;
      const usage = { promptTokenCount: body.usage?.prompt_tokens, candidatesTokenCount: body.usage?.completion_tokens, thoughtsTokenCount: body.usage?.completion_tokens_details?.reasoning_tokens, totalTokenCount: body.usage?.total_tokens };
      if (typeof text !== 'string' || Buffer.byteLength(text) > 120_000) throw Object.assign(new LlmError('invalid_response', 'LLM returned no usable text'), { usage });
      try { return { data: JSON.parse(text), usage, finishReason: body.choices[0].finish_reason }; }
      catch { throw Object.assign(new LlmError('invalid_response', 'LLM returned invalid JSON'), { usage }); }
    },
  };
}
