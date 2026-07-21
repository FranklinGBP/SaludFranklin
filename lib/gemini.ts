type GeminiTextPart = { text: string };
type GeminiInlineDataPart = {
  inlineData: { mimeType: string; data: string };
};
export type GeminiPart = GeminiTextPart | GeminiInlineDataPart;

type GeminiErrorBody = {
  error?: { code?: number; message?: string; status?: string };
};

type JsonSchema = Record<string, unknown>;

export type GeminiResult =
  | { ok: true; text: string }
  | { ok: false; status: number; message: string };

function relaxedType(type: unknown): unknown {
  if (!Array.isArray(type)) return type;
  return type.find((item) => item !== "null") ?? type[0];
}

/**
 * Gemini solo admite un subconjunto de JSON Schema y puede rechazar esquemas
 * muy anidados con INVALID_ARGUMENT. Este fallback conserva nombres y tipos,
 * elimina restricciones secundarias y relaja el nivel más profundo. Zod sigue
 * realizando la validación estricta de la respuesta en cada route handler.
 */
function relaxResponseSchema(value: unknown, depth = 0): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;

  const schema = value as JsonSchema;
  const type = relaxedType(schema.type);

  if (type === "object" && depth >= 6) {
    return { type: "object" };
  }

  const relaxed: JsonSchema = {};
  if (type) relaxed.type = type;
  if (schema.enum) relaxed.enum = schema.enum;
  if (schema.description) relaxed.description = schema.description;

  if (type === "object" && schema.properties && typeof schema.properties === "object") {
    relaxed.properties = Object.fromEntries(
      Object.entries(schema.properties as JsonSchema).map(([key, child]) => [
        key,
        relaxResponseSchema(child, depth + 1),
      ])
    );

    if (Array.isArray(schema.required) && depth < 5) {
      relaxed.required = schema.required;
    }
  }

  if (type === "array" && schema.items) {
    relaxed.items = relaxResponseSchema(schema.items, depth + 1);
  }

  return relaxed;
}

/**
 * Llama a Gemini pidiendo JSON estructurado. Si la petición se cuelga (timeout)
 * o Gemini responde con un error transitorio (5xx), reintenta automáticamente
 * hasta agotar `maxAttempts`, siempre que quepa en el tiempo de la función.
 * Si se indica `fallbackModel`, los reintentos usan ese modelo.
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
  fallbackModel?: string;
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
    fallbackModel,
  } = options;

  let lastFailure: GeminiResult & { ok: false } = {
    ok: false,
    status: 502,
    message: "No se pudo contactar con Gemini",
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptModel = attempt === 1 ? model : (fallbackModel ?? model);
    const result = await callGeminiOnce({
      apiKey,
      model: attemptModel,
      systemPrompt,
      parts,
      responseSchema,
      timeoutMs,
      maxOutputTokens,
    });

    if (result.ok) return result;
    lastFailure = result;

    const retryable = result.status === 504 || result.retryable === true;
    if (!retryable || attempt === maxAttempts) break;

    console.warn("[gemini] retrying after transient failure", {
      model: attemptModel,
      nextModel: fallbackModel ?? model,
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
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const send = (schema: object) =>
    fetch(endpoint, {
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
              schema,
            },
          },
          thinkingConfig: { thinkingLevel: "MINIMAL" },
          maxOutputTokens,
        },
      }),
    });

  let res: Response;
  try {
    res = await send(responseSchema);

    if (res.status === 400) {
      const firstDetail = await res.text();
      const schemaRelated = /invalid argument|schema|response.?format/i.test(firstDetail);

      if (schemaRelated) {
        console.warn("[gemini] retrying with relaxed response schema", {
          model,
          firstStatus: res.status,
          firstDetail,
        });
        res = await send(relaxResponseSchema(responseSchema) as object);
      } else {
        return parseGeminiError(model, res.status, firstDetail);
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        ok: false,
        status: 504,
        message: `Gemini ha tardado demasiado (límite ${Math.round(timeoutMs / 1000)} s). Inténtalo de nuevo.`,
        retryable: true,
      };
    }
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
    return parseGeminiError(model, res.status, await res.text());
  }

  const json = await res.json();
  const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    console.error("[gemini] empty response", { model, json });
    return { ok: false, status: 502, message: "Gemini no devolvió datos estructurados" };
  }

  return { ok: true, text: rawText };
}

function parseGeminiError(model: string, status: number, rawDetail: string): GeminiOnceResult {
  let upstreamMessage = "La API de Gemini rechazó la solicitud";
  try {
    const parsed = JSON.parse(rawDetail) as GeminiErrorBody;
    upstreamMessage = parsed.error?.message || upstreamMessage;
  } catch {
    // Texto plano; el detalle completo queda en los logs.
  }

  console.error("[gemini] upstream error", { model, status, detail: rawDetail });

  const message =
    status === 429
      ? "Se ha alcanzado temporalmente el límite de uso de Gemini. Prueba de nuevo en unos minutos."
      : status === 503
        ? "Gemini está saturado en este momento. Prueba de nuevo en unos segundos."
        : `Error de Gemini (${status}): ${upstreamMessage}`;

  return { ok: false, status: 502, message, retryable: status >= 500 };
}
