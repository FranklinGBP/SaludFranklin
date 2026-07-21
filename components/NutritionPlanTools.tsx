"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
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

function numberValue(value: number | string | null | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rounded(value: number | string | null | undefined): number {
  return Math.round(numberValue(value));
}

function dateHeading(date: string): string {
  const formatted = new Date(`${date}T00:00:00`).toLocaleDateString("es-ES", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

function shoppingAmount(grams: number): string {
  if (grams >= 1000) return `${(grams / 1000).toFixed(1)} kg`;
  return `${Math.round(grams / 10) * 10} g`;
}

function markdownEscape(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

function buildMarkdown(plan: NutritionPlan): string {
  const days = (plan.nutrition_plan_days ?? [])
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((day) => ({
      ...day,
      nutrition_plan_meals: (day.nutrition_plan_meals ?? [])
        .slice()
        .sort((a, b) => a.order_index - b.order_index),
    }));

  const shopping = new Map<string, { name: string; grams: number }>();
  for (const day of days) {
    for (const meal of day.nutrition_plan_meals) {
      for (const ingredient of meal.ingredients ?? []) {
        const current = shopping.get(ingredient.food_id);
        shopping.set(ingredient.food_id, {
          name: ingredient.name,
          grams: (current?.grams ?? 0) + numberValue(ingredient.grams),
        });
      }
    }
  }

  const lines: string[] = [
    "# Plan nutricional semanal",
    "",
    `**Semana de:** ${dateHeading(plan.week_start)}`,
    `**Objetivo diario:** ${plan.target_calories} kcal · ${plan.target_protein} g de proteína`,
  ];

  if (plan.strategy) {
    lines.push("", "## Estrategia semanal", "", markdownEscape(plan.strategy));
  }

  for (const day of days) {
    lines.push(
      "",
      `## ${dateHeading(day.date)}`,
      "",
      `**Totales:** ${rounded(day.calories)} kcal · P ${rounded(day.protein)} g · C ${rounded(day.carbs)} g · G ${rounded(day.fats)} g`
    );

    for (const meal of day.nutrition_plan_meals) {
      lines.push(
        "",
        `### ${meal.meal_type.charAt(0).toUpperCase() + meal.meal_type.slice(1)} — ${markdownEscape(meal.title)}`,
        ""
      );

      for (const ingredient of meal.ingredients ?? []) {
        const visual = ingredient.visual_portion
          ? ` — ${markdownEscape(ingredient.visual_portion)}`
          : "";
        lines.push(`- ${markdownEscape(ingredient.name)}: ${rounded(ingredient.grams)} g${visual}`);
      }

      lines.push(
        "",
        `**Macros:** ${rounded(meal.calories)} kcal · P ${rounded(meal.protein)} g · C ${rounded(meal.carbs)} g · G ${rounded(meal.fats)} g`
      );
      if (meal.visual_portion) lines.push(`**Ración visual:** ${markdownEscape(meal.visual_portion)}`);
      if (meal.preparation) lines.push(`**Preparación:** ${markdownEscape(meal.preparation)}`);
      if (meal.notes) lines.push(`> ${markdownEscape(meal.notes)}`);
    }
  }

  lines.push("", "## Lista de la compra", "");
  if (plan.shopping_tips) lines.push(markdownEscape(plan.shopping_tips), "");

  for (const item of Array.from(shopping.values()).sort((a, b) =>
    a.name.localeCompare(b.name, "es")
  )) {
    lines.push(`- [ ] ${markdownEscape(item.name)} — ${shoppingAmount(item.grams)}`);
  }

  lines.push(
    "",
    "---",
    "",
    "Valores nutricionales orientativos. El plan debe adaptarse a tolerancia, síntomas y recomendaciones profesionales."
  );

  return lines.join("\n");
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("No se pudo copiar el texto");
}

export default function NutritionPlanTools() {
  const pathname = usePathname();
  const [plan, setPlan] = useState<NutritionPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [copying, setCopying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isNutritionPage = pathname === "/nutricion";

  const loadPlan = useCallback(async () => {
    if (!isNutritionPage) return;
    setLoading(true);
    setError(null);

    const supabase = createClient();
    const { data, error: queryError } = await supabase
      .from("nutrition_plans")
      .select(
        "id, week_start, strategy, shopping_tips, target_calories, target_protein, nutrition_plan_days(id, date, calories, protein, carbs, fats, nutrition_plan_meals(id, meal_type, order_index, title, ingredients, calories, protein, carbs, fats, preparation, visual_portion, notes))"
      )
      .eq("week_start", mondayOfToday())
      .maybeSingle();

    if (queryError) {
      setError(queryError.message);
      setPlan(null);
    } else {
      setPlan((data as NutritionPlan | null) ?? null);
    }
    setLoading(false);
  }, [isNutritionPage]);

  useEffect(() => {
    void loadPlan();
  }, [loadPlan]);

  const markdown = useMemo(() => (plan ? buildMarkdown(plan) : ""), [plan]);

  async function handleCopy() {
    if (!plan || !markdown) return;
    setCopying(true);
    setError(null);
    setMessage(null);
    try {
      await copyText(markdown);
      setMessage("Plan semanal y lista de la compra copiados en Markdown.");
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "No se pudo copiar el plan.");
    } finally {
      setCopying(false);
    }
  }

  async function handleEdit() {
    const trimmed = instruction.trim();
    if (!plan || trimmed.length < 3) {
      setError("Escribe una instrucción concreta para modificar el plan.");
      return;
    }

    setEditing(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch("/api/nutrition-plan/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: trimmed }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "No se pudo modificar el plan.");

      setInstruction("");
      setMessage(
        json.data?.summary || `Plan actualizado: ${json.data?.changedMeals ?? 0} comidas modificadas.`
      );
      await loadPlan();
      window.setTimeout(() => window.location.reload(), 800);
    } catch (editError) {
      setError(editError instanceof Error ? editError.message : "No se pudo modificar el plan.");
    } finally {
      setEditing(false);
    }
  }

  if (!isNutritionPage) return null;

  return (
    <section className="mb-5 space-y-3 rounded-2xl border border-emerald-100 bg-white p-4 shadow-sm">
      <div>
        <h2 className="font-bold">Herramientas del plan</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          Copia toda la semana en Markdown o pide al asistente que cambie solo las comidas necesarias.
        </p>
      </div>

      <button
        type="button"
        onClick={handleCopy}
        disabled={!plan || loading || copying || editing}
        className="w-full rounded-xl border border-emerald-600 py-3 text-sm font-semibold text-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {copying ? "Copiando…" : "📋 Copiar plan + compra en Markdown"}
      </button>

      <details className="rounded-xl bg-slate-50 p-3">
        <summary className="cursor-pointer list-none text-sm font-semibold">
          ✨ Editar el plan con el asistente
        </summary>
        <div className="mt-3 space-y-3">
          <p className="text-xs leading-relaxed text-slate-500">
            Mantendrá los días y el número de comidas. Ejemplos: “cambia todas las cenas con salmón”,
            “haz el martes más rápido” o “sube la proteína de los desayunos”.
          </p>
          <textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            rows={3}
            maxLength={1500}
            placeholder="Escribe qué quieres cambiar del plan actual…"
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={handleEdit}
            disabled={!plan || editing || copying || instruction.trim().length < 3}
            className="w-full rounded-xl bg-emerald-600 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {editing ? "Aplicando cambios…" : "Aplicar cambios al plan"}
          </button>
        </div>
      </details>

      {!plan && !loading && (
        <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-800">
          Genera primero el plan semanal para poder copiarlo o editarlo.
        </p>
      )}
      {loading && <p className="text-xs text-slate-400">Cargando herramientas…</p>}
      {message && <p className="rounded-xl bg-emerald-50 p-3 text-xs text-emerald-700">{message}</p>}
      {error && <p className="rounded-xl bg-red-50 p-3 text-xs text-red-700">{error}</p>}
    </section>
  );
}
