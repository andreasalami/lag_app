-- LAG — schema Supabase definitivo e aggiornabile
-- Può essere eseguito su un DB nuovo o su quello esistente.
-- Non elimina utenti, credenziali o dati applicativi.
-- Esecuzione: Supabase > Database > SQL Editor > New query > copia-incolla > Run

begin;

-- ============================================================
-- PROFILI E RUOLI
-- ============================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'pending'
    check (role in ('pending', 'admin', 'staff', 'tournament_manager', 'cassa', 'cucina')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
grant select on public.profiles to authenticated;

drop policy if exists "Un utente legge solo il proprio profilo" on public.profiles;
create policy "Un utente legge solo il proprio profilo"
  on public.profiles for select
  using (auth.uid() = id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, role)
  values (new.id, 'pending')
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Crea soltanto i profili eventualmente mancanti, senza cambiare quelli esistenti.
insert into public.profiles (id, role)
select id, 'pending' from auth.users
on conflict (id) do nothing;

-- ============================================================
-- ANNUNCI
-- ============================================================
create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  message text not null,
  published_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users(id)
);

alter table public.announcements
  alter column created_by set default auth.uid();
alter table public.announcements enable row level security;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.announcements'::regclass and conname = 'announcements_title_valid') then
    alter table public.announcements add constraint announcements_title_valid
      check (btrim(title) <> '' and length(title) <= 200) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.announcements'::regclass and conname = 'announcements_message_valid') then
    alter table public.announcements add constraint announcements_message_valid
      check (btrim(message) <> '' and length(message) <= 5000) not valid;
  end if;
end
$$;

drop policy if exists "Chiunque legge gli annunci" on public.announcements;
drop policy if exists "Solo lo staff pubblica annunci" on public.announcements;
drop policy if exists "Solo lo staff modifica annunci" on public.announcements;
drop policy if exists "Solo lo staff elimina annunci" on public.announcements;

create policy "Chiunque legge gli annunci"
  on public.announcements for select using (true);
create policy "Solo lo staff pubblica annunci"
  on public.announcements for insert
  with check (
    created_by = auth.uid() and exists (
      select 1 from public.profiles
      where id = auth.uid() and role in ('staff', 'admin')
    )
  );
create policy "Solo lo staff modifica annunci"
  on public.announcements for update
  using (exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('staff', 'admin')
  ))
  with check (exists (
    select 1 from public.profiles
    where id = auth.uid()
      and (role = 'admin' or (role = 'staff' and created_by = auth.uid()))
  ));
create policy "Solo lo staff elimina annunci"
  on public.announcements for delete
  using (exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('staff', 'admin')
  ));

create index if not exists announcements_published_at_idx
  on public.announcements (published_at desc);
grant select on public.announcements to anon, authenticated;
grant insert, update, delete on public.announcements to authenticated;

-- ============================================================
-- PROGRAMMA E IMPOSTAZIONI
-- ============================================================
create table if not exists public.program_slots (
  id uuid primary key default gen_random_uuid(),
  day integer not null default 1 check (day between 1 and 3),
  stage text not null check (stage in ('Stage 1', 'Stage 2')),
  title text not null,
  start_time text not null,
  end_time text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.program_settings (
  id text primary key default 'main',
  days integer not null default 1 check (days between 1 and 3),
  updated_at timestamptz not null default now()
);

insert into public.program_settings (id, days)
values ('main', 1)
on conflict (id) do nothing;

alter table public.program_slots enable row level security;
alter table public.program_settings enable row level security;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.program_slots'::regclass and conname = 'program_slots_title_valid') then
    alter table public.program_slots add constraint program_slots_title_valid
      check (btrim(title) <> '' and length(title) <= 200) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.program_slots'::regclass and conname = 'program_slots_start_time_valid') then
    alter table public.program_slots add constraint program_slots_start_time_valid
      check (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.program_slots'::regclass and conname = 'program_slots_end_time_valid') then
    alter table public.program_slots add constraint program_slots_end_time_valid
      check (end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.program_settings'::regclass and conname = 'program_settings_main_only') then
    alter table public.program_settings add constraint program_settings_main_only
      check (id = 'main') not valid;
  end if;
end
$$;

drop policy if exists "Chiunque legge il programma" on public.program_slots;
drop policy if exists "Solo lo staff scrive il programma" on public.program_slots;
drop policy if exists "Solo lo staff modifica il programma" on public.program_slots;
drop policy if exists "Solo lo staff elimina dal programma" on public.program_slots;

create policy "Chiunque legge il programma"
  on public.program_slots for select using (true);
create policy "Solo lo staff scrive il programma"
  on public.program_slots for insert
  with check (exists (select 1 from public.profiles where id = auth.uid() and role in ('staff', 'admin')));
create policy "Solo lo staff modifica il programma"
  on public.program_slots for update
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('staff', 'admin')))
  with check (exists (select 1 from public.profiles where id = auth.uid() and role in ('staff', 'admin')));
create policy "Solo lo staff elimina dal programma"
  on public.program_slots for delete
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('staff', 'admin')));

drop policy if exists "Chiunque legge le impostazioni del programma" on public.program_settings;
drop policy if exists "Solo lo staff modifica le impostazioni del programma" on public.program_settings;
drop policy if exists "Solo lo staff inserisce le impostazioni del programma" on public.program_settings;
drop policy if exists "Solo lo staff aggiorna le impostazioni del programma" on public.program_settings;

create policy "Chiunque legge le impostazioni del programma"
  on public.program_settings for select using (true);
create policy "Solo lo staff inserisce le impostazioni del programma"
  on public.program_settings for insert
  with check (id = 'main' and exists (
    select 1 from public.profiles where id = auth.uid() and role in ('staff', 'admin')
  ));
create policy "Solo lo staff aggiorna le impostazioni del programma"
  on public.program_settings for update
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('staff', 'admin')))
  with check (id = 'main' and exists (
    select 1 from public.profiles where id = auth.uid() and role in ('staff', 'admin')
  ));

create index if not exists program_slots_day_start_idx
  on public.program_slots (day, start_time);
grant select on public.program_slots, public.program_settings to anon, authenticated;
grant insert, update, delete on public.program_slots to authenticated;
grant insert, update on public.program_settings to authenticated;

create or replace function public.save_program(
  p_days integer,
  p_created jsonb default '[]'::jsonb,
  p_updated jsonb default '[]'::jsonb,
  p_deleted uuid[] default '{}'::uuid[]
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_days not between 1 and 3 then
    raise exception 'days must be between 1 and 3';
  end if;
  if jsonb_typeof(coalesce(p_created, '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_updated, '[]'::jsonb)) <> 'array' then
    raise exception 'created and updated must be arrays';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_created, '[]'::jsonb) || coalesce(p_updated, '[]'::jsonb)) elem
    where coalesce(elem->>'day', '') !~ '^[1-3]$'
      or case when coalesce(elem->>'day', '') ~ '^[1-3]$'
        then (elem->>'day')::integer > p_days else false end
  ) then
    raise exception 'every slot day must fit within the published event days';
  end if;

  insert into public.program_settings (id, days, updated_at)
  values ('main', p_days, now())
  on conflict (id) do update set days = excluded.days, updated_at = excluded.updated_at;

  if jsonb_array_length(coalesce(p_created, '[]'::jsonb)) > 0 then
    insert into public.program_slots (day, stage, title, start_time, end_time)
    select (elem->>'day')::integer, elem->>'stage', btrim(elem->>'title'),
      elem->>'start_time', elem->>'end_time'
    from jsonb_array_elements(p_created) elem;
  end if;

  if jsonb_array_length(coalesce(p_updated, '[]'::jsonb)) > 0 then
    update public.program_slots slot
    set day = (elem->>'day')::integer,
      stage = elem->>'stage', title = btrim(elem->>'title'),
      start_time = elem->>'start_time', end_time = elem->>'end_time'
    from jsonb_array_elements(p_updated) elem
    where slot.id = (elem->>'id')::uuid;
  end if;

  if coalesce(array_length(p_deleted, 1), 0) > 0 then
    delete from public.program_slots where id = any(p_deleted);
  end if;
end;
$$;

revoke execute on function public.save_program(integer, jsonb, jsonb, uuid[]) from public;
grant execute on function public.save_program(integer, jsonb, jsonb, uuid[]) to authenticated;

-- Vecchia RPC mantenuta per compatibilità con eventuali client non aggiornati.
create or replace function public.bulk_upsert_program_slots(
  p_created jsonb default '[]'::jsonb,
  p_updated jsonb default '[]'::jsonb,
  p_deleted uuid[] default '{}'::uuid[]
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  perform public.save_program(
    (select days from public.program_settings where id = 'main'),
    p_created, p_updated, p_deleted
  );
end;
$$;

revoke execute on function public.bulk_upsert_program_slots(jsonb, jsonb, uuid[]) from public;
grant execute on function public.bulk_upsert_program_slots(jsonb, jsonb, uuid[]) to authenticated;

-- ============================================================
-- MENU E SCORTE
-- ============================================================
create table if not exists public.menu_items (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('cibo', 'bevande')),
  name text not null,
  price numeric(6,2) not null default 0,
  available_portions integer check (available_portions is null or available_portions >= 0),
  stock_capacity integer,
  created_at timestamptz not null default now()
);

alter table public.menu_items add column if not exists stock_capacity integer;
update public.menu_items
set stock_capacity = available_portions
where stock_capacity is null and available_portions is not null;
alter table public.menu_items enable row level security;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_items'::regclass and conname = 'menu_items_name_valid') then
    alter table public.menu_items add constraint menu_items_name_valid
      check (btrim(name) <> '' and length(name) <= 200) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_items'::regclass and conname = 'menu_items_price_nonnegative') then
    alter table public.menu_items add constraint menu_items_price_nonnegative check (price >= 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_items'::regclass and conname = 'menu_items_stock_capacity_nonnegative') then
    alter table public.menu_items add constraint menu_items_stock_capacity_nonnegative
      check (stock_capacity is null or stock_capacity >= 0) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_items'::regclass and conname = 'menu_items_stock_within_capacity') then
    alter table public.menu_items add constraint menu_items_stock_within_capacity
      check (available_portions is null or stock_capacity is null or available_portions <= stock_capacity) not valid;
  end if;
end
$$;

drop policy if exists "Chiunque legge il menu" on public.menu_items;
drop policy if exists "Solo lo staff scrive il menu" on public.menu_items;
drop policy if exists "Solo lo staff modifica il menu" on public.menu_items;
drop policy if exists "Solo lo staff elimina dal menu" on public.menu_items;

create policy "Chiunque legge il menu"
  on public.menu_items for select using (true);
create policy "Solo lo staff scrive il menu"
  on public.menu_items for insert
  with check (exists (select 1 from public.profiles where id = auth.uid() and role in ('staff', 'admin')));
create policy "Solo lo staff modifica il menu"
  on public.menu_items for update
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('staff', 'admin')))
  with check (exists (select 1 from public.profiles where id = auth.uid() and role in ('staff', 'admin')));
create policy "Solo lo staff elimina dal menu"
  on public.menu_items for delete
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('staff', 'admin')));
grant select on public.menu_items to anon, authenticated;
grant insert, update, delete on public.menu_items to authenticated;

create or replace function public.bulk_upsert_menu_items(
  p_created jsonb default '[]'::jsonb,
  p_updated jsonb default '[]'::jsonb,
  p_deleted uuid[] default '{}'::uuid[]
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if jsonb_typeof(coalesce(p_created, '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_updated, '[]'::jsonb)) <> 'array' then
    raise exception 'created and updated must be arrays';
  end if;

  if jsonb_array_length(coalesce(p_created, '[]'::jsonb)) > 0 then
    insert into public.menu_items (category, name, price, available_portions, stock_capacity)
    select elem->>'category', btrim(elem->>'name'), (elem->>'price')::numeric,
      (elem->>'available_portions')::integer, (elem->>'available_portions')::integer
    from jsonb_array_elements(p_created) elem;
  end if;

  if jsonb_array_length(coalesce(p_updated, '[]'::jsonb)) > 0 then
    update public.menu_items menu
    set category = elem->>'category', name = btrim(elem->>'name'),
      price = (elem->>'price')::numeric,
      stock_capacity = case
        when (elem->>'available_portions')::integer is distinct from menu.available_portions
          then (elem->>'available_portions')::integer
        else menu.stock_capacity end,
      available_portions = (elem->>'available_portions')::integer
    from jsonb_array_elements(p_updated) elem
    where menu.id = (elem->>'id')::uuid;
  end if;

  if coalesce(array_length(p_deleted, 1), 0) > 0 then
    delete from public.menu_items where id = any(p_deleted);
  end if;
end;
$$;

revoke execute on function public.bulk_upsert_menu_items(jsonb, jsonb, uuid[]) from public;
grant execute on function public.bulk_upsert_menu_items(jsonb, jsonb, uuid[]) to authenticated;

-- ============================================================
-- ORDINI
-- ============================================================
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  queue_number bigint generated always as identity,
  items jsonb not null,
  total numeric(7,2) not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.orders enable row level security;

drop policy if exists "Cassa e cucina leggono gli ordini" on public.orders;
drop policy if exists "Solo la cassa crea ordini" on public.orders;
drop policy if exists "Solo admin inserisce ordini direttamente" on public.orders;
drop policy if exists "Solo la cucina aggiorna gli ordini" on public.orders;

create policy "Cassa e cucina leggono gli ordini"
  on public.orders for select
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'cucina', 'admin')));
create policy "Solo admin inserisce ordini direttamente"
  on public.orders for insert
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
create policy "Solo la cucina aggiorna gli ordini"
  on public.orders for update
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('cucina', 'admin')))
  with check (completed_at is not null or exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  ));

create unique index if not exists orders_queue_number_idx on public.orders (queue_number);
create index if not exists orders_active_queue_idx
  on public.orders (queue_number) where completed_at is null;
grant select, insert, update on public.orders to authenticated;

create or replace function public.protect_order_updates()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') then
    return new;
  end if;
  if new.id is distinct from old.id
    or new.queue_number is distinct from old.queue_number
    or new.items is distinct from old.items
    or new.total is distinct from old.total
    or new.created_at is distinct from old.created_at then
    raise exception 'only admin can modify order data';
  end if;
  return new;
end;
$$;

revoke all on function public.protect_order_updates() from public;
drop trigger if exists protect_order_updates on public.orders;
create trigger protect_order_updates
  before update on public.orders
  for each row execute function public.protect_order_updates();

create or replace function public.create_order(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_items jsonb;
  calculated_total numeric;
  created_queue_number bigint;
  warning_messages jsonb := '[]'::jsonb;
  item_id uuid;
  requested_qty integer;
  original_available integer;
  capacity integer;
  remaining integer;
  item_name text;
begin
  if not exists (
    select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')
  ) then
    raise exception 'not authorized to create orders' using errcode = '42501';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array'
    or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 100 then
    raise exception 'items must be an array containing between 1 and 100 lines';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_items) line
    where jsonb_typeof(line) <> 'object'
      or coalesce(line->>'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or coalesce(line->>'qty', '') !~ '^[1-9][0-9]*$'
      or case when coalesce(line->>'qty', '') ~ '^[1-9][0-9]*$'
        then (line->>'qty')::numeric > 999 else false end
  ) then
    raise exception 'invalid order items';
  end if;

  with requested as (
    select (line->>'id')::uuid id, sum((line->>'qty')::integer)::integer qty
    from jsonb_array_elements(p_items) line
    group by (line->>'id')::uuid
  )
  select jsonb_agg(jsonb_build_object(
      'id', menu.id, 'name', menu.name, 'qty', requested.qty, 'price', menu.price
    ) order by menu.name, menu.id),
    sum(menu.price * requested.qty)
  into normalized_items, calculated_total
  from requested join public.menu_items menu on menu.id = requested.id;

  if normalized_items is null or jsonb_array_length(normalized_items) <> (
    select count(distinct (line->>'id')) from jsonb_array_elements(p_items) line
  ) then
    raise exception 'unknown menu item';
  end if;
  if calculated_total > 99999.99 then
    raise exception 'order total exceeds the supported limit';
  end if;

  for item_id, requested_qty in
    select (line->>'id')::uuid, sum((line->>'qty')::integer)::integer
    from jsonb_array_elements(p_items) line
    group by (line->>'id')::uuid
    order by (line->>'id')::uuid
  loop
    select available_portions, stock_capacity, name
    into original_available, capacity, item_name
    from public.menu_items where id = item_id for update;

    if not found then raise exception 'unknown menu item'; end if;
    if original_available is not null and original_available < requested_qty then
      raise exception 'porzioni insufficienti';
    end if;

    remaining := case when original_available is null then null else original_available - requested_qty end;
    update public.menu_items set available_portions = remaining where id = item_id;

    if remaining is not null and capacity is not null and remaining <= ceil(capacity * 0.2) then
      warning_messages := warning_messages || jsonb_build_array(
        format('%s: rimangono %s porzioni', item_name, remaining)
      );
    end if;
  end loop;

  insert into public.orders (items, total)
  values (normalized_items, calculated_total::numeric(7,2))
  returning queue_number into created_queue_number;

  return jsonb_build_object('queue_number', created_queue_number, 'warnings', warning_messages);
end;
$$;

revoke execute on function public.create_order(jsonb) from public;
grant execute on function public.create_order(jsonb) to authenticated;

create or replace function public.get_low_stock_items()
returns table (id uuid, name text, remaining integer, available integer)
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.profiles where id = auth.uid() and role in ('cucina', 'admin')
  ) then
    raise exception 'not authorized to read stock warnings' using errcode = '42501';
  end if;
  return query
    select menu.id, menu.name, menu.available_portions, menu.stock_capacity
    from public.menu_items menu
    where menu.available_portions is not null and menu.stock_capacity is not null
      and menu.available_portions <= ceil(menu.stock_capacity * 0.2)
    order by menu.available_portions, menu.name;
end;
$$;

revoke execute on function public.get_low_stock_items() from public;
grant execute on function public.get_low_stock_items() to authenticated;

-- ============================================================
-- TORNEO
-- ============================================================
create table if not exists public.tournament_state (
  id text primary key default 'main',
  size integer not null default 8,
  teams jsonb not null default '["Squadra 1","Squadra 2","Squadra 3","Squadra 4","Squadra 5","Squadra 6","Squadra 7","Squadra 8"]'::jsonb,
  matches jsonb not null default '{}'::jsonb,
  overrides jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.tournament_state (id)
values ('main')
on conflict (id) do nothing;

alter table public.tournament_state enable row level security;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.tournament_state'::regclass and conname = 'tournament_state_main_only') then
    alter table public.tournament_state add constraint tournament_state_main_only check (id = 'main') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.tournament_state'::regclass and conname = 'tournament_state_size_allowed') then
    alter table public.tournament_state add constraint tournament_state_size_allowed check (size in (8, 16, 32, 64)) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.tournament_state'::regclass and conname = 'tournament_state_json_valid') then
    alter table public.tournament_state add constraint tournament_state_json_valid check (
      jsonb_typeof(teams) = 'array' and jsonb_typeof(matches) = 'object'
      and jsonb_typeof(overrides) = 'object'
    ) not valid;
  end if;
end
$$;

drop policy if exists "Chiunque legge il torneo" on public.tournament_state;
drop policy if exists "Solo tournament_manager pubblica il torneo" on public.tournament_state;
drop policy if exists "Solo tournament_manager inserisce il torneo" on public.tournament_state;
drop policy if exists "Solo tournament_manager aggiorna il torneo" on public.tournament_state;

create policy "Chiunque legge il torneo"
  on public.tournament_state for select using (true);
create policy "Solo tournament_manager inserisce il torneo"
  on public.tournament_state for insert
  with check (id = 'main' and exists (
    select 1 from public.profiles where id = auth.uid() and role in ('tournament_manager', 'admin')
  ));
create policy "Solo tournament_manager aggiorna il torneo"
  on public.tournament_state for update
  using (exists (
    select 1 from public.profiles where id = auth.uid() and role in ('tournament_manager', 'admin')
  ))
  with check (id = 'main' and exists (
    select 1 from public.profiles where id = auth.uid() and role in ('tournament_manager', 'admin')
  ));
grant select on public.tournament_state to anon, authenticated;
grant insert, update on public.tournament_state to authenticated;

-- ============================================================
-- REALTIME
-- ============================================================
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'announcements') then
    alter publication supabase_realtime add table public.announcements;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'program_slots') then
    alter publication supabase_realtime add table public.program_slots;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'menu_items') then
    alter publication supabase_realtime add table public.menu_items;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'orders') then
    alter publication supabase_realtime add table public.orders;
  end if;
end
$$;

commit;
