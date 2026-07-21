"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { MealPhotoData, MealItemData } from "@/lib/schemas";

type Phase = "input" | "review" | "saved";
type Category = "meal" | "label";

const MEAL_TYPES = ["desayuno", "comida", "cena", "snack", "desconocido"] as const;

const FODMAP_FLAGS: { key: keyof MealItemData; label: string }[] = [
  { key: "suspected_lactose", label: "Lactosa" },
  { key: "suspected_fructose", label: "Fructosa" },
  { key: "suspected_sorbitol", label: "Sorbitol" },
  { key: "suspected_polyols", label: "Polioles" },
];

const MACRO_FIELDS: { key: keyof MealItemData; label: string }[] = [
  { key: "calories", label: "kcal" },
  { key: "protein", label: "Prot (g)" },
  { key: "carbs", label: "Carb (g)" },
  { key: "fats", label: "Grasa (g)" },
];

/** Reduce la foto a máx. 1280 px JPEG para no enviar megas a la API. */
async function compressImage(file: File): Promise<{ blob: Blob; base64: string }> {
  const bitmap = await createImageBitmap(file);
  const maxSide = 1280;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("No se pudo procesar la imagen"))), "image/jpeg", 0.82)
  );
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("No se pudo leer la imagen"));
    reader.readAsDataURL(blob);
  });
  return { blob, base64: dataUrl.split(",")[1] };
}

export default function FotosPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Progreso del guardado: si un paso falla (p. ej. media_files), reintentar
  // no debe volver a insertar la comida ni los alimentos ya guardados.
  const savedMealIdRef = useRef<string | null>(null);
  const savedItemsRef = useRef(false);
  const [phase, setPhase] = useState<Phase>("input");
  const [category, setCategory] = useState<Category>("meal");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [imageBlob, setImageBlob] = useState<Blob | null>(null);
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [data, setData] = useState<MealPhotoData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFileSelected(file: File | undefined) {
    if (!file) return;
    setError(null);
    setLoading(true);
    try {
      const { blob, base64 } = await compressImage(file);
      setImageBlob(blob);
      setImageBase64(base64);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al procesar la imagen");
    } finally {
      setLoading(false);
    }
  }

  async function analyze() {
    if (!imageBase64) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/analyze-photo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: imageBase64, mimeType: "image/jpeg", category }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al analizar la foto");
      savedMealIdRef.current = null;
      savedItemsRef.current = false;
      setData(json.data);
      setPhase("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado");
    } finally {
      setLoading(false);
    }
  }

  function updateItem(index: number, patch: Partial<MealItemData>) {
    if (!data) return;
    const items = data.items.map((it, i) => (i === index ? { ...it, ...patch } : it));
    setData({ ...data, items });
  }

  function removeItem(index: number) {
    if (!data) return;
    setData({ ...data, items: data.items.filter((_, i) => i !== index) });
  }

  async function save() {
    if (!data || !imageBlob) return;
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Sesión caducada");

      const today = new Date().toISOString().slice(0, 10);

      if (!savedMealIdRef.current) {
        const { data: meal, error: mealError } = await supabase
          .from("meals")
          .insert({
            user_id: user.id,
            date: today,
            meal_type: data.meal_type === "desconocido" ? null : data.meal_type,
            description: data.description,
            estimated_calories: data.estimated_calories,
            estimated_protein: data.estimated_protein,
            estimated_carbs: data.estimated_carbs,
            estimated_fats: data.estimated_fats,
            ai_confidence: data.confidence,
          })
          .select("id")
          .single();
        if (mealError) throw new Error(mealError.message);
        savedMealIdRef.current = meal.id;
      }
      const mealId = savedMealIdRef.current;

      if (data.items.length > 0 && !savedItemsRef.current) {
        const { error: itemsError } = await supabase.from("meal_items").insert(
          data.items.map((it) => ({ meal_id: mealId, ...it }))
        );
        if (itemsError) throw new Error(itemsError.message);
      }
      savedItemsRef.current = true;

      const storagePath = `${user.id}/meals/${mealId}.jpg`;
      const { error: uploadError } = await supabase.storage
        .from("ffv-media")
        .upload(storagePath, imageBlob, { contentType: "image/jpeg", upsert: true });
      if (uploadError) throw new Error(uploadError.message);

      const { error: mediaError } = await supabase.from("media_files").insert({
        user_id: user.id,
        meal_id: mealId,
        file_type: "image",
        storage_path: storagePath,
        category: category === "meal" ? "meal_photo" : "label_photo",
        ai_analysis_status: "done",
      });
      // La comida y la foto ya están guardadas; si solo falla el registro en
      // media_files (p. ej. por una restricción), no bloqueamos al usuario.
      if (mediaError) console.error("[fotos] media_files insert failed", mediaError);

      setPhase("saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al guardar");
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setPhase("input");
    savedMealIdRef.current = null;
    savedItemsRef.current = false;
    setData(null);
    setImageBlob(null);
    setImageBase64(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  if (phase === "saved") {
    return (
      <div className="space-y-4 rounded-2xl bg-white p-8 text-center shadow-sm">
        <p className="text-4xl">✅</p>
        <p className="font-semibold">Comida guardada con foto</p>
        {data?.digestive_warning && (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
            ⚠️ {data.digestive_warning}
          </p>
        )}
        <div className="flex justify-center gap-3">
          <button
            onClick={reset}
            className="rounded-lg bg-white px-6 py-2 text-sm font-semibold text-slate-600 shadow-sm"
          >
            Otra foto
          </button>
          <button
            onClick={() => router.push("/dashboard")}
            className="rounded-lg bg-emerald-600 px-6 py-2 text-sm font-semibold text-white"
          >
            Ver dashboard
          </button>
        </div>
      </div>
    );
  }

  if (phase === "review" && data) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-bold">Revisa lo detectado</h2>
        <p className="text-sm text-slate-500">
          Confianza de la IA: {(data.confidence * 100).toFixed(0)} %. Corrige lo que haga falta.
        </p>

        {previewUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewUrl} alt="Foto" className="max-h-52 rounded-xl object-cover shadow-sm" />
        )}

        {data.digestive_warning && (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
            ⚠️ {data.digestive_warning}
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <label className="block rounded-lg bg-white p-3 shadow-sm">
            <span className="text-xs text-slate-500">Tipo de comida</span>
            <select
              value={data.meal_type}
              onChange={(e) =>
                setData({ ...data, meal_type: e.target.value as MealPhotoData["meal_type"] })
              }
              className="mt-1 w-full rounded border border-slate-200 px-2 py-1 text-sm"
            >
              {MEAL_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="block rounded-lg bg-white p-3 shadow-sm">
            <span className="text-xs text-slate-500">Descripción</span>
            <input
              type="text"
              value={data.description}
              onChange={(e) => setData({ ...data, description: e.target.value })}
              className="mt-1 w-full rounded border border-slate-200 px-2 py-1 text-sm"
            />
          </label>
        </div>

        <div className="grid grid-cols-4 gap-3">
          {(
            [
              ["estimated_calories", "kcal totales"],
              ["estimated_protein", "Proteína (g)"],
              ["estimated_carbs", "Carbos (g)"],
              ["estimated_fats", "Grasas (g)"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="block rounded-lg bg-white p-3 shadow-sm">
              <span className="text-xs text-slate-500">{label}</span>
              <input
                type="number"
                value={data[key] ?? ""}
                onChange={(e) =>
                  setData({ ...data, [key]: e.target.value === "" ? null : Number(e.target.value) })
                }
                className="mt-1 w-full rounded border border-slate-200 px-2 py-1 text-sm"
              />
            </label>
          ))}
        </div>

        <div className="space-y-3">
          <p className="text-sm font-semibold">Alimentos detectados</p>
          {data.items.map((item, i) => (
            <div key={i} className="space-y-2 rounded-lg bg-white p-3 shadow-sm">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={item.food_name}
                  onChange={(e) => updateItem(i, { food_name: e.target.value })}
                  className="flex-1 rounded border border-slate-200 px-2 py-1 text-sm font-medium"
                />
                <input
                  type="number"
                  value={item.estimated_quantity ?? ""}
                  onChange={(e) =>
                    updateItem(i, {
                      estimated_quantity: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                  placeholder="Cant."
                  className="w-20 rounded border border-slate-200 px-2 py-1 text-sm"
                />
                <input
                  type="text"
                  value={item.unit ?? ""}
                  onChange={(e) => updateItem(i, { unit: e.target.value || null })}
                  placeholder="ud."
                  className="w-16 rounded border border-slate-200 px-2 py-1 text-sm"
                />
                <button
                  onClick={() => removeItem(i)}
                  className="rounded px-2 py-1 text-sm text-red-500 hover:bg-red-50"
                  aria-label="Eliminar alimento"
                >
                  ✕
                </button>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {MACRO_FIELDS.map((f) => (
                  <label key={f.key} className="block">
                    <span className="text-[10px] text-slate-400">{f.label}</span>
                    <input
                      type="number"
                      value={(item[f.key] as number | null) ?? ""}
                      onChange={(e) =>
                        updateItem(i, {
                          [f.key]: e.target.value === "" ? null : Number(e.target.value),
                        })
                      }
                      className="w-full rounded border border-slate-200 px-2 py-1 text-xs"
                    />
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap gap-1">
                {FODMAP_FLAGS.map((f) => (
                  <button
                    key={f.key}
                    onClick={() => updateItem(i, { [f.key]: !(item[f.key] as boolean) })}
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      item[f.key]
                        ? "bg-amber-500 text-white"
                        : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

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
      <h2 className="text-lg font-bold">Foto de comida o etiqueta</h2>
      <p className="text-sm text-slate-500">
        Haz una foto del plato o de la etiqueta nutricional y la IA estimará alimentos, macros y
        posibles riesgos digestivos.
      </p>

      <div className="flex gap-2">
        {(
          [
            ["meal", "🍽️ Plato de comida"],
            ["label", "🏷️ Etiqueta"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setCategory(value)}
            className={`flex-1 rounded-lg py-2 text-sm font-semibold ${
              category === value ? "bg-emerald-600 text-white" : "bg-white text-slate-600 shadow-sm"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => onFileSelected(e.target.files?.[0])}
        className="hidden"
      />

      <button
        onClick={() => fileInputRef.current?.click()}
        className="flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 bg-white py-10 text-slate-500 hover:border-emerald-500"
      >
        <span className="text-5xl">📷</span>
        <span className="text-sm">
          {previewUrl ? "Cambiar foto" : "Hacer foto o elegir de la galería"}
        </span>
      </button>

      {previewUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={previewUrl} alt="Vista previa" className="max-h-64 rounded-xl object-cover shadow-sm" />
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        onClick={analyze}
        disabled={loading || !imageBase64}
        className="w-full rounded-lg bg-emerald-600 py-3 text-sm font-semibold text-white disabled:opacity-50"
      >
        {loading ? "Analizando con IA…" : "Analizar foto"}
      </button>
    </div>
  );
}
