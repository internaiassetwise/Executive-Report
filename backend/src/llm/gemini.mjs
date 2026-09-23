// Gemini generateContent with a JSON response schema.
// Thinking is kept at the minimum each model family allows: thinking tokens are
// billed as output and were the main cost driver of the retired report flow.

function thinkingFor(model) {
  if (/^gemini-3/.test(model)) return { thinkingLevel: 'minimal' };
  if (/^gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
  if (/^gemini-2\.5-pro/.test(model)) return { thinkingBudget: 128 };
  return undefined;
}

/** Lower-case JSON Schema -> Gemini OpenAPI subset. */
export function toGeminiSchema(schema) {
  const out = { type: String(schema.type).toUpperCase() };
  for (const field of ['enum', 'minItems', 'maxItems', 'required', 'description']) if (schema[field] !== undefined) out[field] = schema[field];
  if (schema.properties) out.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, toGeminiSchema(value)]));
  if (schema.items) out.items = toGeminiSchema(schema.items);
  return out;
}

export function createGeminiProvider({ apiKey, model, fetcher, LlmError }) {
  return {
    async generateJson({ system, prompt, schema, images = [], maxOutputTokens = 4000, temperature = 0.2, signal }) {
      const thinkingConfig = thinkingFor(model);
      const response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }, ...images.map(image => ({ inlineData: { mimeType: image.mimeType, data: image.data } }))] }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: toGeminiSchema(schema), temperature, maxOutputTokens, ...(thinkingConfig ? { thinkingConfig } : {}) },
        }),
      });
      if (response.status === 429) throw new LlmError('rate_limited', 'Gemini quota or rate limit reached');
      if (!response.ok) throw new LlmError('unavailable', `Gemini returned ${response.status}`);
      const body = await response.json();
      const candidate = body.candidates?.[0];
      const text = candidate?.content?.parts?.filter(part => typeof part.text === 'string' && !part.thought).map(part => part.text).join('');
      const usage = body.usageMetadata || {};
      if (!text || Buffer.byteLength(text) > 120_000) throw Object.assign(new LlmError('invalid_response', 'Gemini returned no usable text'), { usage });
      try { return { data: JSON.parse(text), usage, finishReason: candidate.finishReason }; }
      catch { throw Object.assign(new LlmError('invalid_response', candidate?.finishReason === 'MAX_TOKENS' ? 'Gemini output was cut off' : 'Gemini returned invalid JSON'), { usage }); }
    },
  };
}
