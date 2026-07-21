"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { DailyVoiceData } from "@/lib/schemas";

type Phase = "input" | "review" | "saved";

const NUM_FIELDS: { key: keyof DailyVoiceData; label: string; step?: string }[] = [
  { key: "weight_kg", label: "Peso (kg)", step: "0.1" },
  { key: "waist_cm", label: "Cintura (cm)", step: "0.1" },
  { key: "sleep_hours", label: "Sueño (h)", step: "0.5" },
  { key: "steps", label: "Pasos" },
  { key: "water_liters", label: "Agua (L)", step: "0.1" },
  { key: "energy_level", label: "Energía (0-10)" },
  { key: "hunger_level", label: "Hambre (0-10)" },
  { key: "bloating", label: "Hinchazón (0-10)" },
  { key: "pain", label: "Dolor (0-10)" },
  { key: "gas", label: "Gases (0-10)" },
  { key: "bristol_type", label: "Bristol (1-7)" },
  { key: "bowel_movements", label: "Deposiciones" },
];

const BOOL_FIELDS: { key: keyof DailyVoiceData; label: string }[] = [
  { key: "trained", label: "Entrenamiento" },
  { key: "urgency", label: "Urgencia" },
  { key: "incomplete_evacuation", label: "Evacuación incompleta" },
  { key: "mucus", label: "Moco" },
  { key: "visible_blood", label: "Sangre visible" },
];

export default function RegistroPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("input");
  const [recording, setRecording] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(true);
  const [text, setText] = useState("");
  const [data, setData] = useState<DailyVoiceData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) {
      setSpeechSupported(false);
      return;
    }
    const rec = new SR();
    rec.lang = "es-ES";
    rec.continuous = true;
    rec.interimResults = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => {
      let chunk = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) chunk += e.results[i][0].transcript + " ";
      }
      if (chunk) setText((prev) => (prev + " " + chunk).trim());
    };
    rec.onend = () => setRecording(false);
    recognitionRef.current = rec;
    return () => rec.stop();
  }, []);

  function toggleRecording() {
    if (!recognitionRef.current) return;
    if (recording) {
      recognitionRef.current.stop();
      setRecording(false);
    } else {
      setError(null);
      recognitionRef.current.start();
      setRecording(true);
    }
  }

  async function analyze() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al analizar");
      setData(json.data);
      setPhase("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado");
    } finally {
      setLoading(false);
    }
  }

  function updateField(key: keyof DailyVoiceData, value: string | boolean) {
    if (!data) return;
    if (typeof value === "boolean") {
      setData({ ...data, [key]: value });
    } else {
      setData({ ...data, [key]: value === "" ? null : Number(value) });
    }
  }

  async function save() {
    if (!data) return;
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Sesión caducada");

      const today = new Date().toISOString().slice(0, 10);

      const { data: dailyLog, error: dlError } = await supabase
        .from("daily_logs")
        .upsert(
          {
            user_id: user.id,
            date: today,
            weight_kg: data.weight_kg,
            waist_cm: data.waist_cm,
            sleep_hours: data.sleep_hours,
            steps: data.steps,
            water_liters: data.water_liters,
            energy_level: data.energy_level,
            hunger_level: data.hunger_level,
            general_status: data.notes || null,
            raw_voice_text: text,
          },
          { onConflict: "user_id,date" }
        )
        .select("id")
        .single();

      if (dlError) throw new Error(dlError.message);

      const hasDigestiveData =
        data.bloating !== null ||
        data.pain !== null ||
        data.gas !== null ||
        data.bristol_type !== null ||
        data.bowel_movements !== null ||
        data.urgency ||
        data.incomplete_evacuation ||
        data.mucus ||
        data.visible_blood;

      if (hasDigestiveData) {
        const { error: digError } = await supabase.from("digestive_logs").insert({
          user_id: user.id,
          daily_log_id: dailyLog.id,
          bloating: data.bloating,
          pain: data.pain,
          gas: data.gas,
          bristol_type: data.bristol_type,
          bowel_movements: data.bowel_movements,
          urgency: data.urgency,
          incomplete_evacuation: data.incomplete_evacuation,
          mucus: data.mucus,
          visible_blood: data.visible_blood,
        });
        if (digError) throw new Error(digError.message);
      }

      if (data.trained) {
        await supabase.from("workouts").insert({
          user_id: user.id,
          date: today,
          workout_type: data.training_type,
        });
      }

      setPhase("saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al guardar");
    } finally {
      setLoading(false);
    }
  }

  if (phase === "saved") {
    return (
      <div className="space-y-4 rounded-2xl bg-white p-8 text-center shadow-sm">
        <p className="text-4xl">✅</p>
        <p className="font-semibold">Registro guardado</p>
        {data?.visible_blood && (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
            Has registrado sangre visible. El dato queda guardado para
            seguimiento, pero si se repite o va acompañado de dolor intenso,
            consulta con un médico.
          </p>
        )}
        <button
          onClick={() => router.push("/dashboard")}
          className="rounded-lg bg-emerald-600 px-6 py-2 text-sm font-semibold text-white"
        >
          Ver dashboard
        </button>
      </div>
    );
  }

  if (phase === "review" && data) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-bold">Revisa los datos detectados</h2>
        <p className="text-sm text-slate-500">
          Corrige lo que haga falta antes de guardar.
        </p>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {NUM_FIELDS.map((f) => (
            <label key={f.key} className="block rounded-lg bg-white p-3 shadow-sm">
              <span className="text-xs text-slate-500">{f.label}</span>
              <input
                type="number"
                step={f.step ?? "1"}
                value={(data[f.key] as number | null) ?? ""}
                onChange={(e) => updateField(f.key, e.target.value)}
                className="mt-1 w-full rounded border border-slate-200 px-2 py-1 text-sm"
              />
            </label>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          {BOOL_FIELDS.map((f) => (
            <button
              key={f.key}
              onClick={() => updateField(f.key, !(data[f.key] as boolean))}
              className={`rounded-full px-3 py-1 text-sm ${
                data[f.key]
                  ? "bg-emerald-600 text-white"
                  : "bg-white text-slate-500 shadow-sm"
              }`}
            >
              {f.label}: {data[f.key] ? "Sí" : "No"}
            </button>
          ))}
        </div>

        {data.trained && (
          <label className="block rounded-lg bg-white p-3 shadow-sm">
            <span className="text-xs text-slate-500">Tipo de entrenamiento</span>
            <input
              type="text"
              value={data.training_type ?? ""}
              onChange={(e) =>
                setData({ ...data, training_type: e.target.value || null })
              }
              className="mt-1 w-full rounded border border-slate-200 px-2 py-1 text-sm"
            />
          </label>
        )}

        <label className="block rounded-lg bg-white p-3 shadow-sm">
          <span className="text-xs text-slate-500">Notas</span>
          <textarea
            value={data.notes}
            onChange={(e) => setData({ ...data, notes: e.target.value })}
            rows={2}
            className="mt-1 w-full rounded border border-slate-200 px-2 py-1 text-sm"
          />
        </label>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-3">
          <button
            onClick={() => setPhase("input")}
            className="flex-1 rounded-lg bg-white py-2 text-sm font-semibold text-slate-600 shadow-sm"
          >
            Volver
          </button>
          <button
            onClick={save}
            disabled={loading}
            className="flex-1 rounded-lg bg-emerald-600 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {loading ? "Guardando…" : "Confirmar y guardar"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">Registro diario</h2>
      <p className="text-sm text-slate-500">
        Pulsa el micrófono y cuenta cómo ha ido el día: peso, sueño, pasos,
        entrenamiento y síntomas digestivos.
      </p>

      <div className="flex justify-center py-4">
        <button
          onClick={toggleRecording}
          disabled={!speechSupported}
          className={`flex h-28 w-28 items-center justify-center rounded-full text-5xl shadow-lg transition ${
            recording
              ? "animate-pulse bg-red-500"
              : "bg-emerald-600 hover:bg-emerald-700"
          } disabled:opacity-40`}
        >
          🎙️
        </button>
      </div>
      <p className="text-center text-sm text-slate-500">
        {recording
          ? "Escuchando… pulsa de nuevo para parar."
          : speechSupported
            ? "Pulsa para hablar"
            : "Tu navegador no soporta dictado por voz. Escribe el texto abajo."}
      </p>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder="Ejemplo: Hoy peso 82,4 kilos, he dormido 7 horas, he hecho 8.500 pasos, he entrenado espalda y he tenido hinchazón 3 y gases 2."
        className="w-full rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-sm focus:border-emerald-500 focus:outline-none"
      />

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        onClick={analyze}
        disabled={loading || text.trim().length < 3}
        className="w-full rounded-lg bg-emerald-600 py-3 text-sm font-semibold text-white disabled:opacity-50"
      >
        {loading ? "Analizando con IA…" : "Analizar"}
      </button>
    </div>
  );
}
