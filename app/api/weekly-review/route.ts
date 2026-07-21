import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { WeeklyReviewAISchema } from "@/lib/schemas";
import { callGeminiJSON } from "@/lib/gemini";

export const maxDuration = 60;

const GEMINI_MODEL = "gemini-3.5-flash";
// El reintento usa Flash-Lite: cuota independiente y menor latencia.
const GEMINI_FALLBACK_MODEL = "gemini-3.1-flash-lite";
// Dos intentos de 25 s caben en los 60 s de la función.
const GEMINI_TIMEOUT_MS = 25_000;
const GEMINI_MAX_ATTEMPTS = 2;

const SYSTEM_PROMPT = `Eres un entrenador experto en pérdida de grasa y salud digestiva. Recibes las métricas de la última semana de un usuario (y la comparación con la semana anterior).
Contexto del usuario: busca perder grasa de forma sostenible (ritmo objetivo: -0,3 % a -0,8 % de peso corporal semanal) y vigila síntomas digestivos (posibles intolerancias FODMAP: lactosa, fructosa, sorbitol, polioles).

Devuelve:
- "ai_summary": resumen en español (4-8 frases) de la semana: evolución del peso, actividad, sueño, alimentación y estado digestivo. Menciona lo que ha ido bien y lo que no. Sé concreto con los números.
- "recommended_adjustment": UNA recomendación principal y accionable para la próxima semana (1-3 frases). Si el ritmo de pérdida es adecuado, recomienda mantener. Si hay síntomas digestivos altos y comidas con FODMAP sospechosos, sugiere qué alimento concreto probar a retirar.
- "adherence_score": nota 0-10 de adherencia según la cantidad de días registrados y el cumplimiento de objetivos (pasos, proteína si hay datos). null si apenas hay datos.

No diagnostiques enfermedades. Si hay sangre visible registrada, recuerda amablemente que debe consultarlo con un médico. Nunca inventes datos que no estén en las métricas.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    ai_summary: { type: "string" },
    recommended_adjustment: { type: "string" },
    adherence_score: { type: ["number", "null"], minimum: 0, maximum: 10 },
  },
  required: ["ai_summary", "recommended_adjustment", "adherence_score"],
  additionalProperties: false,
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Lunes de la semana que contiene la fecha dada. */
function mondayOf(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 = domingo
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round(n: number | null, decimals = 2): number | null {
  if (n === null) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

export async function POST() {
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

    const weekStart = mondayOf(new Date());
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    const prevWeekStart = new Date(weekStart);
    prevWeekStart.setUTCDate(prevWeekStart.getUTCDate() - 7);

    const [logsRes, prevLogsRes, digestiveRes, workoutsRes, mealsRes, profileRes] =
      await Promise.all([
        supabase
          .from("daily_logs")
          .select("date, weight_kg, waist_cm, sleep_hours, steps, water_liters")
          .eq("user_id", user.id)
          .gte("date", isoDate(weekStart))
          .lte("date", isoDate(weekEnd)),
        supabase
          .from("daily_logs")
          .select("weight_kg")
          .eq("user_id", user.id)
          .gte("date", isoDate(prevWeekStart))
          .lt("date", isoDate(weekStart)),
        supabase
          .from("digestive_logs")
          .select("bloating, pain, gas, bristol_type, visible_blood, created_at")
          .eq("user_id", user.id)
          .gte("created_at", weekStart.toISOString()),
        supabase
          .from("workouts")
          .select("date, workout_type")
          .eq("user_id", user.id)
          .gte("date", isoDate(weekStart))
          .lte("date", isoDate(weekEnd)),
        supabase
          .from("meals")
          .select(
            "date, meal_type, description, estimated_calories, estimated_protein, meal_items(food_name, suspected_lactose, suspected_fructose, suspected_sorbitol, suspected_polyols)"
          )
          .eq("user_id", user.id)
          .gte("date", isoDate(weekStart))
          .lte("date", isoDate(weekEnd)),
        supabase
          .from("profiles")
          .select("target_weight, daily_step_target, daily_protein_target, daily_calorie_target")
          .eq("id", user.id)
          .maybeSingle(),
      ]);

    const logs = logsRes.data ?? [];
    if (logs.length === 0) {
      return NextResponse.json(
        { error: "No hay registros esta semana. Registra algunos días antes de generar la revisión.", requestId },
        { status: 400 }
      );
    }

    const weights = logs.map((l) => l.weight_kg).filter((v): v is number => v !== null);
    const prevWeights = (prevLogsRes.data ?? [])
      .map((l) => l.weight_kg)
      .filter((v): v is number => v !== null);

    const averageWeight = avg(weights);
    const prevAverageWeight = avg(prevWeights);
    const weightChangePct =
      averageWeight !== null && prevAverageWeight !== null
        ? ((averageWeight - prevAverageWeight) / prevAverageWeight) * 100
        : null;

    const averageSteps = avg(logs.map((l) => l.steps).filter((v): v is number => v !== null));
    const averageSleep = avg(
      logs.map((l) => l.sleep_hours).filter((v): v is number => v !== null)
    );

    const digestive = digestiveRes.data ?? [];
    const digestiveScores = digestive
      .map((d) => avg([d.bloating, d.pain, d.gas].filter((v): v is number => v !== null)))
      .filter((v): v is number => v !== null);
    const digestiveScore = avg(digestiveScores);
    const anyVisibleBlood = digestive.some((d) => d.visible_blood);

    const meals = mealsRes.data ?? [];
    const proteinByDay = new Map<string, number>();
    for (const m of meals) {
      if (m.estimated_protein !== null) {
        proteinByDay.set(m.date, (proteinByDay.get(m.date) ?? 0) + m.estimated_protein);
      }
    }
    const averageProtein = avg([...proteinByDay.values()]);

    const trainingSessions = (workoutsRes.data ?? []).length;

    const metrics = {
      semana: { inicio: isoDate(weekStart), fin: isoDate(weekEnd) },
      dias_registrados: logs.length,
      peso_medio_kg: round(averageWeight),
      peso_medio_semana_anterior_kg: round(prevAverageWeight),
      cambio_peso_semanal_pct: round(weightChangePct),
      pasos_medios: averageSteps === null ? null : Math.round(averageSteps),
      sueno_medio_h: round(averageSleep, 1),
      proteina_media_g_dia: round(averageProtein, 0),
      entrenamientos: trainingSessions,
      sintomas_digestivos_media_0a10: round(digestiveScore, 1),
      sangre_visible_registrada: anyVisibleBlood,
      objetivos: profileRes.data ?? null,
      comidas_registradas: meals.map((m) => ({
        fecha: m.date,
        tipo: m.meal_type,
        descripcion: m.description,
        kcal: m.estimated_calories,
        alimentos_fodmap_sospechosos: (m.meal_items ?? [])
          .filter(
            (it) =>
              it.suspected_lactose ||
              it.suspected_fructose ||
              it.suspected_sorbitol ||
              it.suspected_polyols
          )
          .map((it) => it.food_name),
      })),
    };

    console.info("[weekly-review] request started", {
      requestId,
      weekStart: isoDate(weekStart),
      daysLogged: logs.length,
    });

    const result = await callGeminiJSON({
      apiKey,
      model: GEMINI_MODEL,
      systemPrompt: SYSTEM_PROMPT,
      parts: [{ text: `Métricas de la semana:\n${JSON.stringify(metrics, null, 2)}` }],
      responseSchema: RESPONSE_SCHEMA,
      timeoutMs: GEMINI_TIMEOUT_MS,
      maxOutputTokens: 2048,
      maxAttempts: GEMINI_MAX_ATTEMPTS,
      fallbackModel: GEMINI_FALLBACK_MODEL,
    });

    if (!result.ok) {
      console.error("[weekly-review] Gemini failed", { requestId, message: result.message });
      return NextResponse.json({ error: result.message, requestId }, { status: result.status });
    }

    let aiData;
    try {
      aiData = WeeklyReviewAISchema.parse(JSON.parse(result.text));
    } catch (error) {
      console.error("[weekly-review] validation failed", { requestId, error, rawText: result.text });
      return NextResponse.json(
        { error: "La respuesta de la IA no superó la validación", requestId },
        { status: 502 }
      );
    }

    const { data: review, error: upsertError } = await supabase
      .from("weekly_reviews")
      .upsert(
        {
          user_id: user.id,
          week_start: isoDate(weekStart),
          average_weight: round(averageWeight),
          weight_change_percentage: round(weightChangePct),
          average_steps: averageSteps === null ? null : Math.round(averageSteps),
          average_protein: round(averageProtein, 0),
          average_sleep: round(averageSleep, 1),
          training_sessions: trainingSessions,
          digestive_score: round(digestiveScore, 1),
          adherence_score: aiData.adherence_score,
          ai_summary: aiData.ai_summary,
          recommended_adjustment: aiData.recommended_adjustment,
        },
        { onConflict: "user_id,week_start" }
      )
      .select()
      .single();

    if (upsertError) {
      console.error("[weekly-review] upsert failed", { requestId, upsertError });
      return NextResponse.json(
        { error: "No se pudo guardar la revisión", requestId },
        { status: 500 }
      );
    }

    // Auditoría sin bloquear la respuesta.
    void supabase
      .from("ai_analyses")
      .insert({
        user_id: user.id,
        source_type: "weekly_review",
        source_id: review.id,
        provider: "google",
        model: GEMINI_MODEL,
        prompt_version: "v1",
        input_data: metrics,
        output_data: aiData,
        status: "done",
      })
      .then(({ error }) => {
        if (error) console.error("[weekly-review] audit insert failed", { requestId, error });
      });

    console.info("[weekly-review] request completed", {
      requestId,
      elapsedMs: Date.now() - startedAt,
    });

    return NextResponse.json({ data: review, requestId });
  } catch (error) {
    console.error("[weekly-review] unexpected error", {
      requestId,
      elapsedMs: Date.now() - startedAt,
      error,
    });
    return NextResponse.json({ error: "Error inesperado en el servidor", requestId }, { status: 500 });
  }
}
