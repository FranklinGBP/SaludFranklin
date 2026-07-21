-- Corrige la restricción de categoría de media_files.
--
-- La app guarda fotos con category = 'meal_photo' o 'label_photo', pero la
-- restricción creada originalmente en Supabase no admite esos valores y el
-- guardado falla con:
--   new row for relation "media_files" violates check constraint
--   "media_files_category_check"
--
-- Ejecutar en Supabase: Dashboard -> SQL Editor -> pegar y "Run".

alter table public.media_files
  drop constraint if exists media_files_category_check;

-- NOT VALID: no revalida las filas ya existentes (que pudieran usar otras
-- categorías antiguas); solo se aplica a inserciones y actualizaciones nuevas.
alter table public.media_files
  add constraint media_files_category_check
  check (category in ('meal_photo', 'label_photo', 'progress_photo', 'other'))
  not valid;
