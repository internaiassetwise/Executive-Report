/**
 * Caps provider requests per UTC day and logs token usage (counts only, never
 * prompts or dataset values) so spend is visible in the host logs.
 */
export function createAiBudget({ dailyLimit = 200, now = () => new Date(), log = console.log } = {}) {
  let day = '', used = 0;
  const today = () => now().toISOString().slice(0, 10);

  /** Reserve one request before calling the provider; false once the cap is reached. */
  function reserve() {
    if (today() !== day) { day = today(); used = 0; }
    if (used >= dailyLimit) return false;
    used++;
    return true;
  }

  function record(model, usage = {}) {
    log(JSON.stringify({
      event: 'ai_usage', model,
      prompt_tokens: usage.promptTokenCount ?? null,
      output_tokens: usage.candidatesTokenCount ?? null,
      thinking_tokens: usage.thoughtsTokenCount ?? null,
      total_tokens: usage.totalTokenCount ?? null,
      requests_today: used, daily_limit: dailyLimit,
    }));
  }

  return { reserve, record, snapshot: () => ({ day, used, dailyLimit }) };
}
