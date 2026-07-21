import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { MealPhotoSchema } from "@/lib/schemas";
import { callGeminiJSON } from "@/lib/gemini";

export const maxDuration = 60;

// El análisis de imagen necesita más capacidad visual que la extracción de texto.
const GEMINI_MODEL = "gemini-3.5-flash";
const GEMINI_TIMEOUT_MS = 45_000;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // base64 ya comprimido en el cliente

const MEAL_PROMPT = `Eres un nutricionista que analiza la FOTO DE UN PLATO DE COMIDA.
El usuario sigue una dieta de pérdida de grasa y vigila su salud digestiva (posibles intolerancias: lactosa, fructosa, sorbitol y otros polioles).
Identifica los alimentos visibles y estima cantidades y macros de forma conservadora.
- "items": un elemento por alimento identificable, con nombre en español.
- Cantidades en unidades razonables ("g", "ml", "unidad", "rebanada"...). Si no puedes estimar, usa null.
- Macros (calories, protein, carbs, fats) por la cantidad estimada del item; null si es muy incierto.
- Marca suspected_lactose/fructose/sorbitol/polyols si el alimento suele contener ese componente.
- "estimated_*" del plato completo: suma aproximada de los items.
- "digestive_warning": si hay algún alimento con riesgo digestivo para esas intolerancias, explica brevemente cuál y por qué; si no, null.
- "confidence": 0 a 1 según lo claro que se ve el plato.
- "meal_type": dedúcelo si es evidente; si no, "desconocido".
Nunca inventes alimentos que no se vean. Responde en español.`;

const LABEL_PROMPT = `Eres un nutricionista que analiza la FOTO DE UNA ETIQUETA NUTRICIONAL de un producto.
El usuario sigue una dieta de pérdida de grasa y vigila su salud digestiva (posibles intolerancias: lactosa, fructosa, sorbitol y otros polioles).
- "description": nombre del producto si es visible.
- "items": UN único item con el nombre del producto. Usa los valores POR RACIÓN si la etiqueta la indica; si no, por 100 g/ml, e indícalo en "unit" (p. ej. "100 g").
- Lee los ingredientes: marca suspected_lactose/fructose/sorbitol/polyols si aparecen (leche, lactosa, suero, fructosa, jarabe de maíz, sorbitol E420, xilitol, maltitol, manitol...).
- "digestive_warning": si algún ingrediente es de riesgo para esas intolerancias, indícalo brevemente; si no, null.
- "estimated_*": los mismos valores del item.
- "confidence": 0 a 1 según la legibilidad de la etiqueta.
- "meal_type": "desconocido".
Copia los números tal como aparecen; no inventes valores ilegibles (usa null). Responde en español.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    meal_type: {
      type: "string",
      enum: ["desayuno", "comida", "cena", "snack", "desconocido"],
    },
    description: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          food_name: { type: "string" },
          estimated_quantity: { type: ["number", "null"] },
          unit: { type: ["string", "null"] },
          calories: { type: ["number", "null"] },
          protein: { type: ["number", "null"] },
          carbs: { type: ["number", "null"] },
          fats: { type: ["number", "null"] },
          suspected_lactose: { type: "boolean" },
          suspected_fructose: { type: "boolean" },
          suspected_sorbitol: { type: "boolean" },
          suspected_polyols: { type: "boolean" },
        },
        required: [
          "food_name",
          "estimated_quantity",
          "unit",
          "calories",
          "protein",
          "carbs",
          "fats",
          "suspected_lactose",
          "suspected_fructose",
          "suspected_sorbitol",
          "suspected_polyols",
        ],
        additionalProperties: false,
      },
    },
    estimated_calories: { type: ["number", "null"] },
    estimated_protein: { type: ["number", "null"] },
    estimated_carbs: { type: ["number", "null"] },
    estimated_fats: { type: ["number", "null"] },
    digestive_warning: { type: ["string", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: [
    "meal_type",
    "description",
    "items",
    "estimated_calories",
    "estimated_protein",
    "estimated_carbs",
    "estimated_fats",
    "digestive_warning",
    "confidence",
  ],
  additionalProperties: false,
};

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();

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
    const image = body?.image;
    const mimeType = body?.mimeType;
    const category = body?.category;

    if (typeof image !== "string" || image.length < 100) {
      return NextResponse.json({ error: "Falta la imagen", requestId }, { status: 400 });
    }
    if (image.length > MAX_IMAGE_BYTES * 1.4) {
      return NextResponse.json(
        { error: "La imagen es demasiado grande. Vuelve a intentarlo.", requestId },
        { status: 413 }
      );
    }
    if (mimeType !== "image/jpeg" && mimeType !== "image/png" && mimeType !== "image/webp") {
      return NextResponse.json({ error: "Formato de imagen no soportado", requestId }, { status: 400 });
    }
    if (category !== "meal" && category !== "label") {
      return NextResponse.json({ error: "Categoría no válida", requestId }, { status: 400 });
    }

    console.info("[analyze-photo] request started", { requestId, category, model: GEMINI_MODEL });

    const result = await callGeminiJSON({
      apiKey,
      model: GEMINI_MODEL,
      systemPrompt: category === "meal" ? MEAL_PROMPT : LABEL_PROMPT,
      parts: [
        { inlineData: { mimeType, data: image } },
        {
          text:
            category === "meal"
              ? "Analiza esta foto de comida."
              : "Analiza esta etiqueta nutricional.",
        },
      ],
      responseSchema: RESPONSE_SCHEMA,
      timeoutMs: GEMINI_TIMEOUT_MS,
      maxOutputTokens: 4096,
    });

    if (!result.ok) {
      console.error("[analyze-photo] Gemini failed", {
        requestId,
        elapsedMs: Date.now() - startedAt,
        message: result.message,
      });
      return NextResponse.json({ error: result.message, requestId }, { status: result.status });
    }

    let parsed;
    try {
      parsed = MealPhotoSchema.parse(JSON.parse(result.text));
    } catch (error) {
      console.error("[analyze-photo] validation failed", { requestId, error, rawText: result.text });
      return NextResponse.json(
        { error: "La respuesta de la IA no superó la validación", requestId },
        { status: 502 }
      );
    }

    console.info("[analyze-photo] request completed", {
      requestId,
      elapsedMs: Date.now() - startedAt,
      items: parsed.items.length,
    });

    // Auditoría sin bloquear la respuesta (no guardamos la imagen en la tabla).
    void supabase
      .from("ai_analyses")
      .insert({
        user_id: user.id,
        source_type: category === "meal" ? "meal_photo" : "label_photo",
        provider: "google",
        model: GEMINI_MODEL,
        prompt_version: "v1",
        input_data: { category, mimeType, imageChars: image.length },
        output_data: parsed,
        confidence: parsed.confidence,
        status: "done",
      })
      .then(({ error }) => {
        if (error) console.error("[analyze-photo] audit insert failed", { requestId, error });
      });

    return NextResponse.json({ data: parsed, requestId });
  } catch (error) {
    console.error("[analyze-photo] unexpected error", {
      requestId,
      elapsedMs: Date.now() - startedAt,
      error,
    });
    return NextResponse.json({ error: "Error inesperado en el servidor", requestId }, { status: 500 });
  }
}
