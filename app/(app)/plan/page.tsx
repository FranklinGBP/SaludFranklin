"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type PlannedExercise = {
  id: string;
  order_index: number;
  exercise_id: string | null;
  exercise_name: string;
  sets: number | null;
  reps: string | null;
  rest_seconds: number | null;
  notes: string | null;
};

type PlannedDay = {
  id: string;
  date: string;
  location: string | null;
  focus: string | null;
  status: string;
  planned_exercises: PlannedExercise[];
};

type Plan = {
  id: string;
  week_start: string;
  strategy: string | null;
  planned_workouts: PlannedDay[];
};

type ExerciseImages = Record<string, string>;

const IMAGE_BASE = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/";

const LOCATION_UI: Record<string, { icon: string; label: string }> = {
  casa: { icon: "🏠", label: "Casa" },
  gimnasio: { icon: "🏋️", label: "Gimnasio" },
  descanso: { icon: "😴", label: "Descanso" },
};

function isoDate(d: Date): string {
  const tz = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return tz.toISOString().slice(0, 10);
}

function mondayOfToday(): string {
  const d = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return isoDate(d);
}

function dayLabel(date: string): string {
  return new Date(date + "T00:00:00").toLocaleDateString("es-ES", {
    weekday: "long",
    day: "numeric",
    month: "short",
  });
}

export default function PlanPage() {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [images, setImages] = useState<ExerciseImages>({});
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savingDay, setSavingDay] = useState<string | null>(null);

  const weekStart = mondayOfToday();
  const today = isoDate(new Date());

  const loadPlan = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("workout_plans")
      .select(
        "id, week_start, strategy, planned_workouts(id, date, location, focus, status, planned_exercises(id, order_index, exercise_id, exercise_name, sets, reps, rest_seconds, notes))"
      )
      .eq("week_start", weekStart)
      .maybeSingle();
    setPlan((data as Plan | null) ?? null);
    setLoading(false);
  }, [weekStart]);

  useEffect(() => {
    loadPlan();
    // Miniaturas: primer frame de cada ejercicio de la biblioteca local.
    fetch("/data/exercises.json")
      .then((res) => (res.ok ? res.json() : []))
      .then((data: { id: string; images: string[] }[]) => {
        const map: ExerciseImages = {};
        for (const ex of data) if (ex.images[0]) map[ex.id] = ex.images[0];
        setImages(map);
      })
      .catch(() => {});
  }, [loadPlan]);

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/workout-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al generar el plan");
      setMessage("");
      await loadPlan();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado");
    } finally {
      setGenerating(false);
    }
  }

  async function setDayStatus(day: PlannedDay, status: "hecho" | "saltado" | "pendiente") {
    setSavingDay(day.id);
    setError(null);
    try {
      const supabase = createClient();
      const { error: updError } = await supabase
        .from("planned_workouts")
        .update({ status })
        .eq("id", day.id);
      if (updError) throw new Error(updError.message);

      // Al marcar hecho, se registra el entreno para el historial y la revisión semanal.
      if (status === "hecho" && day.location !== "descanso") {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user) {
          await supabase.from("workouts").insert({
            user_id: user.id,
            date: day.date,
            workout_type: day.focus,
          });
        }
      }
      await loadPlan();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al actualizar");
    } finally {
      setSavingDay(null);
    }
  }

  const days = (plan?.planned_workouts ?? []).slice().sort((a, b) => a.date.localeCompare(b.date));

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">Plan semanal de entrenamiento</h2>

      {loading ? (
        <p className="py-8 text-center text-sm text-slate-400">Cargando…</p>
      ) : (
        <>
          {plan?.strategy && (
            <div className="rounded-2xl bg-emerald-600 p-4 text-white">
              <p className="text-xs font-semibold uppercase tracking-wide opacity-80">
                Estrategia de la semana
              </p>
              <p className="mt-1 text-sm">{plan.strategy}</p>
            </div>
          )}

          <div className="space-y-2 rounded-xl bg-white p-3 shadow-sm">
            <p className="text-xs text-slate-500">
              {plan
                ? "¿Ha cambiado algo? Cuéntaselo a la IA y replanificará los días restantes (los días hechos no se tocan)."
                : "Cuéntale a la IA tus circunstancias (días disponibles, material, molestias…) o genera el plan directamente."}
            </p>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
              placeholder={
                plan
                  ? "Ej.: hoy no he podido entrenar, muévelo. / Me duele el hombro. / Esta semana solo casa."
                  : "Ej.: puedo entrenar lunes, miércoles y viernes; martes y jueves en el gimnasio."
              }
              className="w-full rounded-lg border border-slate-200 p-2 text-sm focus:border-emerald-500 focus:outline-none"
            />
            <button
              onClick={generate}
              disabled={generating}
              className="w-full rounded-lg bg-emerald-600 py-3 text-sm font-semibold text-white disabled:opacity-50"
            >
              {generating
                ? "La IA está diseñando tu semana…"
                : plan
                  ? "Replanificar semana"
                  : "Generar plan de la semana"}
            </button>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          {days.map((day) => {
            const ui = LOCATION_UI[day.location ?? ""] ?? { icon: "❔", label: day.location ?? "" };
            const isToday = day.date === today;
            const exercises = day.planned_exercises
              .slice()
              .sort((a, b) => a.order_index - b.order_index);

            return (
              <div
                key={day.id}
                className={`rounded-2xl bg-white p-4 shadow-sm ${
                  isToday ? "ring-2 ring-emerald-500" : ""
                } ${day.status === "saltado" ? "opacity-60" : ""}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-bold capitalize">
                      {dayLabel(day.date)} {isToday && <span className="text-emerald-600">· hoy</span>}
                    </p>
                    <p className="text-xs text-slate-500">
                      {ui.icon} {ui.label}
                      {day.focus ? ` — ${day.focus}` : ""}
                    </p>
                  </div>
                  {day.status === "hecho" ? (
                    <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
                      ✅ Hecho
                    </span>
                  ) : day.status === "saltado" ? (
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-500">
                      Saltado
                    </span>
                  ) : null}
                </div>

                {exercises.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {exercises.map((ex) => (
                      <div key={ex.id} className="flex items-center gap-3 rounded-lg bg-slate-50 p-2">
                        {ex.exercise_id && images[ex.exercise_id] && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={IMAGE_BASE + images[ex.exercise_id]}
                            alt={ex.exercise_name}
                            loading="lazy"
                            className="h-12 w-16 rounded bg-white object-contain"
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{ex.exercise_name}</p>
                          <p className="text-xs text-slate-500">
                            {ex.sets ? `${ex.sets} × ` : ""}
                            {ex.reps ?? ""}
                            {ex.rest_seconds ? ` · descanso ${ex.rest_seconds}s` : ""}
                          </p>
                          {ex.notes && <p className="text-xs text-slate-400">{ex.notes}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {day.status === "pendiente" && day.location !== "descanso" && (
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => setDayStatus(day, "hecho")}
                      disabled={savingDay === day.id}
                      className="flex-1 rounded-lg bg-emerald-600 py-2 text-xs font-semibold text-white disabled:opacity-50"
                    >
                      ✅ Lo he hecho
                    </button>
                    <button
                      onClick={() => setDayStatus(day, "saltado")}
                      disabled={savingDay === day.id}
                      className="flex-1 rounded-lg bg-white py-2 text-xs font-semibold text-slate-500 shadow-sm disabled:opacity-50"
                    >
                      Saltar
                    </button>
                  </div>
                )}
                {day.status !== "pendiente" && (
                  <button
                    onClick={() => setDayStatus(day, "pendiente")}
                    disabled={savingDay === day.id}
                    className="mt-2 text-xs text-slate-400 underline"
                  >
                    Deshacer
                  </button>
                )}
              </div>
            );
          })}

          {!plan && !loading && (
            <p className="py-4 text-center text-sm text-slate-400">
              Aún no hay plan para esta semana. Genera uno y la IA elegirá ejercicios de la
              biblioteca con series y repeticiones.
            </p>
          )}
        </>
      )}
    </div>
  );
}
