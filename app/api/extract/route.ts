import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { DailyVoiceSchema } from "@/lib/schemas";

const GEMINI_MODEL = "gemini-2.5-flash";

const SYSTEM_PROMPT = `Eres un extractor de datos de salud. El usuario describe su día (peso, sueño, pasos, entrenamiento, síntomas digestivos, etc.) en español.
Extrae ÚNICAMENTE los datos mencionados explícitamente. Si un dato no se menciona, usa null (o false para booleanos).
Los números decimales en español usan coma ("82,4 kilos" = 82.4).
Escalas de síntomas (hinchazón, dolor, gases, energía, hambre): 0 a 10.
bristol_type: escala de Bristol 1-7 si se menciona la consistencia de las deposiciones.
En "notes" resume brevemente cualquier información relevante que no encaje en los demás campos. Nunca inventes datos.`;

// Gemini admite un subconjunto de JSON Schema. Para campos opcionales se usa
// un array de tipos, por ejemplo ["number", "null"], en lugar de nullable:true.
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
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.startsWith("PON_AQUI")) {
    return NextResponse.json(
      { error: "Falta configurar GEMINI_API_KEY en Vercel." },
      { status: 500 }
    );
  }

  const body = await request.json().catch(() => null);
  const text = body?.text;

  if (!text || typeof text !== "string" || text.trim().length < 3) {
    return NextResponse.json({ error: "Texto vacío" }, { status: 400 });
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: {
          responseFormat: {
            text: {
              mimeType: "application/json",
              schema: RESPONSE_SCHEMA,
            },
          },
          temperature: 0,
        },
      }),
    }
  );

  if (!res.ok) {
    const rawDetail = await res.text();
    let upstreamMessage = "La API de Gemini rechazó la solicitud";

    try {
      const parsed = JSON.parse(rawDetail) as GeminiErrorBody;
      upstreamMessage = parsed.error?.message || upstreamMessage;
    } catch {
      // La respuesta puede ser HTML o texto plano. No se devuelve completa al cliente.
    }

    console.error("Gemini error", {
      status: res.status,
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

    return NextResponse.json({ error: userMessage }, { status: 502 });
  }

  const json = await res.json();
  const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!rawText) {
    return NextResponse.json(
      { error: "Gemini no devolvió datos estructurados" },
      { status: 502 }
    );
  }

  let parsed;
  try {
    parsed = DailyVoiceSchema.parse(JSON.parse(rawText));
  } catch (error) {
    console.error("Validación fallida", { error, rawText });
    return NextResponse.json(
      { error: "La respuesta de la IA no superó la validación" },
      { status: 502 }
    );
  }

  const { error: auditError } = await supabase.from("ai_analyses").insert({
    user_id: user.id,
    source_type: "voice_text",
    provider: "google",
    model: GEMINI_MODEL,
    prompt_version: "v2",
    input_data: { text },
    output_data: parsed,
    status: "done",
  });

  if (auditError) {
    console.error("No se pudo registrar ai_analyses", auditError);
  }

  return NextResponse.json({ data: parsed });
}
