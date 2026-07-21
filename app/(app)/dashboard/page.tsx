import { createClient } from "@/lib/supabase/server";
import WeightChart from "@/components/WeightChart";

type DailyLog = {
  date: string;
  weight_kg: number | null;
  waist_cm: number | null;
  sleep_hours: number | null;
  steps: number | null;
};

type DigestiveLog = {
  bloating: number | null;
  pain: number | null;
  gas: number | null;
  created_at: string;
};

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function fmt(n: number | null | undefined, decimals = 1, suffix = "") {
  if (n === null || n === undefined) return "—";
  return n.toFixed(decimals) + suffix;
}

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: logs } = await supabase
    .from("daily_logs")
    .select("date, weight_kg, waist_cm, sleep_hours, steps")
    .eq("user_id", user!.id)
    .order("date", { ascending: false })
    .limit(30);

  const fourteenDaysAgo = new Date(Date.now() - 14 * 86400000).toISOString();
  const { data: digestive } = await supabase
    .from("digestive_logs")
    .select("bloating, pain, gas, created_at")
    .eq("user_id", user!.id)
    .gte("created_at", fourteenDaysAgo)
    .order("created_at", { ascending: false });

  const daily = (logs ?? []) as DailyLog[];
  const dig = (digestive ?? []) as DigestiveLog[];

  const last7 = daily.slice(0, 7);
  const prev7 = daily.slice(7, 14);

  const currentWeight = daily.find((d) => d.weight_kg !== null)?.weight_kg ?? null;
  const avg7 = avg(last7.map((d) => d.weight_kg).filter((v): v is number => v !== null));
  const avgPrev7 = avg(prev7.map((d) => d.weight_kg).filter((v): v is number => v !== null));
  const weeklyChange =
    avg7 !== null && avgPrev7 !== null ? ((avg7 - avgPrev7) / avgPrev7) * 100 : null;

  const currentWaist = daily.find((d) => d.waist_cm !== null)?.waist_cm ?? null;
  const avgSteps = avg(last7.map((d) => d.steps).filter((v): v is number => v !== null));
  const avgSleep = avg(last7.map((d) => d.sleep_hours).filter((v): v is number => v !== null));

  const digScores = dig
    .map((d) => avg([d.bloating, d.pain, d.gas].filter((v): v is number => v !== null)))
    .filter((v): v is number => v !== null);
  const digAvg = avg(digScores);
  const digestiveState =
    digAvg === null ? "—" : digAvg <= 2 ? "Bien" : digAvg <= 5 ? "Regular" : "Molesto";

  let recommendation = "Registra tus datos diarios para recibir recomendaciones.";
  if (weeklyChange !== null) {
    if (weeklyChange <= -0.3 && weeklyChange >= -0.8) {
      recommendation = "Ritmo de pérdida adecuado. Mantener el plan actual.";
    } else if (weeklyChange > -0.25 && weeklyChange < 0.25) {
      recommendation =
        "Pérdida lenta. Revisar adherencia y valorar aumentar pasos o reducir ligeramente calorías.";
    } else if (weeklyChange < -1) {
      recommendation =
        "Pérdida rápida. Revisar fatiga, hambre y rendimiento; valorar aumentar calorías.";
    } else if (weeklyChange >= 0.25) {
      recommendation = "El peso medio ha subido. Revisar adherencia esta semana.";
    } else {
      recommendation = "Evolución dentro de lo esperado.";
    }
  }

  const chartData = [...daily]
    .reverse()
    .filter((d) => d.weight_kg !== null)
    .map((d) => ({ date: d.date.slice(5), weight: d.weight_kg as number }));

  const cards = [
    { label: "Peso actual", value: fmt(currentWeight, 1, " kg") },
    { label: "Media 7 días", value: fmt(avg7, 1, " kg") },
    {
      label: "Cambio semanal",
      value: weeklyChange === null ? "—" : `${weeklyChange > 0 ? "+" : ""}${weeklyChange.toFixed(2)} %`,
    },
    { label: "Cintura", value: fmt(currentWaist, 1, " cm") },
    { label: "Pasos medios", value: avgSteps === null ? "—" : Math.round(avgSteps).toLocaleString("es-ES") },
    { label: "Sueño medio", value: fmt(avgSleep, 1, " h") },
    { label: "Estado digestivo", value: digestiveState },
    { label: "Registros (30 d)", value: String(daily.length) },
  ];

  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-emerald-600 p-4 text-white">
        <p className="text-xs font-semibold uppercase tracking-wide opacity-80">
          Recomendación
        </p>
        <p className="mt-1 text-sm">{recommendation}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl bg-white p-4 shadow-sm">
            <p className="text-xs text-slate-500">{c.label}</p>
            <p className="mt-1 text-lg font-bold">{c.value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl bg-white p-4 shadow-sm">
        <p className="mb-2 text-sm font-semibold">Evolución del peso (30 días)</p>
        {chartData.length >= 2 ? (
          <WeightChart data={chartData} />
        ) : (
          <p className="py-8 text-center text-sm text-slate-400">
            Aún no hay suficientes datos. Registra tu peso unos días para ver la gráfica.
          </p>
        )}
      </div>
    </div>
  );
}
