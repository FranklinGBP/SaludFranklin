import { createClient } from "@/lib/supabase/server";

export default async function HistorialPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: logs } = await supabase
    .from("daily_logs")
    .select(
      "id, date, weight_kg, waist_cm, sleep_hours, steps, general_status, digestive_logs(bloating, pain, gas, visible_blood)"
    )
    .eq("user_id", user!.id)
    .order("date", { ascending: false })
    .limit(60);

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-bold">Historial</h2>

      {(logs ?? []).length === 0 && (
        <p className="py-8 text-center text-sm text-slate-400">
          Aún no hay registros.
        </p>
      )}

      {(logs ?? []).map((log) => {
        const dig = Array.isArray(log.digestive_logs)
          ? log.digestive_logs[0]
          : log.digestive_logs;
        return (
          <div key={log.id} className="rounded-xl bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <p className="font-semibold">
                {new Date(log.date + "T00:00:00").toLocaleDateString("es-ES", {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                })}
              </p>
              {dig?.visible_blood && (
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">
                  Sangre visible
                </span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600">
              {log.weight_kg != null && <span>⚖️ {log.weight_kg} kg</span>}
              {log.waist_cm != null && <span>📏 {log.waist_cm} cm</span>}
              {log.sleep_hours != null && <span>😴 {log.sleep_hours} h</span>}
              {log.steps != null && (
                <span>👟 {log.steps.toLocaleString("es-ES")}</span>
              )}
              {dig?.bloating != null && <span>🎈 Hinchazón {dig.bloating}</span>}
              {dig?.gas != null && <span>💨 Gases {dig.gas}</span>}
              {dig?.pain != null && <span>⚡ Dolor {dig.pain}</span>}
            </div>
            {log.general_status && (
              <p className="mt-2 text-xs text-slate-400">{log.general_status}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
