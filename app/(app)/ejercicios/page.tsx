"use client";

import { useEffect, useMemo, useState } from "react";

type Exercise = {
  id: string;
  name: string;
  force: string | null;
  level: string;
  mechanic: string | null;
  equipment: string | null;
  primaryMuscles: string[];
  secondaryMuscles: string[];
  instructions: string[];
  category: string;
  images: string[];
};

const IMAGE_BASE = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/";
const PAGE_SIZE = 24;

const MUSCLES_ES: Record<string, string> = {
  abdominals: "Abdominales",
  abductors: "Abductores",
  adductors: "Aductores",
  biceps: "Bíceps",
  calves: "Gemelos",
  chest: "Pecho",
  forearms: "Antebrazos",
  glutes: "Glúteos",
  hamstrings: "Isquios",
  lats: "Dorsales",
  "lower back": "Lumbar",
  "middle back": "Espalda media",
  neck: "Cuello",
  quadriceps: "Cuádriceps",
  shoulders: "Hombros",
  traps: "Trapecios",
  triceps: "Tríceps",
};

const EQUIPMENT_ES: Record<string, string> = {
  bands: "Bandas",
  barbell: "Barra",
  "body only": "Peso corporal",
  cable: "Polea",
  dumbbell: "Mancuernas",
  "exercise ball": "Fitball",
  "e-z curl bar": "Barra EZ",
  "foam roll": "Foam roller",
  kettlebells: "Kettlebell",
  machine: "Máquina",
  "medicine ball": "Balón medicinal",
  other: "Otro",
};

const LEVEL_ES: Record<string, string> = {
  beginner: "Principiante",
  intermediate: "Intermedio",
  expert: "Avanzado",
};

const CATEGORY_ES: Record<string, string> = {
  strength: "Fuerza",
  stretching: "Estiramiento",
  plyometrics: "Pliometría",
  strongman: "Strongman",
  powerlifting: "Powerlifting",
  cardio: "Cardio",
  "olympic weightlifting": "Halterofilia",
};

const LEVEL_COLORS: Record<string, string> = {
  beginner: "bg-emerald-100 text-emerald-700",
  intermediate: "bg-amber-100 text-amber-700",
  expert: "bg-red-100 text-red-700",
};

/** Alterna las 2 imágenes del ejercicio para simular el movimiento. */
function AnimatedImages({ exercise }: { exercise: Exercise }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (exercise.images.length < 2) return;
    const interval = setInterval(() => setFrame((f) => (f + 1) % exercise.images.length), 1200);
    return () => clearInterval(interval);
  }, [exercise]);

  if (exercise.images.length === 0) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={IMAGE_BASE + exercise.images[frame]}
      alt={exercise.name}
      className="w-full rounded-xl bg-white object-contain shadow-sm"
    />
  );
}

export default function EjerciciosPage() {
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [muscle, setMuscle] = useState("");
  const [equipment, setEquipment] = useState("");
  const [level, setLevel] = useState("");
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<Exercise | null>(null);

  useEffect(() => {
    fetch("/data/exercises.json")
      .then((res) => {
        if (!res.ok) throw new Error("No se pudo cargar la base de ejercicios");
        return res.json();
      })
      .then((data: Exercise[]) => setExercises(data))
      .catch((e) => setError(e instanceof Error ? e.message : "Error inesperado"))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return exercises.filter((ex) => {
      if (muscle && !ex.primaryMuscles.includes(muscle) && !ex.secondaryMuscles.includes(muscle))
        return false;
      if (equipment && ex.equipment !== equipment) return false;
      if (level && ex.level !== level) return false;
      if (q && !ex.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [exercises, search, muscle, equipment, level]);

  useEffect(() => {
    setVisible(PAGE_SIZE);
  }, [search, muscle, equipment, level]);

  if (selected) {
    return (
      <div className="space-y-4">
        <button
          onClick={() => setSelected(null)}
          className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-600 shadow-sm"
        >
          ← Volver a la lista
        </button>

        <h2 className="text-lg font-bold">{selected.name}</h2>

        <div className="flex flex-wrap gap-2 text-xs">
          <span className={`rounded-full px-3 py-1 font-semibold ${LEVEL_COLORS[selected.level] ?? "bg-slate-100 text-slate-600"}`}>
            {LEVEL_ES[selected.level] ?? selected.level}
          </span>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">
            {CATEGORY_ES[selected.category] ?? selected.category}
          </span>
          {selected.equipment && (
            <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">
              {EQUIPMENT_ES[selected.equipment] ?? selected.equipment}
            </span>
          )}
          {selected.mechanic && (
            <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">
              {selected.mechanic === "compound" ? "Compuesto" : "Aislamiento"}
            </span>
          )}
        </div>

        <AnimatedImages exercise={selected} />

        <div className="rounded-xl bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Músculos</p>
          <div className="mt-2 flex flex-wrap gap-1">
            {selected.primaryMuscles.map((m) => (
              <span key={m} className="rounded-full bg-emerald-600 px-2 py-0.5 text-xs text-white">
                {MUSCLES_ES[m] ?? m}
              </span>
            ))}
            {selected.secondaryMuscles.map((m) => (
              <span key={m} className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">
                {MUSCLES_ES[m] ?? m}
              </span>
            ))}
          </div>
        </div>

        {selected.instructions.length > 0 && (
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Instrucciones (en inglés)
            </p>
            <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm text-slate-700">
              {selected.instructions.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">Biblioteca de ejercicios</h2>
      <p className="text-sm text-slate-500">
        {exercises.length > 0
          ? `${exercises.length} ejercicios con imágenes y técnica. Filtra por músculo, material o nivel.`
          : "Base de datos abierta de ejercicios con imágenes."}
      </p>

      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Buscar ejercicio (en inglés): squat, curl, press…"
        className="w-full rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-sm focus:border-emerald-500 focus:outline-none"
      />

      <div className="grid grid-cols-3 gap-2">
        <select
          value={muscle}
          onChange={(e) => setMuscle(e.target.value)}
          className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-sm shadow-sm"
        >
          <option value="">Músculo</option>
          {Object.entries(MUSCLES_ES).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select
          value={equipment}
          onChange={(e) => setEquipment(e.target.value)}
          className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-sm shadow-sm"
        >
          <option value="">Material</option>
          {Object.entries(EQUIPMENT_ES).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-sm shadow-sm"
        >
          <option value="">Nivel</option>
          {Object.entries(LEVEL_ES).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>

      {loading && <p className="py-8 text-center text-sm text-slate-400">Cargando ejercicios…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {!loading && !error && (
        <>
          <p className="text-xs text-slate-400">{filtered.length} resultados</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {filtered.slice(0, visible).map((ex) => (
              <button
                key={ex.id}
                onClick={() => setSelected(ex)}
                className="overflow-hidden rounded-xl bg-white text-left shadow-sm transition hover:shadow-md"
              >
                {ex.images.length > 0 && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={IMAGE_BASE + ex.images[0]}
                    alt={ex.name}
                    loading="lazy"
                    className="aspect-[4/3] w-full bg-white object-contain"
                  />
                )}
                <div className="space-y-1 p-2">
                  <p className="line-clamp-2 text-xs font-semibold">{ex.name}</p>
                  <div className="flex flex-wrap gap-1">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] ${LEVEL_COLORS[ex.level] ?? "bg-slate-100 text-slate-600"}`}>
                      {LEVEL_ES[ex.level] ?? ex.level}
                    </span>
                    {ex.primaryMuscles[0] && (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
                        {MUSCLES_ES[ex.primaryMuscles[0]] ?? ex.primaryMuscles[0]}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>

          {visible < filtered.length && (
            <button
              onClick={() => setVisible((v) => v + PAGE_SIZE)}
              className="w-full rounded-lg bg-white py-3 text-sm font-semibold text-slate-600 shadow-sm"
            >
              Mostrar más ({filtered.length - visible} restantes)
            </button>
          )}
        </>
      )}

      <p className="pt-2 text-center text-[10px] text-slate-400">
        Datos e imágenes: free-exercise-db (dominio público)
      </p>
    </div>
  );
}
