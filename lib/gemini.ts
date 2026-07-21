type GeminiTextPart = { text: string };
type GeminiInlineDataPart = {
  inlineData: { mimeType: string; data: string };
};
export type GeminiPart = GeminiTextPart | GeminiInlineDataPart;

type GeminiErrorBody = {
  error?: { code?: number; message?: string; status?: string };
};

export type GeminiResult =
  | { ok: true; text: string }
  | { ok: false; status: number; message: string };

/**
 * Llama a Gemini pidiendo JSON estructurado. Si la petición se cuelga (timeout)
 * o Gemini responde con un error transitorio (5xx), reintenta automáticamente
 * hasta agotar `maxAttempts`, siempre que quepa en el tiempo de la función.
 */
export async function callGeminiJSON(options: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  parts: GeminiPart[];
  responseSchema: object;
  timeoutMs?: number;
  maxOutputTokens?: number;
  maxAttempts?: number;
}): Promise<GeminiResult> {
  const {
    apiKey,
    model,
    systemPrompt,
    parts,
    responseSchema,
    timeoutMs = 30_000,
    maxOutputTokens = 2048,
    maxAttempts = 1,
  } = options;

  let lastFailure: GeminiResult & { ok: false } = {
    ok: false,
    status: 502,
    message: "No se pudo contactar con Gemini",
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await callGeminiOnce({
      apiKey,
      model,
      systemPrompt,
      parts,
      responseSchema,
      timeoutMs,
      maxOutputTokens,
    });

    if (result.ok) return result;
    lastFailure = result;

    // Solo merece la pena reintentar timeouts y errores transitorios del servidor.
    const retryable = result.status === 504 || result.retryable === true;
    if (!retryable || attempt === maxAttempts) break;

    console.warn("[gemini] retrying after transient failure", {
      model,
      attempt,
      status: result.status,
      message: result.message,
    });
  }

  return { ok: false, status: lastFailure.status, message: lastFailure.message };
}

type GeminiOnceResult =
  | { ok: true; text: string }
  | { ok: false; status: number; message: string; retryable?: boolean };

async function callGeminiOnce(options: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  parts: GeminiPart[];
  responseSchema: object;
  timeoutMs: number;
  maxOutputTokens: number;
}): Promise<GeminiOnceResult> {
  const { apiKey, model, systemPrompt, parts, responseSchema, timeoutMs, maxOutputTokens } =
    options;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts }],
          generationConfig: {
            responseFormat: {
              text: {
                mimeType: "APPLICATION_JSON",
                schema: responseSchema,
              },
            },
            thinkingConfig: { thinkingLevel: "MINIMAL" },
            maxOutputTokens,
          },
        }),
      }
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        ok: false,
        status: 504,
        message: `Gemini ha tardado demasiado (límite ${Math.round(timeoutMs / 1000)} s). Inténtalo de nuevo.`,
        retryable: true,
      };
    }
    // Errores de red (DNS, conexión cortada...) también son transitorios.
    if (error instanceof TypeError) {
      console.error("[gemini] network error", { model, error });
      return {
        ok: false,
        status: 502,
        message: "No se pudo conectar con Gemini. Inténtalo de nuevo.",
        retryable: true,
      };
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const rawDetail = await res.text();
    let upstreamMessage = "La API de Gemini rechazó la solicitud";
    try {
      const parsed = JSON.parse(rawDetail) as GeminiErrorBody;
      upstreamMessage = parsed.error?.message || upstreamMessage;
    } catch {
      // Texto plano; el detalle completo queda en los logs.
    }
    console.error("[gemini] upstream error", { model, status: res.status, detail: rawDetail });

    const message =
      res.status === 429
        ? "Se ha alcanzado temporalmente el límite de uso de Gemini. Prueba de nuevo en unos minutos."
        : res.status === 503
          ? "Gemini está saturado en este momento. Prueba de nuevo en unos segundos."
          : `Error de Gemini (${res.status}): ${upstreamMessage}`;
    return { ok: false, status: 502, message, retryable: res.status >= 500 };
  }

  const json = await res.json();
  const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    console.error("[gemini] empty response", { model, json });
    return { ok: false, status: 502, message: "Gemini no devolvió datos estructurados" };
  }

  return { ok: true, text: rawText };
}
