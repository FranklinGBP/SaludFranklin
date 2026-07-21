# Franklin Fit Voice

Aplicación web personal de seguimiento de pérdida de grasa y salud digestiva mediante voz e IA.

## Estado actual

- ✅ Autenticación con Supabase (email + contraseña)
- ✅ Esquema SQL con Row Level Security
- ✅ Dashboard: peso, media móvil 7 días, cambio semanal, cintura, pasos, sueño, estado digestivo y recomendación basada en reglas
- ✅ Registro por voz: dictado en el navegador (Web Speech API) + extracción estructurada con Google Gemini + confirmación editable antes de guardar
- ✅ Historial diario
- ✅ Fotografías de comidas y etiquetas: análisis con Gemini Vision, macros orientativos, avisos de intolerancias y guardado en Supabase Storage
- ✅ Revisión semanal con IA: métricas agregadas, resumen, ajuste recomendado y adherencia
- ✅ Biblioteca de 873 ejercicios de [free-exercise-db](https://github.com/yuhonas/free-exercise-db)
- ✅ Plan semanal de entrenamiento con IA, ejercicios del catálogo y replanificación adaptativa
- ✅ Plan nutricional semanal: objetivos configurables, exclusión de lactosa/fructosa/sorbitol, alimentos no deseados, referencias visuales, macros calculados por el servidor y lista de compra automática

## Cómo funciona el plan nutricional

Gemini no calcula ni inventa los valores nutricionales. Solo selecciona alimentos y cantidades de `lib/nutrition-catalog.ts`. El servidor valida cada alimento, excluye los incompatibles con las preferencias y calcula calorías, proteínas, carbohidratos y grasas de forma determinista antes de guardar el plan.

El módulo es una implementación propia. No incorpora código de OpenNutriTracker, Mealie o Tandoor ni añade dependencias GPL/AGPL al proyecto.

Tablas añadidas:

- `nutrition_preferences`
- `nutrition_plans`
- `nutrition_plan_days`
- `nutrition_plan_meals`

Antes de usar `/nutricion`, ejecuta en Supabase SQL Editor:

```text
supabase/nutrition_planner.sql
```

## Stack

Next.js 15 (App Router) · TypeScript · Tailwind CSS 4 · Supabase (proyecto `fporcsfrkknekpkhekur`) · Google Gemini (`gemini-3.5-flash`) · Recharts · Zod

## Configuración local

```bash
npm install
cp .env.example .env.local
npm run dev
```

Variables necesarias en `.env.local`:

| Variable | Descripción |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | URL del proyecto Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Clave publishable de Supabase |
| `GEMINI_API_KEY` | API key de Google AI Studio |

La clave de Gemini solo se usa en route handlers del servidor, nunca en el frontend.

## Despliegue en Vercel

1. Importa `FranklinGBP/SaludFranklin` en Vercel.
2. Añade las variables de entorno.
3. Ejecuta los scripts SQL necesarios en Supabase.
4. Despliega y añade la URL de Vercel como Site URL / Redirect URL en Supabase Authentication.

## Notas

- El dictado por voz usa la Web Speech API del navegador.
- La aplicación no diagnostica ni sustituye a un profesional sanitario.
- Los valores nutricionales del plan son orientativos y proceden del catálogo controlado del proyecto.
