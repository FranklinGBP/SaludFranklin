import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { callGeminiJSON } from "@/lib/gemini";
import {
  calculateIngredient,
  nutritionFoods,
  nutritionFoodMap,
  type CalculatedIngredient,
  type NutritionFood,
  type NutritionRisk,
} from "@/lib/nutrition-catalog";

export const maxDuration = 60;

const GEMINI_MODEL = "gemini-3.5-flash";
// El reintento usa Flash-Lite: además de ser más rápido, tiene una cuota
// independiente, por lo que esquiva los 429 por límite de uso del principal.
const GEMINI_FALLBACK_MODEL = "gemini-3.1-flash-lite";
const GEMINI_TIMEOUT_MS = 25_000;

type MealType = "desayuno" | "comida" | "cena" | "snack";

type NutritionPreferences = {
  target_calories: number;
  target_protein: number;
  lactose_intolerance: boolean;
  fructose_intolerance: boolean;
  sorbitol_intolerance: boolean;
  avoid_foods: string[];
  notes: string | null;
};

type StoredIngredient = {
  food_id: string;
  name: string;
  grams: number;
  visual_portion: string;
  calories: number;
  protein: number;
  carbs: number;
  fats: number;
};

type StoredMeal = {
  id: string;
  meal_type: MealType;
  order_index: number;
  title: string;
  ingredients: StoredIngredient[];
  calories: number | string;
  protein: number | string;
  carbs: number | string;
  fats: number | string;
  preparation: string | null;
  visual_portion: string | null;
  notes: string | null;
};

type StoredDay = {
  id: string;
  date: string;
  calories: number | string;
  protein: number | string;
  carbs: number | string;
  fats: number | string;
  nutrition_plan_meals: StoredMeal[];
};

type StoredPlan = {
  id: string;
  week_start: string;
  target_calories: number;
  target_protein: number;
  strategy: string | null;
  nutrition_plan_days: StoredDay[];
};

type CalculatedReplacement = {
  key: string;
  dayId: string;
  mealId: string;
  mealType: MealType;
  orderIndex: number;
  date: string;
  title: string;
  ingredients: CalculatedIngredient[];
  calories: number;
  protein: number;
  carbs: number;
  fats: number;
  preparation: string;
  visualPortion: string;
  notes: string | null;
};

const IngredientChangeSchema = z.object({
  food_id: z.string().min(1),
  grams: z.number().min(5).max(600),
});

const MealChangeSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  order_index: z.number().int().min(0).max(4),
  title: z.string().min(2).max(120),
  ingredients: z.array(IngredientChangeSchema).min(1).max(6),
  preparation: z.string().min(2).max(500),
  visual_portion: z.string().min(2).max(250),
  notes: z.string().max(300).nullable(),
});

const NutritionEditSchema = z.object({
  summary: z.string().min(3).max(800),
  changes: z.array(MealChangeSchema).min(1).max(35),
});

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    changes: {
      type: "array",
      minItems: 1,
      maxItems: 35,
      items: {
        type: "object",
        properties: {
          date: { type: "string" },
          order_index: { type: "integer" },
          title: { type: "string" },
          ingredients: {
            type: "array",
            minItems: 1,
            maxItems: 6,
            items: {
              type: "object",
              properties: {
                food_id: { type: "string" },
                grams: { type: "number" },
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
          "date",
          "order_index",
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
  required: ["summary", "changes"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `Eres el asistente de edición de un plan nutricional semanal ya existente.

Debes interpretar la instrucción del usuario y devolver ÚNICAMENTE las comidas que haya que sustituir. El servidor conservará todas las demás comidas y recalculará los nutrientes.

Reglas obligatorias:
- Solo puedes editar combinaciones existentes de date + order_index.
- Conserva el número de días, el número de comidas y el tipo de comida de cada posición.
- Usa únicamente food_id del catálogo permitido.
- Respeta estrictamente las intolerancias, alimentos excluidos y notas del usuario.
- No añadas ingredientes implícitos que no estén en el catálogo.
- Cada comida debe tener entre 1 y 6 ingredientes.
- Mantén aproximadamente las calorías y proteína de la comida sustituida, salvo que la instrucción pida expresamente subirlas o bajarlas.
- Si la instrucción afecta a varias comidas, devuelve todas las sustituciones necesarias.
- Si pide cambiar un alimento en toda la semana, modifica todas las comidas en las que aparezca.
- Si pide cambiar un día completo, devuelve todas las comidas de ese día.
- No cambies comidas que no estén relacionadas con la instrucción.
- No uses cebolla, ajo, miel, zumos, polioles, alcoholes de azúcar ni salsas fuera del catálogo.
- visual_portion debe usar referencias sencillas: palmas, puños, vasos, cucharadas, unidades, cuencos o porciones del plato.
- summary explica brevemente qué se ha modificado.
- Responde en español.`;

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

function numberValue(value: number | string | null | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizedPreferences(
  value: Partial<NutritionPreferences> | null,
  plan: StoredPlan
): NutritionPreferences {
  return {
    target_calories: Math.max(
      1200,
      Math.min(4500, Number(value?.target_calories) || plan.target_calories || 2200)
    ),
    target_protein: Math.max(
      60,
      Math.min(300, Number(value?.target_protein) || plan.target_protein || 160)
    ),
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
      ].join("|")
    )
    .join("\n");
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

    const body = await request.json().catch(() => ({}));
    const instruction =
      typeof body?.instruction === "string" ? body.instruction.trim().slice(0, 1500) : "";

    if (instruction.length < 3) {
      return NextResponse.json(
        { error: "Escribe una instrucción concreta para modificar el plan.", requestId },
        { status: 400 }
      );
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey.startsWith("PON_AQUI")) {
      return NextResponse.json(
        { error: "Falta configurar GEMINI_API_KEY en Vercel.", requestId },
        { status: 500 }
      );
    }

    const weekStart = isoDate(mondayOf(new Date()));
    const [planResult, preferencesResult] = await Promise.all([
      supabase
        .from("nutrition_plans")
        .select(
          "id, week_start, target_calories, target_protein, strategy, nutrition_plan_days(id, date, calories, protein, carbs, fats, nutrition_plan_meals(id, meal_type, order_index, title, ingredients, calories, protein, carbs, fats, preparation, visual_portion, notes))"
        )
        .eq("user_id", user.id)
        .eq("week_start", weekStart)
        .maybeSingle(),
      supabase
        .from("nutrition_preferences")
        .select(
          "target_calories, target_protein, lactose_intolerance, fructose_intolerance, sorbitol_intolerance, avoid_foods, notes"
        )
        .eq("user_id", user.id)
        .maybeSingle(),
    ]);

    if (planResult.error) {
      console.error("[nutrition-plan-edit] plan query failed", { requestId, error: planResult.error });
      return NextResponse.json({ error: "No se pudo leer el plan actual.", requestId }, { status: 500 });
    }

    const plan = (planResult.data as StoredPlan | null) ?? null;
    if (!plan || !plan.nutrition_plan_days?.length) {
      return NextResponse.json(
        { error: "No existe un plan semanal que se pueda modificar.", requestId },
        { status: 404 }
      );
    }

    const preferences = normalizedPreferences(
      (preferencesResult.data as Partial<NutritionPreferences> | null) ?? null,
      plan
    );
    const allowedFoods = allowedCatalog(preferences);
    const allowedIds = new Set(allowedFoods.map((food) => food.id));

    const days = plan.nutrition_plan_days
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((day) => ({
        ...day,
        nutrition_plan_meals: (day.nutrition_plan_meals ?? [])
          .slice()
          .sort((a, b) => a.order_index - b.order_index),
      }));

    const currentPlan = days.map((day) => ({
      date: day.date,
      meals: day.nutrition_plan_meals.map((meal) => ({
        order_index: meal.order_index,
        meal_type: meal.meal_type,
        title: meal.title,
        ingredients: (meal.ingredients ?? []).map((ingredient) => ({
          food_id: ingredient.food_id,
          grams: numberValue(ingredient.grams),
        })),
        calories: numberValue(meal.calories),
        protein: numberValue(meal.protein),
      })),
    }));

    console.info("[nutrition-plan-edit] request started", {
      requestId,
      instructionLength: instruction.length,
      availableFoods: allowedFoods.length,
    });

    const result = await callGeminiJSON({
      apiKey,
      model: GEMINI_MODEL,
      systemPrompt: SYSTEM_PROMPT,
      parts: [
        {
          text: `INSTRUCCIÓN DEL USUARIO:\n${instruction}\n\nOBJETIVOS Y RESTRICCIONES:\n${JSON.stringify(
            preferences,
            null,
            1
          )}\n\nPLAN ACTUAL:\n${JSON.stringify(
            currentPlan,
            null,
            1
          )}\n\nCATÁLOGO PERMITIDO:\n${catalogForPrompt(allowedFoods)}`,
        },
      ],
      responseSchema: RESPONSE_SCHEMA,
      timeoutMs: GEMINI_TIMEOUT_MS,
      maxOutputTokens: 7000,
      maxAttempts: 2,
      fallbackModel: GEMINI_FALLBACK_MODEL,
    });

    if (!result.ok) {
      console.error("[nutrition-plan-edit] Gemini failed", { requestId, message: result.message });
      return NextResponse.json({ error: result.message, requestId }, { status: result.status });
    }

    let edit;
    try {
      edit = NutritionEditSchema.parse(JSON.parse(result.text));
    } catch (validationError) {
      console.error("[nutrition-plan-edit] response validation failed", {
        requestId,
        validationError,
        rawText: result.text,
      });
      return NextResponse.json(
        { error: "El asistente no devolvió cambios válidos. Prueba con una instrucción más concreta.", requestId },
        { status: 502 }
      );
    }

    const existingByKey = new Map<
      string,
      { day: StoredDay; meal: StoredMeal }
    >();
    for (const day of days) {
      for (const meal of day.nutrition_plan_meals) {
        existingByKey.set(`${day.date}#${meal.order_index}`, { day, meal });
      }
    }

    const seenChanges = new Set<string>();
    const replacements: CalculatedReplacement[] = [];

    for (const change of edit.changes) {
      const key = `${change.date}#${change.order_index}`;
      const existing = existingByKey.get(key);
      if (!existing || seenChanges.has(key)) {
        return NextResponse.json(
          { error: "El asistente intentó modificar una comida que no existe o la repitió.", requestId },
          { status: 502 }
        );
      }
      seenChanges.add(key);

      const ingredients: CalculatedIngredient[] = [];
      for (const ingredient of change.ingredients) {
        const food = nutritionFoodMap.get(ingredient.food_id);
        if (
          !food ||
          !allowedIds.has(ingredient.food_id) ||
          !food.mealTypes.includes(existing.meal.meal_type)
        ) {
          return NextResponse.json(
            { error: "El asistente intentó usar un alimento no permitido para esa comida.", requestId },
            { status: 502 }
          );
        }

        const calculated = calculateIngredient(ingredient.food_id, ingredient.grams);
        if (!calculated) {
          return NextResponse.json(
            { error: "No se pudieron calcular los nutrientes de uno de los alimentos.", requestId },
            { status: 502 }
          );
        }
        ingredients.push(calculated);
      }

      replacements.push({
        key,
        dayId: existing.day.id,
        mealId: existing.meal.id,
        mealType: existing.meal.meal_type,
        orderIndex: existing.meal.order_index,
        date: existing.day.date,
        title: change.title,
        ingredients,
        calories: round1(ingredients.reduce((sum, item) => sum + item.calories, 0)),
        protein: round1(ingredients.reduce((sum, item) => sum + item.protein, 0)),
        carbs: round1(ingredients.reduce((sum, item) => sum + item.carbs, 0)),
        fats: round1(ingredients.reduce((sum, item) => sum + item.fats, 0)),
        preparation: change.preparation,
        visualPortion: change.visual_portion,
        notes: change.notes,
      });
    }

    const { error: mealsError } = await supabase.from("nutrition_plan_meals").upsert(
      replacements.map((replacement) => ({
        id: replacement.mealId,
        day_id: replacement.dayId,
        user_id: user.id,
        meal_type: replacement.mealType,
        order_index: replacement.orderIndex,
        title: replacement.title,
        ingredients: replacement.ingredients,
        calories: replacement.calories,
        protein: replacement.protein,
        carbs: replacement.carbs,
        fats: replacement.fats,
        preparation: replacement.preparation,
        visual_portion: replacement.visualPortion,
        notes: replacement.notes,
      })),
      { onConflict: "id" }
    );

    if (mealsError) {
      console.error("[nutrition-plan-edit] meal upsert failed", { requestId, mealsError });
      return NextResponse.json({ error: "No se pudieron guardar los cambios.", requestId }, { status: 500 });
    }

    const replacementByKey = new Map(replacements.map((replacement) => [replacement.key, replacement]));
    const affectedDates = new Set(replacements.map((replacement) => replacement.date));
    const dayRows = days
      .filter((day) => affectedDates.has(day.date))
      .map((day) => {
        const totals = day.nutrition_plan_meals.reduce(
          (sum, meal) => {
            const replacement = replacementByKey.get(`${day.date}#${meal.order_index}`);
            return {
              calories: sum.calories + (replacement?.calories ?? numberValue(meal.calories)),
              protein: sum.protein + (replacement?.protein ?? numberValue(meal.protein)),
              carbs: sum.carbs + (replacement?.carbs ?? numberValue(meal.carbs)),
              fats: sum.fats + (replacement?.fats ?? numberValue(meal.fats)),
            };
          },
          { calories: 0, protein: 0, carbs: 0, fats: 0 }
        );

        return {
          id: day.id,
          plan_id: plan.id,
          user_id: user.id,
          date: day.date,
          calories: round1(totals.calories),
          protein: round1(totals.protein),
          carbs: round1(totals.carbs),
          fats: round1(totals.fats),
        };
      });

    const { error: daysError } = await supabase
      .from("nutrition_plan_days")
      .upsert(dayRows, { onConflict: "id" });

    if (daysError) {
      console.error("[nutrition-plan-edit] day totals upsert failed", { requestId, daysError });
      return NextResponse.json(
        { error: "Las comidas se actualizaron, pero no se pudieron recalcular los totales.", requestId },
        { status: 500 }
      );
    }

    const { error: planUpdateError } = await supabase
      .from("nutrition_plans")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", plan.id)
      .eq("user_id", user.id);

    if (planUpdateError) {
      console.error("[nutrition-plan-edit] plan timestamp update failed", {
        requestId,
        planUpdateError,
      });
    }

    void supabase
      .from("ai_analyses")
      .insert({
        user_id: user.id,
        source_type: "nutrition_plan_edit",
        source_id: plan.id,
        provider: "google",
        model: GEMINI_MODEL,
        prompt_version: "nutrition_edit_v1",
        input_data: { instruction, preferences, currentPlan },
        output_data: edit,
        status: "done",
      })
      .then(({ error }) => {
        if (error) console.error("[nutrition-plan-edit] audit insert failed", { requestId, error });
      });

    console.info("[nutrition-plan-edit] request completed", {
      requestId,
      changedMeals: replacements.length,
      elapsedMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      data: {
        summary: edit.summary,
        changedMeals: replacements.length,
      },
      requestId,
    });
  } catch (error) {
    console.error("[nutrition-plan-edit] unexpected error", {
      requestId,
      elapsedMs: Date.now() - startedAt,
      error,
    });
    return NextResponse.json(
      { error: "Error inesperado al modificar el plan nutricional.", requestId },
      { status: 500 }
    );
  }
}
