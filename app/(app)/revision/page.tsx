"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type WeeklyReview = {
  id: string;
  week_start: string;
  average_weight: number | null;
  weight_change_percentage: number | null;
  average_steps: number | null;
  average_protein: number | null;
  average_sleep: number | null;
  training_sessions: number | null;
  digestive_score: number | null;
  adherence_score: number | null;
  ai_summary: string | null;
  recommended_adjustment: string | null;
  created_at: string;
};

function fmt(n: number | null, decimals = 1, suffix = "") {
  if (n === null) return "—";
  return n.toFixed(decimals) + suffix;
}

function weekLabel(weekStart: string): string {
  const start = new Date(weekStart + "T00:00:00");
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  return `${start.toLocaleDateString("es-ES", opts)} – ${end.toLocaleDateString("es-ES", opts)}`;
}

export default function RevisionPage() {
  const [reviews, setReviews] = useState<WeeklyReview[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadReviews = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("weekly_reviews")
      .select("*")
      .order("week_start", { ascending: false })
      .limit(12);
    setReviews((data as WeeklyReview[]) ?? []);
    setLoadingList(false);
  }, []);

  useEffect(() => {
    loadReviews();
  }, [loadReviews]);

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/weekly-review", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al generar la revisión");
      await loadReviews();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">Revisión semanal con IA</h2>
      <p className="text-sm text-slate-500">
        La IA analiza tus registros de la semana (peso, pasos, sueño, comidas y síntomas
        digestivos) y te propone un ajuste. Puedes regenerarla cuando añadas más datos.
      </p>

      <button
        onClick={generate}
        disabled={generating}
        className="w-full rounded-lg bg-emerald-600 py-3 text-sm font-semibold text-white disabled:opacity-50"
      >
        {generating ? "Analizando la semana…" : "Generar revisión de esta semana"}
      </button>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {loadingList ? (
        <p className="py-8 text-center text-sm text-slate-400">Cargando…</p>
      ) : reviews.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-400">
          Aún no hay revisiones. Genera la primera cuando tengas algunos días registrados.
        </p>
      ) : (
        reviews.map((r) => (
          <div key={r.id} className="space-y-3 rounded-2xl bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <p className="font-semibold">Semana {weekLabel(r.week_start)}</p>
              {r.adherence_score !== null && (
                <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                  Adherencia {fmt(r.adherence_score, 1)}/10
                </span>
              )}
            </div>

            <div className="grid grid-cols-3 gap-2 text-center sm:grid-cols-6">
              {[
                ["Peso medio", fmt(r.average_weight, 1, " kg")],
                [
                  "Cambio",
                  r.weight_change_percentage === null
                    ? "—"
                    : `${r.weight_change_percentage > 0 ? "+" : ""}${r.weight_change_percentage.toFixed(2)} %`,
                ],
                [
                  "Pasos",
                  r.average_steps === null ? "—" : Math.round(r.average_steps).toLocaleString("es-ES"),
                ],
                ["Sueño", fmt(r.average_sleep, 1, " h")],
                ["Entrenos", r.training_sessions === null ? "—" : String(r.training_sessions)],
                ["Digestivo", fmt(r.digestive_score, 1, "/10")],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg bg-slate-50 p-2">
                  <p className="text-[10px] text-slate-500">{label}</p>
                  <p className="text-sm font-bold">{value}</p>
                </div>
              ))}
            </div>

            {r.ai_summary && <p className="text-sm text-slate-700">{r.ai_summary}</p>}

            {r.recommended_adjustment && (
              <div className="rounded-lg bg-emerald-50 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                  Ajuste recomendado
                </p>
                <p className="mt-1 text-sm text-emerald-900">{r.recommended_adjustment}</p>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
