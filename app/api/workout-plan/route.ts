import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { WorkoutPlanAISchema } from "@/lib/schemas";
import { callGeminiJSON } from "@/lib/gemini";
import { catalogForPrompt, exerciseIds } from "@/lib/exercise-catalog";

export const maxDuration = 60;

const GEMINI_MODEL = "gemini-3.5-flash";
const GEMINI_TIMEOUT_MS = 50_000;

const SYSTEM_PROMPT = `Eres un entrenador personal experto en pérdida de grasa con entrenamiento de fuerza. Diseñas el plan de entrenamiento SEMANAL de un usuario que entrena en CASA (mancuernas, bandas, peso corporal) y en GIMNASIO (acceso completo: barra, máquinas, poleas).

Contexto del usuario: busca perder grasa preservando músculo, vigila su salud digestiva y su ritmo de vida cambia, así que el plan debe ser realista y flexible.

Reglas del plan:
- Devuelve EXACTAMENTE 7 días usando las fechas indicadas (lunes a domingo).
- 3-5 días de entrenamiento salvo que el usuario pida otra cosa; el resto "descanso" (los días de descanso pueden llevar 0 ejercicios o caminar suave como nota en "focus").
- Si el usuario indica qué días puede entrenar o dónde, respétalo.
- Los días YA COMPLETADOS ("hecho") o pasados no se tocan: cópialos igual que están en el plan actual si existe; la replanificación solo afecta a los días restantes.
- Fuerza estructurada: reparte empuje/tracción/pierna o torso/pierna según los días disponibles. Incluye 4-7 ejercicios por sesión con series (sets), repeticiones (reps, ej. "8-12" o "30 s") y descanso en segundos (rest_seconds).
- "exercise_id" DEBE ser un id EXACTO del catálogo proporcionado (elige según el material del día: en casa evita máquinas/barra). Si un ejercicio no está en el catálogo, usa exercise_id null y describe en exercise_name.
- En "notes" del ejercicio: consejos breves de peso/RPE o técnica en español.
- "focus": el objetivo del día en español (ej. "Empuje (pecho, hombro, tríceps)").
- "strategy": explica en 3-6 frases la estrategia de la semana y cualquier ajuste hecho por las circunstancias del usuario (fatiga, sueño, agujetas, tiempo disponible).
- Progresión conservadora; si el usuario reporta dolor o mala recuperación, baja volumen/intensidad y dilo en strategy.
Responde en español.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    strategy: { type: "string" },
    days: {
      type: "array",
      minItems: 7,
      maxItems: 7,
      items: {
        type: "object",
        properties: {
          date: { type: "string" },
          location: { type: "string", enum: ["casa", "gimnasio", "descanso"] },
          focus: { type: ["string", "null"] },
          exercises: {
            type: "array",
            items: {
              type: "object",
              properties: {
                exercise_id: { type: ["string", "null"] },
                exercise_name: { type: "string" },
                sets: { type: ["integer", "null"], minimum: 1, maximum: 10 },
                reps: { type: "string" },
                rest_seconds: { type: ["integer", "null"], minimum: 0, maximum: 600 },
                notes: { type: ["string", "null"] },
              },
              required: ["exercise_id", "exercise_name", "sets", "reps", "rest_seconds", "notes"],
              additionalProperties: false,
            },
          },
        },
        required: ["date", "location", "focus", "exercises"],
        additionalProperties: false,
      },
    },
  },
  required: ["strategy", "days"],
  additionalProperties: false,
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function mondayOf(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return d;
}

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

    const body = await request.json().catch(() => ({}));
    const userMessage = typeof body?.message === "string" ? body.message.trim() : "";

    const today = new Date();
    const weekStart = mondayOf(today);
    const weekDates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart);
      d.setUTCDate(d.getUTCDate() + i);
      return isoDate(d);
    });

    // Contexto: plan actual (si existe), entrenos hechos, estado reciente y última revisión.
    const [planRes, logsRes, workoutsRes, reviewRes, profileRes] = await Promise.all([
      supabase
        .from("workout_plans")
        .select("id, strategy, planned_workouts(date, location, focus, status, notes, planned_exercises(exercise_id, exercise_name, sets, reps, rest_seconds, notes, order_index))")
        .eq("user_id", user.id)
        .eq("week_start", isoDate(weekStart))
        .maybeSingle(),
      supabase
        .from("daily_logs")
        .select("date, sleep_hours, energy_level, steps, general_status")
        .eq("user_id", user.id)
        .gte("date", isoDate(new Date(weekStart.getTime() - 7 * 86400000)))
        .order("date", { ascending: true }),
      supabase
        .from("workouts")
        .select("date, workout_type")
        .eq("user_id", user.id)
        .gte("date", weekDates[0])
        .lte("date", weekDates[6]),
      supabase
        .from("weekly_reviews")
        .select("ai_summary, recommended_adjustment")
        .eq("user_id", user.id)
        .order("week_start", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("profiles")
        .select("target_weight, daily_step_target, daily_protein_target")
        .eq("id", user.id)
        .maybeSingle(),
    ]);

    const existingPlan = planRes.data;

    const context = {
      hoy: isoDate(today),
      fechas_semana_lunes_a_domingo: weekDates,
      peticion_del_usuario: userMessage || null,
      plan_actual: existingPlan
        ? {
            strategy: existingPlan.strategy,
            dias: (existingPlan.planned_workouts ?? [])
              .sort((a, b) => a.date.localeCompare(b.date))
              .map((d) => ({
                date: d.date,
                location: d.location,
                focus: d.focus,
                status: d.status,
                ejercicios: (d.planned_exercises ?? [])
                  .sort((a, b) => a.order_index - b.order_index)
                  .map((e) => ({
                    exercise_id: e.exercise_id,
                    exercise_name: e.exercise_name,
                    sets: e.sets,
                    reps: e.reps,
                    rest_seconds: e.rest_seconds,
                    notes: e.notes,
                  })),
              })),
          }
        : null,
      entrenos_registrados_esta_semana: workoutsRes.data ?? [],
      estado_reciente_diario: logsRes.data ?? [],
      ultima_revision_semanal: reviewRes.data ?? null,
      objetivos_perfil: profileRes.data ?? null,
    };

    console.info("[workout-plan] request started", {
      requestId,
      hasExistingPlan: Boolean(existingPlan),
      hasMessage: Boolean(userMessage),
    });

    const result = await callGeminiJSON({
      apiKey,
      model: GEMINI_MODEL,
      systemPrompt: SYSTEM_PROMPT,
      parts: [
        {
          text: `CONTEXTO DEL USUARIO:\n${JSON.stringify(context, null, 1)}\n\nCATÁLOGO DE EJERCICIOS (formato id|material|músculo principal|nivel):\n${catalogForPrompt()}`,
        },
      ],
      responseSchema: RESPONSE_SCHEMA,
      timeoutMs: GEMINI_TIMEOUT_MS,
      maxOutputTokens: 8192,
    });

    if (!result.ok) {
      console.error("[workout-plan] Gemini failed", { requestId, message: result.message });
      return NextResponse.json({ error: result.message, requestId }, { status: result.status });
    }

    let plan;
    try {
      plan = WorkoutPlanAISchema.parse(JSON.parse(result.text));
    } catch (error) {
      console.error("[workout-plan] validation failed", { requestId, error, rawText: result.text });
      return NextResponse.json(
        { error: "La respuesta de la IA no superó la validación", requestId },
        { status: 502 }
      );
    }

    // Los ids que no estén en el catálogo se guardan como texto libre.
    for (const day of plan.days) {
      for (const ex of day.exercises) {
        if (ex.exercise_id && !exerciseIds.has(ex.exercise_id)) {
          ex.exercise_id = null;
        }
      }
    }

    // Conservamos el estado de los días ya marcados antes de regenerar.
    const preservedStatus = new Map<string, string>();
    if (existingPlan) {
      for (const d of existingPlan.planned_workouts ?? []) {
        if (d.status !== "pendiente") preservedStatus.set(d.date, d.status);
      }
    }

    const { data: planRow, error: planError } = await supabase
      .from("workout_plans")
      .upsert(
        {
          user_id: user.id,
          week_start: isoDate(weekStart),
          strategy: plan.strategy,
          status: "active",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,week_start" }
      )
      .select("id")
      .single();

    if (planError) {
      console.error("[workout-plan] plan upsert failed", { requestId, planError });
      return NextResponse.json({ error: "No se pudo guardar el plan", requestId }, { status: 500 });
    }

    const { error: deleteError } = await supabase
      .from("planned_workouts")
      .delete()
      .eq("plan_id", planRow.id);
    if (deleteError) {
      console.error("[workout-plan] delete old days failed", { requestId, deleteError });
      return NextResponse.json({ error: "No se pudo actualizar el plan", requestId }, { status: 500 });
    }

    for (const day of plan.days) {
      const { data: dayRow, error: dayError } = await supabase
        .from("planned_workouts")
        .insert({
          plan_id: planRow.id,
          user_id: user.id,
          date: day.date,
          location: day.location,
          focus: day.focus,
          status: preservedStatus.get(day.date) ?? "pendiente",
        })
        .select("id")
        .single();

      if (dayError) {
        console.error("[workout-plan] day insert failed", { requestId, dayError, date: day.date });
        return NextResponse.json({ error: "No se pudo guardar el plan", requestId }, { status: 500 });
      }

      if (day.exercises.length > 0) {
        const { error: exError } = await supabase.from("planned_exercises").insert(
          day.exercises.map((ex, i) => ({
            planned_workout_id: dayRow.id,
            user_id: user.id,
            order_index: i,
            exercise_id: ex.exercise_id,
            exercise_name: ex.exercise_name,
            sets: ex.sets,
            reps: ex.reps,
            rest_seconds: ex.rest_seconds,
            notes: ex.notes,
          }))
        );
        if (exError) {
          console.error("[workout-plan] exercises insert failed", { requestId, exError });
          return NextResponse.json({ error: "No se pudo guardar el plan", requestId }, { status: 500 });
        }
      }
    }

    // Auditoría sin bloquear la respuesta (el catálogo no se guarda).
    void supabase
      .from("ai_analyses")
      .insert({
        user_id: user.id,
        source_type: "workout_plan",
        source_id: planRow.id,
        provider: "google",
        model: GEMINI_MODEL,
        prompt_version: "v1",
        input_data: context,
        output_data: plan,
        status: "done",
      })
      .then(({ error }) => {
        if (error) console.error("[workout-plan] audit insert failed", { requestId, error });
      });

    console.info("[workout-plan] request completed", {
      requestId,
      elapsedMs: Date.now() - startedAt,
    });

    return NextResponse.json({ data: { planId: planRow.id }, requestId });
  } catch (error) {
    console.error("[workout-plan] unexpected error", {
      requestId,
      elapsedMs: Date.now() - startedAt,
      error,
    });
    return NextResponse.json({ error: "Error inesperado en el servidor", requestId }, { status: 500 });
  }
}
