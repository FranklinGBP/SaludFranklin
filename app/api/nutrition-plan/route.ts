import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { callGeminiJSON } from "@/lib/gemini";
import { NutritionPlanAISchema } from "@/lib/schemas";
import {
  calculateIngredient,
  nutritionFoods,
  nutritionFoodMap,
  type NutritionFood,
  type NutritionRisk,
} from "@/lib/nutrition-catalog";

export const maxDuration = 60;

const GEMINI_MODEL = "gemini-3.5-flash";
const GEMINI_TIMEOUT_MS = 50_000;

type NutritionPreferences = {
  objective: string;
  target_calories: number;
  target_protein: number;
  meals_per_day: number;
  lactose_intolerance: boolean;
  fructose_intolerance: boolean;
  sorbitol_intolerance: boolean;
  avoid_foods: string[];
  notes: string | null;
};

const DEFAULT_PREFERENCES: NutritionPreferences = {
  objective: "Perder grasa sin perder músculo",
  target_calories: 2200,
  target_protein: 160,
  meals_per_day: 4,
  lactose_intolerance: true,
  fructose_intolerance: true,
  sorbitol_intolerance: true,
  avoid_foods: [],
  notes: "Comidas sencillas y digestivas. No quiero depender de pesar siempre la comida.",
};

const SYSTEM_PROMPT = `Eres un dietista-nutricionista virtual que crea planes alimentarios prácticos para pérdida de grasa preservando masa muscular.

Tu trabajo NO es inventar valores nutricionales. Solo eliges alimentos y gramos del catálogo proporcionado. El servidor calculará después calorías y macronutrientes usando datos controlados.

Reglas obligatorias:
- Devuelve exactamente 7 días y usa únicamente las fechas indicadas.
- Usa únicamente food_id presentes en el catálogo permitido.
- Respeta estrictamente las intolerancias y alimentos excluidos del usuario.
- Ajusta cada día al objetivo calórico con un margen aproximado de ±10% y alcanza como mínimo el objetivo de proteína cuando sea razonable.
- Genera exactamente el número de comidas solicitado por día.
- Con 3 comidas usa desayuno, comida y cena. Con 4 añade un snack. Con 5 usa dos snacks.
- Cada comida debe tener entre 1 y 8 ingredientes. No añadas ingredientes implícitos que no estén en el catálogo.
- Las cantidades se expresan en gramos, pero visual_portion debe traducirlas a referencias fáciles: palmas, puños, platos, vasos, cucharadas, unidades o cuencos.
- Prioriza recetas simples, repetibles, fáciles de comprar y preparar por lotes.
- No uses cebolla, ajo, miel, zumos, polioles, alcoholes de azúcar ni salsas no incluidas en el catálogo.
- No hagas diagnósticos ni afirmaciones médicas. Los datos son orientativos.
- strategy debe explicar brevemente la estructura semanal y cómo protege proteína, adherencia y tolerancia digestiva.
- shopping_tips debe resumir compra y batch cooking en texto breve.
- Responde en español.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    strategy: { type: "string" },
    shopping_tips: { type: "string" },
    days: {
      type: "array",
      minItems: 7,
      maxItems: 7,
      items: {
        type: "object",
        properties: {
          date: { type: "string" },
          meals: {
            type: "array",
            minItems: 3,
            maxItems: 5,
            items: {
              type: "object",
              properties: {
                meal_type: {
                  type: "string",
                  enum: ["desayuno", "comida", "cena", "snack"],
                },
                title: { type: "string" },
                ingredients: {
                  type: "array",
                  minItems: 1,
                  maxItems: 8,
                  items: {
                    type: "object",
                    properties: {
                      food_id: { type: "string" },
                      grams: { type: "number", minimum: 5, maximum: 600 },
                    },
                    required: ["food_id", "grams"],
                    additionalProperties: false,
                  },
                },
                preparation: { type: "string" },
                visual_portion: { type: "string" },
                notes: { type: ["string", "null"] },
              },
              required: [
                "meal_type",
                "title",
                "ingredients",
                "preparation",
                "visual_portion",
                "notes",
              ],
              additionalProperties: false,
            },
          },
        },
        required: ["date", "meals"],
        additionalProperties: false,
      },
    },
  },
  required: ["strategy", "shopping_tips", "days"],
  additionalProperties: false,
};

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function mondayOf(date: Date): Date {
  const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = result.getUTCDay();
  result.setUTCDate(result.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return result;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function normalizedPreferences(value: Partial<NutritionPreferences> | null): NutritionPreferences {
  return {
    objective: value?.objective?.trim() || DEFAULT_PREFERENCES.objective,
    target_calories: Math.max(1200, Math.min(4500, Number(value?.target_calories) || 2200)),
    target_protein: Math.max(60, Math.min(300, Number(value?.target_protein) || 160)),
    meals_per_day: Math.max(3, Math.min(5, Number(value?.meals_per_day) || 4)),
    lactose_intolerance: value?.lactose_intolerance ?? true,
    fructose_intolerance: value?.fructose_intolerance ?? true,
    sorbitol_intolerance: value?.sorbitol_intolerance ?? true,
    avoid_foods: Array.isArray(value?.avoid_foods)
      ? value.avoid_foods.map((item) => String(item).trim()).filter(Boolean).slice(0, 30)
      : [],
    notes: value?.notes?.trim() || null,
  };
}

function excludedRisks(preferences: NutritionPreferences): NutritionRisk[] {
  const risks: NutritionRisk[] = [];
  if (preferences.lactose_intolerance) risks.push("lactosa");
  if (preferences.fructose_intolerance) risks.push("fructosa");
  if (preferences.sorbitol_intolerance) risks.push("sorbitol");
  return risks;
}

function allowedCatalog(preferences: NutritionPreferences): NutritionFood[] {
  const risks = new Set(excludedRisks(preferences));
  const avoided = preferences.avoid_foods.map((item) => item.toLocaleLowerCase("es"));

  return nutritionFoods.filter((food) => {
    if (food.risks.some((risk) => risks.has(risk))) return false;
    const searchable = `${food.id} ${food.name}`.toLocaleLowerCase("es");
    return !avoided.some((term) => searchable.includes(term));
  });
}

function catalogForPrompt(foods: NutritionFood[]): string {
  return foods
    .map((food) =>
      [
        food.id,
        food.name,
        food.category,
        `kcal100:${food.kcal}`,
        `P100:${food.protein}`,
        `C100:${food.carbs}`,
        `G100:${food.fats}`,
        `racion:${food.defaultGrams}g`,
        `comidas:${food.mealTypes.join(",")}`,
        food.notes ? `nota:${food.notes}` : "",
      ]
        .filter(Boolean)
        .join("|")
    )
    .join("\n");
}

function databaseErrorMessage(message: string): string {
  if (message.includes("nutrition_preferences") || message.includes("nutrition_plans")) {
    return "Falta ejecutar el archivo supabase/nutrition_planner.sql en Supabase.";
  }
  return "No se pudo guardar el plan nutricional.";
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
    const userMessage = typeof body?.message === "string" ? body.message.trim().slice(0, 1500) : "";

    const today = new Date();
    const weekStart = mondayOf(today);
    const weekDates = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(weekStart);
      date.setUTCDate(date.getUTCDate() + index);
      return isoDate(date);
    });

    const [preferencesRes, profileRes, logsRes, reviewRes] = await Promise.all([
      supabase
        .from("nutrition_preferences")
        .select(
          "objective, target_calories, target_protein, meals_per_day, lactose_intolerance, fructose_intolerance, sorbitol_intolerance, avoid_foods, notes"
        )
        .eq("user_id", user.id)
        .maybeSingle(),
      supabase
        .from("profiles")
        .select("target_weight, daily_protein_target, daily_step_target")
        .eq("id", user.id)
        .maybeSingle(),
      supabase
        .from("daily_logs")
        .select("date, sleep_hours, energy_level, hunger_level, general_status")
        .eq("user_id", user.id)
        .gte("date", isoDate(new Date(weekStart.getTime() - 7 * 86400000)))
        .order("date", { ascending: true }),
      supabase
        .from("weekly_reviews")
        .select("ai_summary, recommended_adjustment")
        .eq("user_id", user.id)
        .order("week_start", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (preferencesRes.error) {
      return NextResponse.json(
        { error: databaseErrorMessage(preferencesRes.error.message), requestId },
        { status: 500 }
      );
    }

    const preferences = normalizedPreferences(
      (preferencesRes.data as Partial<NutritionPreferences> | null) ?? null
    );
    const allowedFoods = allowedCatalog(preferences);
    const allowedIds = new Set(allowedFoods.map((food) => food.id));

    if (allowedFoods.length < 12) {
      return NextResponse.json(
        {
          error: "Las exclusiones dejan muy pocos alimentos disponibles. Revisa tus preferencias.",
          requestId,
        },
        { status: 400 }
      );
    }

    const context = {
      hoy: isoDate(today),
      fechas_semana_lunes_a_domingo: weekDates,
      peticion_del_usuario: userMessage || null,
      preferencias: preferences,
      perfil: profileRes.data ?? null,
      estado_reciente: logsRes.data ?? [],
      ultima_revision: reviewRes.data ?? null,
    };

    console.info("[nutrition-plan] request started", {
      requestId,
      mealsPerDay: preferences.meals_per_day,
      allowedFoods: allowedFoods.length,
    });

    const result = await callGeminiJSON({
      apiKey,
      model: GEMINI_MODEL,
      systemPrompt: SYSTEM_PROMPT,
      parts: [
        {
          text: `CONTEXTO DEL USUARIO:\n${JSON.stringify(
            context,
            null,
            1
          )}\n\nCATÁLOGO PERMITIDO (id|nombre|categoría|macros por 100g|ración visual):\n${catalogForPrompt(
            allowedFoods
          )}`,
        },
      ],
      responseSchema: RESPONSE_SCHEMA,
      timeoutMs: GEMINI_TIMEOUT_MS,
      maxOutputTokens: 12000,
    });

    if (!result.ok) {
      console.error("[nutrition-plan] Gemini failed", { requestId, message: result.message });
      return NextResponse.json({ error: result.message, requestId }, { status: result.status });
    }

    let aiPlan;
    try {
      aiPlan = NutritionPlanAISchema.parse(JSON.parse(result.text));
    } catch (error) {
      console.error("[nutrition-plan] validation failed", { requestId, error, rawText: result.text });
      return NextResponse.json(
        { error: "La respuesta de la IA no superó la validación.", requestId },
        { status: 502 }
      );
    }

    const dates = aiPlan.days.map((day) => day.date);
    if (dates.join("|") !== weekDates.join("|")) {
      return NextResponse.json(
        { error: "La IA devolvió fechas incorrectas para la semana.", requestId },
        { status: 502 }
      );
    }

    for (const day of aiPlan.days) {
      if (day.meals.length !== preferences.meals_per_day) {
        return NextResponse.json(
          { error: "La IA no respetó el número de comidas solicitado.", requestId },
          { status: 502 }
        );
      }
      for (const meal of day.meals) {
        for (const ingredient of meal.ingredients) {
          if (!allowedIds.has(ingredient.food_id) || !nutritionFoodMap.has(ingredient.food_id)) {
            return NextResponse.json(
              { error: "La IA intentó usar un alimento no permitido.", requestId },
              { status: 502 }
            );
          }
        }
      }
    }

    const calculatedDays = aiPlan.days.map((day) => {
      const meals = day.meals.map((meal, orderIndex) => {
        const ingredients = meal.ingredients.map((ingredient) => {
          const calculated = calculateIngredient(ingredient.food_id, ingredient.grams);
          if (!calculated) throw new Error(`Unknown food id: ${ingredient.food_id}`);
          return calculated;
        });

        return {
          meal_type: meal.meal_type,
          order_index: orderIndex,
          title: meal.title,
          ingredients,
          calories: round1(ingredients.reduce((sum, item) => sum + item.calories, 0)),
          protein: round1(ingredients.reduce((sum, item) => sum + item.protein, 0)),
          carbs: round1(ingredients.reduce((sum, item) => sum + item.carbs, 0)),
          fats: round1(ingredients.reduce((sum, item) => sum + item.fats, 0)),
          preparation: meal.preparation,
          visual_portion: meal.visual_portion,
          notes: meal.notes,
        };
      });

      return {
        date: day.date,
        meals,
        calories: round1(meals.reduce((sum, meal) => sum + meal.calories, 0)),
        protein: round1(meals.reduce((sum, meal) => sum + meal.protein, 0)),
        carbs: round1(meals.reduce((sum, meal) => sum + meal.carbs, 0)),
        fats: round1(meals.reduce((sum, meal) => sum + meal.fats, 0)),
      };
    });

    const { data: planRow, error: planError } = await supabase
      .from("nutrition_plans")
      .upsert(
        {
          user_id: user.id,
          week_start: isoDate(weekStart),
          strategy: aiPlan.strategy,
          shopping_tips: aiPlan.shopping_tips,
          target_calories: preferences.target_calories,
          target_protein: preferences.target_protein,
          status: "active",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,week_start" }
      )
      .select("id")
      .single();

    if (planError) {
      console.error("[nutrition-plan] plan upsert failed", { requestId, planError });
      return NextResponse.json(
        { error: databaseErrorMessage(planError.message), requestId },
        { status: 500 }
      );
    }

    const { error: deleteError } = await supabase
      .from("nutrition_plan_days")
      .delete()
      .eq("plan_id", planRow.id);

    if (deleteError) {
      console.error("[nutrition-plan] delete old plan failed", { requestId, deleteError });
      return NextResponse.json(
        { error: databaseErrorMessage(deleteError.message), requestId },
        { status: 500 }
      );
    }

    for (const day of calculatedDays) {
      const { data: dayRow, error: dayError } = await supabase
        .from("nutrition_plan_days")
        .insert({
          plan_id: planRow.id,
          user_id: user.id,
          date: day.date,
          calories: day.calories,
          protein: day.protein,
          carbs: day.carbs,
          fats: day.fats,
        })
        .select("id")
        .single();

      if (dayError) {
        console.error("[nutrition-plan] day insert failed", { requestId, dayError, date: day.date });
        return NextResponse.json(
          { error: databaseErrorMessage(dayError.message), requestId },
          { status: 500 }
        );
      }

      const { error: mealsError } = await supabase.from("nutrition_plan_meals").insert(
        day.meals.map((meal) => ({
          day_id: dayRow.id,
          user_id: user.id,
          meal_type: meal.meal_type,
          order_index: meal.order_index,
          title: meal.title,
          ingredients: meal.ingredients,
          calories: meal.calories,
          protein: meal.protein,
          carbs: meal.carbs,
          fats: meal.fats,
          preparation: meal.preparation,
          visual_portion: meal.visual_portion,
          notes: meal.notes,
        }))
      );

      if (mealsError) {
        console.error("[nutrition-plan] meal insert failed", { requestId, mealsError });
        return NextResponse.json(
          { error: databaseErrorMessage(mealsError.message), requestId },
          { status: 500 }
        );
      }
    }

    void supabase
      .from("ai_analyses")
      .insert({
        user_id: user.id,
        source_type: "nutrition_plan",
        source_id: planRow.id,
        provider: "google",
        model: GEMINI_MODEL,
        prompt_version: "nutrition_v1",
        input_data: context,
        output_data: { aiPlan, calculatedDays },
        status: "done",
      })
      .then(({ error }) => {
        if (error) console.error("[nutrition-plan] audit insert failed", { requestId, error });
      });

    console.info("[nutrition-plan] request completed", {
      requestId,
      elapsedMs: Date.now() - startedAt,
    });

    return NextResponse.json({ data: { planId: planRow.id }, requestId });
  } catch (error) {
    console.error("[nutrition-plan] unexpected error", {
      requestId,
      elapsedMs: Date.now() - startedAt,
      error,
    });
    return NextResponse.json(
      { error: "Error inesperado al generar el plan nutricional.", requestId },
      { status: 500 }
    );
  }
}
