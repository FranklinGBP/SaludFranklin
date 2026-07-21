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
