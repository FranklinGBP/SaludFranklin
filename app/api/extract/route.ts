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

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    weight_kg: { type: "number", nullable: true },
    waist_cm: { type: "number", nullable: true },
    sleep_hours: { type: "number", nullable: true },
    steps: { type: "integer", nullable: true },
    water_liters: { type: "number", nullable: true },
    energy_level: { type: "integer", nullable: true },
    hunger_level: { type: "integer", nullable: true },
    trained: { type: "boolean" },
    training_type: { type: "string", nullable: true },
    bloating: { type: "integer", nullable: true },
    pain: { type: "integer", nullable: true },
    gas: { type: "integer", nullable: true },
    bristol_type: { type: "integer", nullable: true },
    bowel_movements: { type: "integer", nullable: true },
    urgency: { type: "boolean" },
    incomplete_evacuation: { type: "boolean" },
    mucus: { type: "boolean" },
    visible_blood: { type: "boolean" },
    notes: { type: "string" },
  },
  required: ["trained", "urgency", "incomplete_evacuation", "mucus", "visible_blood", "notes"],
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
      { error: "Falta configurar GEMINI_API_KEY en el servidor." },
      { status: 500 }
    );
  }

  const { text } = await request.json();
  if (!text || typeof text !== "string" || text.trim().length < 3) {
    return NextResponse.json({ error: "Texto vacío" }, { status: 400 });
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0,
        },
      }),
    }
  );

  if (!res.ok) {
    const detail = await res.text();
    console.error("Gemini error:", detail);
    return NextResponse.json(
      { error: "Error al llamar a Gemini" },
      { status: 502 }
    );
  }

  const json = await res.json();
  const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    return NextResponse.json(
      { error: "Gemini no devolvió datos" },
      { status: 502 }
    );
  }

  let parsed;
  try {
    parsed = DailyVoiceSchema.parse(JSON.parse(rawText));
  } catch (e) {
    console.error("Validación fallida:", e);
    return NextResponse.json(
      { error: "La respuesta de la IA no superó la validación" },
      { status: 502 }
    );
  }

  // Registrar el análisis para trazabilidad
  await supabase.from("ai_analyses").insert({
    user_id: user.id,
    source_type: "voice_text",
    provider: "google",
    model: GEMINI_MODEL,
    prompt_version: "v1",
    input_data: { text },
    output_data: parsed,
    status: "done",
  });

  return NextResponse.json({ data: parsed });
}
