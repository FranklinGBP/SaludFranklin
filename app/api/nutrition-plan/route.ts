import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { callGeminiJSON } from "@/lib/gemini";
import {
  NutritionRotationAISchema,
  type NutritionRotationAIData,
  type NutritionRotationMealAIData,
} from "@/lib/schemas";
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
const GEMINI_TIMEOUT_MS = 25_000;

type MealType = NutritionRotationMealAIData["meal_type"];

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

type CalculatedMeal = {
  meal_type: MealType;
  order_index: number;
  title: string;
  ingredients: CalculatedIngredient[];
  calories: number;
  protein: number;
  carbs: number;
  fats: number;
  preparation: string;
  visual_portion: string;
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

const SYSTEM_PROMPT = `Eres un dietista-nutricionista virtual que crea una ROTACIÓN COMPACTA de comidas para una semana orientada a perder grasa preservando masa muscular.

No debes generar siete días completos repitiendo todos los ingredientes. Debes crear un banco pequeño de plantillas de comida y después una agenda semanal que solo referencia sus template_id. El servidor calculará los nutrientes y expandirá la semana.

Reglas obligatorias:
- Usa únicamente food_id presentes en el catálogo permitido.
- Respeta estrictamente intolerancias, alimentos excluidos y notas del usuario.
- Cada plantilla contiene entre 1 y 6 ingredientes.
- Las cantidades se expresan en gramos.
- visual_portion debe explicar la ración con referencias fáciles: palmas, puños, platos, vasos, cucharadas, unidades o cuencos.
- Prioriza recetas sencillas, repetibles y aptas para preparación por lotes.
- Crea exactamente el número de plantillas indicado para cada tipo de comida.
- Cada template_id debe ser corto, único y sin espacios.
- La agenda debe contener exactamente siete fechas y exactamente el número de template_ids diario solicitado.
- El orden diario debe ser el indicado en el contexto.
- No uses ingredientes implícitos que no estén en el catálogo.
- No uses cebolla, ajo, miel, zumos, polioles, alcoholes de azúcar ni salsas no incluidas en el catálogo.
- No hagas diagnósticos ni afirmaciones médicas.
- strategy debe explicar brevemente la estructura y la tolerancia digestiva.
- shopping_tips debe resumir compra y batch cooking.
- Responde en español.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    strategy: { type: "string" },
    shopping_tips: { type: "string" },
    templates: {
      type: "array",
      minItems: 6,
      maxItems: 12,
      items: {
        type: "object",
        properties: {
          template_id: { type: "string" },
          meal_type: {
            type: "string",
            enum: ["desayuno", "comida", "cena", "snack"],
          },
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
          "template_id",
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
    schedule: {
      type: "array",
      minItems: 7,
      maxItems: 7,
      items: {
        type: "object",
        properties: {
          date: { type: "string" },
          template_ids: {
            type: "array",
            minItems: 3,
            maxItems: 5,
            items: { type: "string" },
          },
        },
        required: ["date", "template_ids"],
        additionalProperties: false,
      },
    },
  },
  required: ["strategy", "shopping_tips", "templates", "schedule"],
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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

function expectedMealTypes(mealsPerDay: number): MealType[] {
  if (mealsPerDay === 3) return ["desayuno", "comida", "cena"];
  if (mealsPerDay === 5) return ["desayuno", "snack", "comida", "snack", "cena"];
  return ["desayuno", "comida", "snack", "cena"];
}

function requestedTemplateCounts(mealsPerDay: number): Record<MealType, number> {
  return {
    desayuno: 2,
    comida: 3,
    cena: 3,
    snack: mealsPerDay === 3 ? 0 : mealsPerDay === 4 ? 2 : 3,
  };
}

function uniqueFoods(foods: Array<NutritionFood | undefined>): NutritionFood[] {
  const seen = new Set<string>();
  return foods.filter((food): food is NutritionFood => {
    if (!food || seen.has(food.id)) return false;
    seen.add(food.id);
    return true;
  });
}

function pickFood(pool: NutritionFood[], index: number, fallback: NutritionFood[]): NutritionFood | undefined {
  const source = pool.length ? pool : fallback;
  return source.length ? source[index % source.length] : undefined;
}

function makeFallbackTemplate(
  templateId: string,
  mealType: MealType,
  foods: Array<NutritionFood | undefined>
): NutritionRotationMealAIData {
  const selected = uniqueFoods(foods);
  const title = selected.slice(0, 2).map((food) => food.name).join(" con ") || "Comida sencilla";

  return {
    template_id: templateId,
    meal_type: mealType,
    title,
    ingredients: selected.map((food) => ({ food_id: food.id, grams: food.defaultGrams })),
    preparation:
      mealType === "snack" || mealType === "desayuno"
        ? "Combina los ingredientes y sirve."
        : "Cocina la proteína y el acompañamiento de forma sencilla; sirve todo junto.",
    visual_portion: selected.map((food) => food.visualPortion).join(" + "),
    notes: "Plantilla automática de respaldo, ajustada después por el servidor.",
  };
}

function buildFallbackRotation(
  foods: NutritionFood[],
  preferences: NutritionPreferences,
  weekDates: string[]
): NutritionRotationAIData {
  const proteins = foods.filter(
    (food) => food.category === "proteina" || food.category === "lacteo"
  );
  const breakfastProteins = proteins.filter((food) => food.mealTypes.includes("desayuno"));
  const mainProteins = proteins.filter(
    (food) => food.mealTypes.includes("comida") || food.mealTypes.includes("cena")
  );
  const snackProteins = proteins.filter((food) => food.mealTypes.includes("snack"));
  const carbs = foods.filter((food) => food.category === "carbohidrato");
  const breakfastCarbs = carbs.filter((food) => food.mealTypes.includes("desayuno"));
  const mainCarbs = carbs.filter(
    (food) => food.mealTypes.includes("comida") || food.mealTypes.includes("cena")
  );
  const vegetables = foods.filter((food) => food.category === "verdura");
  const fats = foods.filter((food) => food.category === "grasa");
  const snackExtras = foods.filter(
    (food) => food.mealTypes.includes("snack") && food.category !== "proteina"
  );

  const templates: NutritionRotationMealAIData[] = [];

  for (let index = 0; index < 2; index++) {
    templates.push(
      makeFallbackTemplate(`des_${index + 1}`, "desayuno", [
        pickFood(breakfastProteins, index, proteins),
        pickFood(breakfastCarbs, index, carbs),
        pickFood(fats, index, foods),
      ])
    );
  }

  for (let index = 0; index < 3; index++) {
    templates.push(
      makeFallbackTemplate(`com_${index + 1}`, "comida", [
        pickFood(mainProteins, index, proteins),
        pickFood(mainCarbs, index, carbs),
        pickFood(vegetables, index, foods),
        foods.find((food) => food.id === "aceite_oliva"),
      ])
    );
    templates.push(
      makeFallbackTemplate(`cen_${index + 1}`, "cena", [
        pickFood(mainProteins, index + 1, proteins),
        pickFood(mainCarbs, index + 1, carbs),
        pickFood(vegetables, index + 1, foods),
        foods.find((food) => food.id === "aceite_oliva"),
      ])
    );
  }

  const snackCount = requestedTemplateCounts(preferences.meals_per_day).snack;
  for (let index = 0; index < snackCount; index++) {
    templates.push(
      makeFallbackTemplate(`snk_${index + 1}`, "snack", [
        pickFood(snackProteins, index, proteins),
        pickFood(snackExtras, index, fats.length ? fats : carbs),
      ])
    );
  }

  const rotation: NutritionRotationAIData = {
    strategy:
      "Plan semanal generado automáticamente con una rotación sencilla, alta en proteína y adaptada a las exclusiones configuradas. Las cantidades se equilibran en el servidor para acercarse a los objetivos diarios.",
    shopping_tips:
      "Cocina varias raciones de proteína, arroz o patata y verduras al inicio de la semana. Divide en recipientes y deja desayunos y snacks preparados.",
    templates,
    schedule: [],
  };

  rotation.schedule = buildDeterministicSchedule(rotation.templates, weekDates, preferences.meals_per_day);
  return rotation;
}

function groupTemplates(
  templates: NutritionRotationMealAIData[]
): Record<MealType, NutritionRotationMealAIData[]> {
  return {
    desayuno: templates.filter((template) => template.meal_type === "desayuno"),
    comida: templates.filter((template) => template.meal_type === "comida"),
    cena: templates.filter((template) => template.meal_type === "cena"),
    snack: templates.filter((template) => template.meal_type === "snack"),
  };
}

function buildDeterministicSchedule(
  templates: NutritionRotationMealAIData[],
  weekDates: string[],
  mealsPerDay: number
): NutritionRotationAIData["schedule"] {
  const groups = groupTemplates(templates);
  const expected = expectedMealTypes(mealsPerDay);

  return weekDates.map((date, dayIndex) => {
    const occurrences: Partial<Record<MealType, number>> = {};
    const templateIds = expected.map((mealType) => {
      const group = groups[mealType];
      if (!group.length) throw new Error(`Missing templates for ${mealType}`);
      const occurrence = occurrences[mealType] ?? 0;
      occurrences[mealType] = occurrence + 1;
      return group[(dayIndex + occurrence) % group.length].template_id;
    });
    return { date, template_ids: templateIds };
  });
}

function rotationIsUsable(
  rotation: NutritionRotationAIData,
  allowedIds: Set<string>,
  mealsPerDay: number
): boolean {
  const templateIds = new Set<string>();

  for (const template of rotation.templates) {
    if (templateIds.has(template.template_id)) return false;
    templateIds.add(template.template_id);
    if (template.ingredients.some((ingredient) => !allowedIds.has(ingredient.food_id))) return false;
  }

  const groups = groupTemplates(rotation.templates);
  return expectedMealTypes(mealsPerDay).every((mealType) => groups[mealType].length > 0);
}

function expandSchedule(
  rotation: NutritionRotationAIData,
  weekDates: string[],
  mealsPerDay: number
): Array<{ date: string; templates: NutritionRotationMealAIData[] }> {
  const templateMap = new Map(rotation.templates.map((template) => [template.template_id, template]));
  const expected = expectedMealTypes(mealsPerDay);
  const fallbackSchedule = buildDeterministicSchedule(rotation.templates, weekDates, mealsPerDay);

  return weekDates.map((date, dayIndex) => {
    const proposed = rotation.schedule.find((day) => day.date === date);
    const proposedTemplates = (proposed?.template_ids ?? [])
      .map((templateId) => templateMap.get(templateId))
      .filter((template): template is NutritionRotationMealAIData => Boolean(template));

    const valid =
      proposedTemplates.length === expected.length &&
      proposedTemplates.every((template, index) => template.meal_type === expected[index]);

    const selected = valid
      ? proposedTemplates
      : fallbackSchedule[dayIndex].template_ids.map((templateId) => templateMap.get(templateId)!);

    return { date, templates: selected };
  });
}

function recalculateMeal(meal: CalculatedMeal): CalculatedMeal {
  return {
    ...meal,
    calories: round1(meal.ingredients.reduce((sum, ingredient) => sum + ingredient.calories, 0)),
    protein: round1(meal.ingredients.reduce((sum, ingredient) => sum + ingredient.protein, 0)),
    carbs: round1(meal.ingredients.reduce((sum, ingredient) => sum + ingredient.carbs, 0)),
    fats: round1(meal.ingredients.reduce((sum, ingredient) => sum + ingredient.fats, 0)),
  };
}

function calculateMeal(
  template: NutritionRotationMealAIData,
  orderIndex: number,
  scale = 1
): CalculatedMeal {
  const ingredients = template.ingredients.map((ingredient) => {
    const calculated = calculateIngredient(ingredient.food_id, ingredient.grams * scale);
    if (!calculated) throw new Error(`Unknown food id: ${ingredient.food_id}`);
    return calculated;
  });

  return recalculateMeal({
    meal_type: template.meal_type,
    order_index: orderIndex,
    title: template.title,
    ingredients,
    calories: 0,
    protein: 0,
    carbs: 0,
    fats: 0,
    preparation: template.preparation,
    visual_portion: template.visual_portion,
    notes: template.notes,
  });
}

function mealTotals(meals: CalculatedMeal[]) {
  return {
    calories: round1(meals.reduce((sum, meal) => sum + meal.calories, 0)),
    protein: round1(meals.reduce((sum, meal) => sum + meal.protein, 0)),
    carbs: round1(meals.reduce((sum, meal) => sum + meal.carbs, 0)),
    fats: round1(meals.reduce((sum, meal) => sum + meal.fats, 0)),
  };
}

function addFoodToMeal(meal: CalculatedMeal, food: NutritionFood, grams: number): CalculatedMeal {
  const ingredients = [...meal.ingredients];
  const existingIndex = ingredients.findIndex((ingredient) => ingredient.food_id === food.id);

  if (existingIndex >= 0) {
    const replacement = calculateIngredient(food.id, ingredients[existingIndex].grams + grams);
    if (replacement) ingredients[existingIndex] = replacement;
  } else {
    const calculated = calculateIngredient(food.id, grams);
    if (calculated) ingredients.push(calculated);
  }

  return recalculateMeal({ ...meal, ingredients });
}

function balanceDay(
  templates: NutritionRotationMealAIData[],
  preferences: NutritionPreferences,
  allowedFoods: NutritionFood[]
) {
  let meals = templates.map((template, orderIndex) => calculateMeal(template, orderIndex));
  let totals = mealTotals(meals);

  if (totals.calories > 0 && (totals.calories < preferences.target_calories * 0.85 || totals.calories > preferences.target_calories * 1.15)) {
    const factor = clamp(preferences.target_calories / totals.calories, 0.75, 1.3);
    meals = templates.map((template, orderIndex) => calculateMeal(template, orderIndex, factor));
    totals = mealTotals(meals);
  }

  if (totals.protein < preferences.target_protein - 5) {
    const proteinFood = allowedFoods
      .filter((food) => food.protein >= 10 && food.kcal > 0)
      .sort((a, b) => b.protein / b.kcal - a.protein / a.kcal)[0];

    if (proteinFood) {
      const compatibleIndex = meals.findIndex((meal) => proteinFood.mealTypes.includes(meal.meal_type));
      if (compatibleIndex >= 0) {
        const missingProtein = preferences.target_protein - totals.protein;
        const grams = clamp((missingProtein / proteinFood.protein) * 100, 15, 120);
        meals[compatibleIndex] = addFoodToMeal(meals[compatibleIndex], proteinFood, grams);
        totals = mealTotals(meals);
      }
    }
  }

  if (totals.calories < preferences.target_calories * 0.92) {
    const missingCalories = preferences.target_calories - totals.calories;
    const oil = allowedFoods.find((food) => food.id === "aceite_oliva");
    const mainMealIndex = meals.findIndex(
      (meal) => meal.meal_type === "comida" || meal.meal_type === "cena"
    );

    if (oil && mainMealIndex >= 0) {
      const grams = clamp((missingCalories / oil.kcal) * 100, 5, 25);
      meals[mainMealIndex] = addFoodToMeal(meals[mainMealIndex], oil, grams);
      totals = mealTotals(meals);
    }
  }

  if (totals.calories < preferences.target_calories * 0.9) {
    const carb = allowedFoods
      .filter((food) => food.category === "carbohidrato" && food.mealTypes.includes("comida"))
      .sort((a, b) => b.kcal - a.kcal)[0];
    const lunchIndex = meals.findIndex((meal) => meal.meal_type === "comida");

    if (carb && lunchIndex >= 0) {
      const missingCalories = preferences.target_calories - totals.calories;
      const grams = clamp((missingCalories / carb.kcal) * 100, 20, 200);
      meals[lunchIndex] = addFoodToMeal(meals[lunchIndex], carb, grams);
      totals = mealTotals(meals);
    }
  }

  return { meals, ...totals };
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
      orden_comidas_diario: expectedMealTypes(preferences.meals_per_day),
      plantillas_requeridas: requestedTemplateCounts(preferences.meals_per_day),
      peticion_del_usuario: userMessage || null,
      preferencias: preferences,
      perfil: profileRes.data ?? null,
      estado_reciente: logsRes.data ?? [],
      ultima_revision: reviewRes.data ?? null,
    };

    console.info("[nutrition-plan] compact request started", {
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
      maxOutputTokens: 5000,
      maxAttempts: 1,
    });

    let rotation: NutritionRotationAIData;
    let generationMode: "ai" | "fallback" = "fallback";

    if (result.ok) {
      try {
        const parsed = NutritionRotationAISchema.parse(JSON.parse(result.text));
        if (rotationIsUsable(parsed, allowedIds, preferences.meals_per_day)) {
          rotation = parsed;
          generationMode = "ai";
        } else {
          console.warn("[nutrition-plan] AI rotation was not usable; using fallback", { requestId });
          rotation = buildFallbackRotation(allowedFoods, preferences, weekDates);
        }
      } catch (error) {
        console.warn("[nutrition-plan] AI rotation validation failed; using fallback", {
          requestId,
          error,
        });
        rotation = buildFallbackRotation(allowedFoods, preferences, weekDates);
      }
    } else {
      console.warn("[nutrition-plan] Gemini unavailable; using deterministic fallback", {
        requestId,
        message: result.message,
      });
      rotation = buildFallbackRotation(allowedFoods, preferences, weekDates);
    }

    const expandedDays = expandSchedule(rotation, weekDates, preferences.meals_per_day);
    const calculatedDays = expandedDays.map((day) => ({
      date: day.date,
      ...balanceDay(day.templates, preferences, allowedFoods),
    }));

    const { data: planRow, error: planError } = await supabase
      .from("nutrition_plans")
      .upsert(
        {
          user_id: user.id,
          week_start: isoDate(weekStart),
          strategy: rotation.strategy,
          shopping_tips: rotation.shopping_tips,
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
        prompt_version: "nutrition_rotation_v2",
        input_data: context,
        output_data: { generationMode, rotation, calculatedDays },
        status: "done",
      })
      .then(({ error }) => {
        if (error) console.error("[nutrition-plan] audit insert failed", { requestId, error });
      });

    console.info("[nutrition-plan] request completed", {
      requestId,
      generationMode,
      elapsedMs: Date.now() - startedAt,
    });

    return NextResponse.json({ data: { planId: planRow.id, generationMode }, requestId });
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
