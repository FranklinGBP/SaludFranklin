"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Ingredient = {
  food_id: string;
  name: string;
  grams: number;
  visual_portion: string;
  calories: number;
  protein: number;
  carbs: number;
  fats: number;
};

type NutritionMeal = {
  id: string;
  meal_type: "desayuno" | "comida" | "cena" | "snack";
  order_index: number;
  title: string;
  ingredients: Ingredient[];
  calories: number | string;
  protein: number | string;
  carbs: number | string;
  fats: number | string;
  preparation: string | null;
  visual_portion: string | null;
  notes: string | null;
};

type NutritionDay = {
  id: string;
  date: string;
  calories: number | string;
  protein: number | string;
  carbs: number | string;
  fats: number | string;
  nutrition_plan_meals: NutritionMeal[];
};

type NutritionPlan = {
  id: string;
  week_start: string;
  strategy: string | null;
  shopping_tips: string | null;
  target_calories: number;
  target_protein: number;
  nutrition_plan_days: NutritionDay[];
};

type Preferences = {
  objective: string;
  target_calories: number;
  target_protein: number;
  meals_per_day: number;
  lactose_intolerance: boolean;
  fructose_intolerance: boolean;
  sorbitol_intolerance: boolean;
  avoid_foods: string[];
  notes: string;
};

const DEFAULT_PREFERENCES: Preferences = {
  objective: "Perder grasa sin perder músculo",
  target_calories: 2200,
  target_protein: 160,
  meals_per_day: 4,
  lactose_intolerance: true,
  fructose_intolerance: true,
  sorbitol_intolerance: true,
  avoid_foods: [],
  notes: "Comidas sencillas, digestivas y con referencias visuales para no depender de pesar todo.",
};

const MEAL_ICON: Record<NutritionMeal["meal_type"], string> = {
  desayuno: "☕",
  comida: "🍽️",
  cena: "🌙",
  snack: "🥣",
};

function isoDate(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function mondayOfToday(): string {
  const date = new Date();
  const day = date.getDay();
  date.setDate(date.getDate() + (day === 0 ? -6 : 1 - day));
  return isoDate(date);
}

function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString("es-ES", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function numberValue(value: number | string | null | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatMacro(value: number | string): string {
  return Math.round(numberValue(value)).toString();
}

function shoppingAmount(grams: number): string {
  if (grams >= 1000) return `${(grams / 1000).toFixed(1)} kg`;
  return `${Math.round(grams / 10) * 10} g`;
}

function friendlyDatabaseError(message: string): string {
  if (message.includes("nutrition_preferences") || message.includes("nutrition_plans")) {
    return "Falta ejecutar supabase/nutrition_planner.sql en el SQL Editor de Supabase.";
  }
  return message;
}

export default function NutritionPage() {
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES);
  const [avoidFoodsText, setAvoidFoodsText] = useState("");
  const [plan, setPlan] = useState<NutritionPlan | null>(null);
  const [selectedDate, setSelectedDate] = useState(isoDate(new Date()));
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const weekStart = mondayOfToday();
  const today = isoDate(new Date());

  const loadData = useCallback(async () => {
    setError(null);
    const supabase = createClient();

    const [preferencesResult, planResult] = await Promise.all([
      supabase
        .from("nutrition_preferences")
        .select(
          "objective, target_calories, target_protein, meals_per_day, lactose_intolerance, fructose_intolerance, sorbitol_intolerance, avoid_foods, notes"
        )
        .maybeSingle(),
      supabase
        .from("nutrition_plans")
        .select(
          "id, week_start, strategy, shopping_tips, target_calories, target_protein, nutrition_plan_days(id, date, calories, protein, carbs, fats, nutrition_plan_meals(id, meal_type, order_index, title, ingredients, calories, protein, carbs, fats, preparation, visual_portion, notes))"
        )
        .eq("week_start", weekStart)
        .maybeSingle(),
    ]);

    if (preferencesResult.error) {
      setError(friendlyDatabaseError(preferencesResult.error.message));
      setLoading(false);
      return;
    }

    if (preferencesResult.data) {
      const loaded = preferencesResult.data as Preferences;
      setPreferences({
        ...DEFAULT_PREFERENCES,
        ...loaded,
        notes: loaded.notes ?? "",
        avoid_foods: loaded.avoid_foods ?? [],
      });
      setAvoidFoodsText((loaded.avoid_foods ?? []).join(", "));
    }

    if (planResult.error) {
      setError(friendlyDatabaseError(planResult.error.message));
    } else {
      const loadedPlan = (planResult.data as NutritionPlan | null) ?? null;
      setPlan(loadedPlan);
      const availableDates = (loadedPlan?.nutrition_plan_days ?? []).map((day) => day.date);
      if (availableDates.length > 0 && !availableDates.includes(selectedDate)) {
        setSelectedDate(availableDates.includes(today) ? today : availableDates[0]);
      }
    }

    setLoading(false);
  }, [selectedDate, today, weekStart]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function savePreferences(showConfirmation = true): Promise<boolean> {
    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Sesión no válida");

      const avoidFoods = avoidFoodsText
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 30);

      const payload = {
        user_id: user.id,
        ...preferences,
        avoid_foods: avoidFoods,
        objective: preferences.objective.trim() || DEFAULT_PREFERENCES.objective,
        notes: preferences.notes.trim() || null,
        target_calories: Math.max(1200, Math.min(4500, Number(preferences.target_calories))),
        target_protein: Math.max(60, Math.min(300, Number(preferences.target_protein))),
        meals_per_day: Math.max(3, Math.min(5, Number(preferences.meals_per_day))),
        updated_at: new Date().toISOString(),
      };

      const { error: saveError } = await supabase
        .from("nutrition_preferences")
        .upsert(payload, { onConflict: "user_id" });

      if (saveError) throw new Error(friendlyDatabaseError(saveError.message));

      setPreferences((current) => ({ ...current, avoid_foods: avoidFoods }));
      if (showConfirmation) setSuccess("Preferencias guardadas.");
      return true;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "No se pudieron guardar los ajustes.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function generatePlan() {
    setGenerating(true);
    setError(null);
    setSuccess(null);

    try {
      const saved = await savePreferences(false);
      if (!saved) return;

      const response = await fetch("/api/nutrition-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "No se pudo generar el plan.");

      setMessage("");
      setSuccess("Plan nutricional actualizado.");
      await loadData();
    } catch (generationError) {
      setError(
        generationError instanceof Error ? generationError.message : "Error inesperado al generar el plan."
      );
    } finally {
      setGenerating(false);
    }
  }

  const days = useMemo(
    () =>
      (plan?.nutrition_plan_days ?? [])
        .slice()
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((day) => ({
          ...day,
          nutrition_plan_meals: (day.nutrition_plan_meals ?? [])
            .slice()
            .sort((a, b) => a.order_index - b.order_index),
        })),
    [plan]
  );

  const selectedDay = days.find((day) => day.date === selectedDate) ?? days[0] ?? null;

  const shoppingList = useMemo(() => {
    const grouped = new Map<string, { name: string; grams: number }>();

    for (const day of days) {
      for (const meal of day.nutrition_plan_meals) {
        for (const ingredient of meal.ingredients ?? []) {
          const current = grouped.get(ingredient.food_id);
          grouped.set(ingredient.food_id, {
            name: ingredient.name,
            grams: (current?.grams ?? 0) + numberValue(ingredient.grams),
          });
        }
      }
    }

    return Array.from(grouped.values()).sort((a, b) => a.name.localeCompare(b.name, "es"));
  }, [days]);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold">Plan nutricional</h2>
        <p className="mt-1 text-sm text-slate-500">
          Menú semanal calculado con un catálogo controlado. La IA propone las combinaciones y el
          servidor calcula los macros.
        </p>
      </div>

      <details className="rounded-2xl bg-white p-4 shadow-sm" open={!plan}>
        <summary className="cursor-pointer list-none font-semibold">
          ⚙️ Objetivos, intolerancias y preferencias
        </summary>

        <div className="mt-4 space-y-4">
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Objetivo</span>
            <input
              value={preferences.objective}
              onChange={(event) =>
                setPreferences((current) => ({ ...current, objective: event.target.value }))
              }
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
            />
          </label>

          <div className="grid grid-cols-3 gap-2">
            <label>
              <span className="text-xs font-medium text-slate-600">kcal/día</span>
              <input
                type="number"
                min={1200}
                max={4500}
                step={50}
                value={preferences.target_calories}
                onChange={(event) =>
                  setPreferences((current) => ({
                    ...current,
                    target_calories: Number(event.target.value),
                  }))
                }
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
              />
            </label>
            <label>
              <span className="text-xs font-medium text-slate-600">Proteína</span>
              <input
                type="number"
                min={60}
                max={300}
                step={5}
                value={preferences.target_protein}
                onChange={(event) =>
                  setPreferences((current) => ({
                    ...current,
                    target_protein: Number(event.target.value),
                  }))
                }
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
              />
            </label>
            <label>
              <span className="text-xs font-medium text-slate-600">Comidas</span>
              <select
                value={preferences.meals_per_day}
                onChange={(event) =>
                  setPreferences((current) => ({
                    ...current,
                    meals_per_day: Number(event.target.value),
                  }))
                }
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
              >
                <option value={3}>3</option>
                <option value={4}>4</option>
                <option value={5}>5</option>
              </select>
            </label>
          </div>

          <div>
            <p className="text-xs font-medium text-slate-600">Excluir por intolerancia</p>
            <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
              {[
                ["lactose_intolerance", "Lactosa"],
                ["fructose_intolerance", "Fructosa"],
                ["sorbitol_intolerance", "Sorbitol"],
              ].map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 rounded-xl bg-slate-50 p-3">
                  <input
                    type="checkbox"
                    checked={Boolean(preferences[key as keyof Preferences])}
                    onChange={(event) =>
                      setPreferences((current) => ({
                        ...current,
                        [key]: event.target.checked,
                      }))
                    }
                    className="h-4 w-4 accent-emerald-600"
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>

          <label className="block">
            <span className="text-xs font-medium text-slate-600">
              Alimentos que no quieres, separados por comas
            </span>
            <input
              value={avoidFoodsText}
              onChange={(event) => setAvoidFoodsText(event.target.value)}
              placeholder="Ej.: salmón, tofu, avena"
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-slate-600">Notas para el plan</span>
            <textarea
              value={preferences.notes}
              onChange={(event) =>
                setPreferences((current) => ({ ...current, notes: event.target.value }))
              }
              rows={3}
              placeholder="Horarios, alimentos preferidos, días con poco tiempo, comidas fuera…"
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
            />
          </label>

          <button
            onClick={() => savePreferences(true)}
            disabled={saving || generating}
            className="w-full rounded-xl border border-emerald-600 py-2.5 text-sm font-semibold text-emerald-700 disabled:opacity-50"
          >
            {saving ? "Guardando…" : "Guardar preferencias"}
          </button>
        </div>
      </details>

      <div className="space-y-3 rounded-2xl bg-white p-4 shadow-sm">
        <div>
          <p className="font-semibold">{plan ? "Ajustar la semana" : "Generar la semana"}</p>
          <p className="mt-1 text-xs text-slate-500">
            Puedes indicar circunstancias concretas antes de generar el menú.
          </p>
        </div>
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          rows={2}
          placeholder="Ej.: martes como fuera; quiero desayunos rápidos; esta semana entreno por la tarde."
          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
        />
        <button
          onClick={generatePlan}
          disabled={generating || saving}
          className="w-full rounded-xl bg-emerald-600 py-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          {generating
            ? "Calculando y preparando el menú…"
            : plan
              ? "Regenerar plan de la semana"
              : "Generar plan nutricional"}
        </button>
      </div>

      {error && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {success && <p className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-700">{success}</p>}

      {loading ? (
        <p className="py-10 text-center text-sm text-slate-400">Cargando plan…</p>
      ) : plan && days.length > 0 ? (
        <>
          <div className="rounded-2xl bg-emerald-600 p-4 text-white">
            <p className="text-xs font-semibold uppercase tracking-wide opacity-80">
              Estrategia semanal
            </p>
            <p className="mt-2 text-sm leading-relaxed">{plan.strategy}</p>
            <div className="mt-3 flex gap-2 text-xs">
              <span className="rounded-full bg-white/15 px-3 py-1">
                Objetivo {plan.target_calories} kcal
              </span>
              <span className="rounded-full bg-white/15 px-3 py-1">
                Proteína {plan.target_protein} g
              </span>
            </div>
          </div>

          <div className="flex gap-2 overflow-x-auto pb-1">
            {days.map((day) => {
              const selected = day.date === selectedDay?.date;
              const isToday = day.date === today;
              return (
                <button
                  key={day.id}
                  onClick={() => setSelectedDate(day.date)}
                  className={`min-w-20 rounded-xl px-3 py-2 text-xs font-semibold capitalize ${
                    selected
                      ? "bg-emerald-600 text-white"
                      : "bg-white text-slate-600 shadow-sm"
                  }`}
                >
                  {dayLabel(day.date)}
                  {isToday && <span className="block text-[10px] opacity-75">hoy</span>}
                </button>
              );
            })}
          </div>

          {selectedDay && (
            <div className="space-y-3">
              <div className="grid grid-cols-4 gap-2">
                <div className="rounded-xl bg-white p-3 text-center shadow-sm">
                  <p className="text-lg font-bold">{formatMacro(selectedDay.calories)}</p>
                  <p className="text-[10px] text-slate-500">kcal</p>
                </div>
                <div className="rounded-xl bg-white p-3 text-center shadow-sm">
                  <p className="text-lg font-bold">{formatMacro(selectedDay.protein)}</p>
                  <p className="text-[10px] text-slate-500">proteína</p>
                </div>
                <div className="rounded-xl bg-white p-3 text-center shadow-sm">
                  <p className="text-lg font-bold">{formatMacro(selectedDay.carbs)}</p>
                  <p className="text-[10px] text-slate-500">carbos</p>
                </div>
                <div className="rounded-xl bg-white p-3 text-center shadow-sm">
                  <p className="text-lg font-bold">{formatMacro(selectedDay.fats)}</p>
                  <p className="text-[10px] text-slate-500">grasas</p>
                </div>
              </div>

              {selectedDay.nutrition_plan_meals.map((meal) => (
                <article key={meal.id} className="rounded-2xl bg-white p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase text-emerald-700">
                        {MEAL_ICON[meal.meal_type]} {meal.meal_type}
                      </p>
                      <h3 className="mt-1 font-bold">{meal.title}</h3>
                    </div>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold">
                      {formatMacro(meal.calories)} kcal
                    </span>
                  </div>

                  <div className="mt-3 space-y-2">
                    {(meal.ingredients ?? []).map((ingredient) => (
                      <div
                        key={`${meal.id}-${ingredient.food_id}`}
                        className="flex items-center justify-between gap-3 text-sm"
                      >
                        <div>
                          <p className="font-medium">{ingredient.name}</p>
                          <p className="text-xs text-slate-400">{ingredient.visual_portion}</p>
                        </div>
                        <span className="whitespace-nowrap text-xs text-slate-500">
                          {Math.round(numberValue(ingredient.grams))} g
                        </span>
                      </div>
                    ))}
                  </div>

                  {meal.visual_portion && (
                    <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs text-amber-900">
                      👋 {meal.visual_portion}
                    </p>
                  )}

                  {meal.preparation && (
                    <p className="mt-3 text-xs leading-relaxed text-slate-600">
                      <strong>Preparación:</strong> {meal.preparation}
                    </p>
                  )}

                  {meal.notes && <p className="mt-2 text-xs text-slate-400">{meal.notes}</p>}

                  <p className="mt-3 text-xs text-slate-500">
                    P {formatMacro(meal.protein)} g · C {formatMacro(meal.carbs)} g · G{" "}
                    {formatMacro(meal.fats)} g
                  </p>
                </article>
              ))}
            </div>
          )}

          <details className="rounded-2xl bg-white p-4 shadow-sm">
            <summary className="cursor-pointer list-none font-semibold">
              🛒 Lista de compra de la semana
            </summary>
            {plan.shopping_tips && (
              <p className="mt-3 rounded-xl bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
                {plan.shopping_tips}
              </p>
            )}
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {shoppingList.map((item) => (
                <div
                  key={item.name}
                  className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2 text-sm"
                >
                  <span>{item.name}</span>
                  <strong>{shoppingAmount(item.grams)}</strong>
                </div>
              ))}
            </div>
          </details>
        </>
      ) : (
        <div className="rounded-2xl bg-white p-8 text-center shadow-sm">
          <p className="text-3xl">🥗</p>
          <p className="mt-2 font-semibold">Todavía no hay menú esta semana</p>
          <p className="mt-1 text-sm text-slate-500">
            Revisa tus objetivos y genera un plan de siete días.
          </p>
        </div>
      )}

      <p className="pb-4 text-center text-[11px] leading-relaxed text-slate-400">
        Valores nutricionales orientativos. Esta función no sustituye la valoración de un profesional
        sanitario, especialmente ante síntomas, enfermedad, embarazo o necesidades clínicas.
      </p>
    </div>
  );
}
