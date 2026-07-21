# Franklin Fit Voice

Aplicación web personal de seguimiento de pérdida de grasa y salud digestiva mediante voz e IA.

## Estado actual (Fases 1 a 4)

- ✅ Autenticación con Supabase (email + contraseña)
- ✅ Esquema SQL completo con Row Level Security (10 tablas)
- ✅ Dashboard: peso, media móvil 7 días, cambio semanal, cintura, pasos, sueño, estado digestivo y recomendación basada en reglas
- ✅ Registro por voz: dictado en el navegador (Web Speech API) + extracción estructurada con Google Gemini + confirmación editable antes de guardar
- ✅ Historial diario
- ✅ Fase 3: fotografías de comidas y etiquetas — análisis con Gemini Vision (alimentos, macros, avisos FODMAP), confirmación editable y guardado en `meals` + Supabase Storage (bucket privado `ffv-media`)
- ✅ Fase 4: revisión semanal con IA — métricas agregadas de la semana (peso, pasos, sueño, proteína, entrenos, síntomas digestivos) + resumen y ajuste recomendado generados por Gemini, guardados en `weekly_reviews`
- ✅ Biblioteca de ejercicios: 873 ejercicios con imágenes y técnica de [free-exercise-db](https://github.com/yuhonas/free-exercise-db) (dominio público). El JSON vive en `public/data/exercises.json`; las imágenes se sirven desde el CDN de GitHub

## Stack

Next.js 15 (App Router) · TypeScript · Tailwind CSS 4 · Supabase (proyecto `fporcsfrkknekpkhekur`) · Google Gemini (`gemini-2.5-flash`) · Recharts · Zod

## Configuración local

```bash
npm install
cp .env.example .env.local   # y rellena los valores
npm run dev
```

Variables necesarias en `.env.local`:

| Variable | Descripción |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | URL del proyecto Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Clave publishable de Supabase |
| `GEMINI_API_KEY` | API key de Google AI Studio (https://aistudio.google.com/apikey) |

La clave de Gemini solo se usa en el servidor (route handlers `/api/extract`, `/api/analyze-photo` y `/api/weekly-review`), nunca en el frontend.

## Despliegue en Vercel

1. Sube el repo a GitHub.
2. En Vercel: New Project → importar `FranklinGBP/SaludFranklin`.
3. Añade las tres variables de entorno.
4. Deploy. En Supabase → Authentication → URL Configuration, añade la URL de Vercel como Site URL / Redirect URL.

## Notas

- El dictado por voz usa la Web Speech API del navegador (Chrome/Edge/Android). En navegadores sin soporte se puede escribir el texto manualmente.
- La app no diagnostica: si se registra sangre visible se muestra un aviso para consultar con un médico.
- Migraciones aplicadas directamente en Supabase (ver historial de migraciones del proyecto, `franklin_fit_voice_initial_schema`).
