import { z } from "zod";

export const DailyVoiceSchema = z.object({
  weight_kg: z.number().nullable(),
  waist_cm: z.number().nullable(),
  sleep_hours: z.number().nullable(),
  steps: z.number().nullable(),
  water_liters: z.number().nullable(),
  energy_level: z.number().min(0).max(10).nullable(),
  hunger_level: z.number().min(0).max(10).nullable(),
  trained: z.boolean(),
  training_type: z.string().nullable(),
  bloating: z.number().min(0).max(10).nullable(),
  pain: z.number().min(0).max(10).nullable(),
  gas: z.number().min(0).max(10).nullable(),
  bristol_type: z.number().min(1).max(7).nullable(),
  bowel_movements: z.number().nullable(),
  urgency: z.boolean(),
  incomplete_evacuation: z.boolean(),
  mucus: z.boolean(),
  visible_blood: z.boolean(),
  notes: z.string(),
});

export type DailyVoiceData = z.infer<typeof DailyVoiceSchema>;

export const MealItemSchema = z.object({
  food_name: z.string(),
  estimated_quantity: z.number().nullable(),
  unit: z.string().nullable(),
  calories: z.number().nullable(),
  protein: z.number().nullable(),
  carbs: z.number().nullable(),
  fats: z.number().nullable(),
  suspected_lactose: z.boolean(),
  suspected_fructose: z.boolean(),
  suspected_sorbitol: z.boolean(),
  suspected_polyols: z.boolean(),
});

export const MealPhotoSchema = z.object({
  meal_type: z.enum(["desayuno", "comida", "cena", "snack", "desconocido"]),
  description: z.string(),
  items: z.array(MealItemSchema),
  estimated_calories: z.number().nullable(),
  estimated_protein: z.number().nullable(),
  estimated_carbs: z.number().nullable(),
  estimated_fats: z.number().nullable(),
  digestive_warning: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

export type MealItemData = z.infer<typeof MealItemSchema>;
export type MealPhotoData = z.infer<typeof MealPhotoSchema>;

export const PlannedExerciseSchema = z.object({
  exercise_id: z.string().nullable(),
  exercise_name: z.string(),
  sets: z.number().int().min(1).max(10).nullable(),
  reps: z.string(),
  rest_seconds: z.number().int().min(0).max(600).nullable(),
  notes: z.string().nullable(),
});

export const PlannedDaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  location: z.enum(["casa", "gimnasio", "descanso"]),
  focus: z.string().nullable(),
  exercises: z.array(PlannedExerciseSchema),
});

export const WorkoutPlanAISchema = z.object({
  strategy: z.string(),
  days: z.array(PlannedDaySchema).length(7),
});

export type PlannedExerciseData = z.infer<typeof PlannedExerciseSchema>;
export type WorkoutPlanAIData = z.infer<typeof WorkoutPlanAISchema>;

export const NutritionIngredientSelectionSchema = z.object({
  food_id: z.string().min(1),
  grams: z.number().min(5).max(600),
});

export const NutritionMealAISchema = z.object({
  meal_type: z.enum(["desayuno", "comida", "cena", "snack"]),
  title: z.string().min(2).max(120),
  ingredients: z.array(NutritionIngredientSelectionSchema).min(1).max(8),
  preparation: z.string().min(2).max(500),
  visual_portion: z.string().min(2).max(250),
  notes: z.string().max(300).nullable(),
});

export const NutritionDayAISchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  meals: z.array(NutritionMealAISchema).min(3).max(5),
});

export const NutritionPlanAISchema = z.object({
  strategy: z.string().min(10).max(1500),
  shopping_tips: z.string().min(2).max(1000),
  days: z.array(NutritionDayAISchema).length(7),
});

export const NutritionRotationMealAISchema = NutritionMealAISchema.extend({
  template_id: z.string().min(1).max(50),
});

export const NutritionRotationScheduleDaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  template_ids: z.array(z.string().min(1).max(50)).min(3).max(5),
});

export const NutritionRotationAISchema = z.object({
  strategy: z.string().min(10).max(1500),
  shopping_tips: z.string().min(2).max(1000),
  templates: z.array(NutritionRotationMealAISchema).min(6).max(12),
  schedule: z.array(NutritionRotationScheduleDaySchema).max(7).optional().default([]),
});

export type NutritionIngredientSelection = z.infer<typeof NutritionIngredientSelectionSchema>;
export type NutritionMealAIData = z.infer<typeof NutritionMealAISchema>;
export type NutritionPlanAIData = z.infer<typeof NutritionPlanAISchema>;
export type NutritionRotationMealAIData = z.infer<typeof NutritionRotationMealAISchema>;
export type NutritionRotationAIData = z.infer<typeof NutritionRotationAISchema>;

export const WeeklyReviewAISchema = z.object({
  ai_summary: z.string(),
  recommended_adjustment: z.string(),
  adherence_score: z.number().min(0).max(10).nullable(),
});

export type WeeklyReviewAIData = z.infer<typeof WeeklyReviewAISchema>;
