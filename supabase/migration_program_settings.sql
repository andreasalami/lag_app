-- Migration: program_settings
-- Persiste il numero di giorni dell'evento (prima era solo state
-- locale nel browser di chi editava il Programma, quindi si
-- resettava a 1 ad ogni reload/dispositivo diverso, nascondendo i
-- giorni successivi al primo anche con eventi già salvati lì sopra).
-- Da lanciare una tantum su installazioni esistenti; su un DB nuovo
-- basta schema.sql, che include già questo blocco.

create table if not exists program_settings (
  id text primary key default 'main',
  days integer not null default 1 check (days between 1 and 3),
  updated_at timestamptz not null default now()
);

insert into program_settings (id) values ('main') on conflict (id) do nothing;

alter table program_settings enable row level security;

create policy "Chiunque legge le impostazioni del programma"
  on program_settings for select
  using (true);

create policy "Solo lo staff modifica le impostazioni del programma"
  on program_settings for all
  using (exists (select 1 from profiles where id = auth.uid() and role in ('staff', 'admin')))
  with check (exists (select 1 from profiles where id = auth.uid() and role in ('staff', 'admin')));
