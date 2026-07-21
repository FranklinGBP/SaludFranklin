-- Franklin Fit Voice · Planificador nutricional
-- Ejecutar una vez en Supabase SQL Editor.

begin;

create table if not exists public.nutrition_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  objective text not null default 'Perder grasa sin perder músculo',
  target_calories integer not null default 2200 check (target_calories between 1200 and 4500),
  target_protein integer not null default 160 check (target_protein between 60 and 300),
  meals_per_day integer not null default 4 check (meals_per_day between 3 and 5),
  lactose_intolerance boolean not null default true,
  fructose_intolerance boolean not null default true,
  sorbitol_intolerance boolean not null default true,
  avoid_foods text[] not null default '{}',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.nutrition_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  week_start date not null,
  strategy text,
  shopping_tips text,
  target_calories integer not null check (target_calories between 1200 and 4500),
  target_protein integer not null check (target_protein between 60 and 300),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, week_start)
);

create table if not exists public.nutrition_plan_days (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.nutrition_plans(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  calories numeric(8,1) not null default 0,
  protein numeric(8,1) not null default 0,
  carbs numeric(8,1) not null default 0,
  fats numeric(8,1) not null default 0,
  created_at timestamptz not null default now(),
  unique (plan_id, date)
);

create table if not exists public.nutrition_plan_meals (
  id uuid primary key default gen_random_uuid(),
  day_id uuid not null references public.nutrition_plan_days(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  meal_type text not null check (meal_type in ('desayuno', 'comida', 'cena', 'snack')),
  order_index integer not null default 0,
  title text not null,
  ingredients jsonb not null default '[]'::jsonb,
  calories numeric(8,1) not null default 0,
  protein numeric(8,1) not null default 0,
  carbs numeric(8,1) not null default 0,
  fats numeric(8,1) not null default 0,
  preparation text,
  visual_portion text,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists nutrition_plans_user_week_idx
  on public.nutrition_plans (user_id, week_start desc);

create index if not exists nutrition_plan_days_user_date_idx
  on public.nutrition_plan_days (user_id, date);

create index if not exists nutrition_plan_meals_day_order_idx
  on public.nutrition_plan_meals (day_id, order_index);

alter table public.nutrition_preferences enable row level security;
alter table public.nutrition_plans enable row level security;
alter table public.nutrition_plan_days enable row level security;
alter table public.nutrition_plan_meals enable row level security;

drop policy if exists "nutrition_preferences_own" on public.nutrition_preferences;
create policy "nutrition_preferences_own"
  on public.nutrition_preferences
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "nutrition_plans_own" on public.nutrition_plans;
create policy "nutrition_plans_own"
  on public.nutrition_plans
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "nutrition_plan_days_own" on public.nutrition_plan_days;
create policy "nutrition_plan_days_own"
  on public.nutrition_plan_days
  for all
  to authenticated
  using (
    auth.uid() = user_id
    and exists (
      select 1
      from public.nutrition_plans p
      where p.id = plan_id and p.user_id = auth.uid()
    )
  )
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.nutrition_plans p
      where p.id = plan_id and p.user_id = auth.uid()
    )
  );

drop policy if exists "nutrition_plan_meals_own" on public.nutrition_plan_meals;
create policy "nutrition_plan_meals_own"
  on public.nutrition_plan_meals
  for all
  to authenticated
  using (
    auth.uid() = user_id
    and exists (
      select 1
      from public.nutrition_plan_days d
      where d.id = day_id and d.user_id = auth.uid()
    )
  )
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.nutrition_plan_days d
      where d.id = day_id and d.user_id = auth.uid()
    )
  );

grant select, insert, update, delete on public.nutrition_preferences to authenticated;
grant select, insert, update, delete on public.nutrition_plans to authenticated;
grant select, insert, update, delete on public.nutrition_plan_days to authenticated;
grant select, insert, update, delete on public.nutrition_plan_meals to authenticated;

commit;
