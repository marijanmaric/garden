-- GartenApp – Supabase Datenbankschema
-- Ausführen in: Supabase Dashboard → SQL Editor

-- ============================================================
-- Tabellen
-- ============================================================

create table if not exists gardens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users not null,
  name          text not null,
  location_lat  float,
  location_lon  float,
  grid_rows     int  not null default 10,
  grid_cols     int  not null default 10,
  created_at    timestamptz default now()
);

create table if not exists plants (
  id                      uuid primary key default gen_random_uuid(),
  garden_id               uuid references gardens on delete cascade not null,
  user_id                 uuid references auth.users not null,
  name                    text not null,
  species                 text,
  type                    text not null default 'other',
  grid_x                  int,
  grid_y                  int,
  photo_url               text,
  watering_interval_days  int  not null default 3,
  last_watered_at         timestamptz,
  health_status           text not null default 'healthy',
  care_notes              text,
  created_at              timestamptz default now()
);

create table if not exists care_logs (
  id         uuid primary key default gen_random_uuid(),
  plant_id   uuid references plants on delete cascade not null,
  user_id    uuid references auth.users not null,
  action     text not null,   -- watered | pruned | fertilized | health_check
  notes      text,
  logged_at  timestamptz default now()
);

-- ============================================================
-- Row Level Security
-- ============================================================

alter table gardens   enable row level security;
alter table plants    enable row level security;
alter table care_logs enable row level security;

-- Jeder Nutzer sieht und bearbeitet nur seine eigenen Daten
create policy "own gardens"   on gardens   for all using (auth.uid() = user_id);
create policy "own plants"    on plants    for all using (auth.uid() = user_id);
create policy "own care_logs" on care_logs for all using (auth.uid() = user_id);

-- ============================================================
-- Storage Bucket für Pflanzenfotos
-- ============================================================

insert into storage.buckets (id, name, public)
values ('plant-photos', 'plant-photos', true)
on conflict do nothing;

create policy "auth users upload photos"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'plant-photos');

create policy "public read photos"
  on storage.objects for select
  to public
  using (bucket_id = 'plant-photos');
