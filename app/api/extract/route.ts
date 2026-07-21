import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { DailyVoiceSchema } from "@/lib/schemas";

export const maxDuration = 30;

// Extracción sencilla y frecuente: Flash-Lite ofrece menor latencia y coste.
const GEMINI_MODEL = "gemini-3.1-flash-lite";
const GEMINI_TIMEOUT_MS = 15_000;

const SYSTEM_PROMPT = `Eres un extractor de datos de salud. El usuario describe su día (peso, sueño, pasos, entrenamiento, síntomas digestivos, etc.) en español.
Extrae ÚNICAMENTE los datos mencionados explícitamente. Si un dato no se menciona, usa null (o false para booleanos).
Los números decimales en español usan coma ("82,4 kilos" = 82.4).
Si el usuario dice que hizo muy pocos pasos pero no da una cifra, usa null, no inventes una cantidad.
Si dice que no tiene hinchazón, dolor o gases, usa 0 para ese síntoma.
Escalas de síntomas (hinchazón, dolor, gases, energía, hambre): 0 a 10.
bristol_type: escala de Bristol 1-7 si se menciona la consistencia de las deposiciones.
En "notes" resume brevemente cualquier información relevante que no encaje en los demás campos. Nunca inventes datos.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    weight_kg: { type: ["number", "null"] },
    waist_cm: { type: ["number", "null"] },
    sleep_hours: { type: ["number", "null"] },
    steps: { type: ["integer", "null"] },
    water_liters: { type: ["number", "null"] },
    energy_level: { type: ["integer", "null"], minimum: 0, maximum: 10 },
    hunger_level: { type: ["integer", "null"], minimum: 0, maximum: 10 },
    trained: { type: "boolean" },
    training_type: { type: ["string", "null"] },
    bloating: { type: ["integer", "null"], minimum: 0, maximum: 10 },
    pain: { type: ["integer", "null"], minimum: 0, maximum: 10 },
    gas: { type: ["integer", "null"], minimum: 0, maximum: 10 },
    bristol_type: { type: ["integer", "null"], minimum: 1, maximum: 7 },
    bowel_movements: { type: ["integer", "null"], minimum: 0 },
    urgency: { type: "boolean" },
    incomplete_evacuation: { type: "boolean" },
    mucus: { type: "boolean" },
    visible_blood: { type: "boolean" },
    notes: { type: "string" },
  },
  required: [
    "weight_kg",
    "waist_cm",
    "sleep_hours",
    "steps",
    "water_liters",
    "energy_level",
    "hunger_level",
    "trained",
    "training_type",
    "bloating",
    "pain",
    "gas",
    "bristol_type",
    "bowel_movements",
    "urgency",
    "incomplete_evacuation",
    "mucus",
    "visible_blood",
    "notes",
  ],
  additionalProperties: false,
};

type GeminiErrorBody = {
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();

  console.info("[extract] request started", { requestId, model: GEMINI_MODEL });

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado", requestId }, { status: 401 });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey.startsWith("PON_AQUI")) {
      return NextResponse.json(
        { error: "Falta configurar GEMINI_API_KEY en Vercel.", requestId },
        { status: 500 }
      );
    }

    const body = await request.json().catch(() => null);
    const text = body?.text;

    if (!text || typeof text !== "string" || text.trim().length < 3) {
      return NextResponse.json({ error: "Texto vacío", requestId }, { status: 400 });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          signal: controller.signal,
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: "user", parts: [{ text }] }],
            generationConfig: {
              responseFormat: {
                text: {
                  mimeType: "APPLICATION_JSON",
                  schema: RESPONSE_SCHEMA,
                },
              },
              thinkingConfig: {
                thinkingLevel: "MINIMAL",
              },
              maxOutputTokens: 1024,
            },
          }),
        }
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        console.error("[extract] Gemini timeout", {
          requestId,
          elapsedMs: Date.now() - startedAt,
        });
        return NextResponse.json(
          {
            error: "Gemini ha tardado demasiado. Inténtalo de nuevo; la solicitud se ha cancelado a los 15 segundos.",
            requestId,
          },
          { status: 504 }
        );
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
        // Puede ser texto plano; el detalle completo queda en los logs de Vercel.
      }

      console.error("[extract] Gemini error", {
        requestId,
        status: res.status,
        elapsedMs: Date.now() - startedAt,
        detail: rawDetail,
      });

      const userMessage =
        res.status === 400
          ? `Gemini rechazó el formato de la solicitud: ${upstreamMessage}`
          : res.status === 403
            ? `Gemini ha rechazado la clave o el proyecto: ${upstreamMessage}`
            : res.status === 429
              ? "Se ha alcanzado temporalmente el límite de uso de Gemini. Prueba de nuevo en unos minutos."
              : `Error de Gemini (${res.status}): ${upstreamMessage}`;

      return NextResponse.json({ error: userMessage, requestId }, { status: 502 });
    }

    const json = await res.json();
    const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!rawText) {
      console.error("[extract] Empty Gemini response", { requestId, json });
      return NextResponse.json(
        { error: "Gemini no devolvió datos estructurados", requestId },
        { status: 502 }
      );
    }

    let parsed;
    try {
      parsed = DailyVoiceSchema.parse(JSON.parse(rawText));
    } catch (error) {
      console.error("[extract] Validation failed", { requestId, error, rawText });
      return NextResponse.json(
        { error: "La respuesta de la IA no superó la validación", requestId },
        { status: 502 }
      );
    }

    console.info("[extract] request completed", {
      requestId,
      elapsedMs: Date.now() - startedAt,
      model: GEMINI_MODEL,
    });

    // No bloqueamos la respuesta por el registro de auditoría.
    void supabase
      .from("ai_analyses")
      .insert({
        user_id: user.id,
        source_type: "voice_text",
        provider: "google",
        model: GEMINI_MODEL,
        prompt_version: "v3",
        input_data: { text },
        output_data: parsed,
        status: "done",
      })
      .then(({ error }) => {
        if (error) console.error("[extract] audit insert failed", { requestId, error });
      });

    return NextResponse.json({ data: parsed, requestId });
  } catch (error) {
    console.error("[extract] unexpected error", {
      requestId,
      elapsedMs: Date.now() - startedAt,
      error,
    });

    return NextResponse.json(
      { error: "Error inesperado en el servidor", requestId },
      { status: 500 }
    );
  }
}
