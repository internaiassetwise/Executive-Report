# Optional Gemini interpretation

Gemini runs behind a server-side endpoint. For localhost, set `GEMINI_API_KEY` and `GEMINI_MODEL` in `backend/.env`. The backend loads this file directly; the frontend never loads it. No provider model is silently selected; both fields must exist before the feature is enabled. The app works without this connection using factual Python summaries.

The request contains only calculated findings, methods with sheet/table/range provenance, and the user's objective. The interface explains this transfer and the number of provider requests before the user activates it. All findings are sent in sequential batches of at most 100 evidence entries and 80,000 UTF-8 bytes per request; no first-100 truncation occurs. Oversized individual findings raise an explicit error. Interpretations are scoped to each evidence batch, not a cross-workbook synthesis. If any batch fails, new interpretations from that run are not applied. No raw rows are transmitted. Uploaded strings and objectives are data, never instructions. The system prompt disallows unsupported causes and numerical claims.

The endpoint validates origin, payload size and shape, source evidence IDs, output shape and length. It rejects numerical digits (including Unicode digits) and unknown evidence IDs. If any provider or validation step fails, the existing calculated report remains available.

Interpretations and recommendations are separately labeled and remain optional. Current semantic validation cannot guarantee that every qualitative assertion or spelled-out number is supported. Numeric evidence remains controlled by Python; LLM-generated text never changes source calculations. For higher assurance, implement an evidence-token grammar and semantic review before supporting generated numerical facts.

No live Gemini request was made during folder reorganization. API tests use a mock provider and do not consume the configured key. Owner-only Sites access is the deployment boundary; shared/public use needs explicit authorization and rate-limit/abuse review.
