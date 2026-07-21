import exercisesData from "@/public/data/exercises.json";

type CatalogExercise = {
  id: string;
  name: string;
  level: string;
  equipment: string | null;
  primaryMuscles: string[];
  category: string;
  images: string[];
};

const exercises = exercisesData as CatalogExercise[];

export const exerciseIds = new Set(exercises.map((e) => e.id));

/**
 * Catálogo compacto para el prompt: una línea por ejercicio
 * (el nombre se deduce del id, así ahorramos tokens).
 */
export function catalogForPrompt(): string {
  return exercises
    .map((e) => `${e.id}|${e.equipment ?? "none"}|${e.primaryMuscles[0] ?? "-"}|${e.level}`)
    .join("\n");
}
