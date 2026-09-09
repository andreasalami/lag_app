-- LAG — schema Supabase definitivo e aggiornabile
-- Può essere eseguito su un DB nuovo o su quello esistente.
-- Non elimina utenti, credenziali o dati applicativi.
-- Esecuzione: Supabase > Database > SQL Editor > New query > copia-incolla > Run
--
-- Stato finale, non storia: ogni funzione compare UNA volta sola, nella sua
-- versione viva, e l'intero file è una singola transazione (o passa tutto, o
-- non cambia niente). La storia sta in supabase/migrations/.
-- `scripts/security/verify-schema-matches-migrations.mjs` fallisce la CI se
-- questo file e la catena di migration smettono di descrivere lo stesso
-- database, o se una funzione torna a essere definita due volte.

begin;

create extension if not exists pgcrypto;

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
grant select on public.profiles to service_role;

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
  subcategory text not null,
  name text not null,
  price numeric(6,2) not null default 0,
  available_portions integer check (available_portions is null or available_portions >= 0),
  stock_capacity integer,
  allergens smallint[] not null default '{}'::smallint[],
  created_at timestamptz not null default now()
);

alter table public.menu_items add column if not exists stock_capacity integer;
alter table public.menu_items add column if not exists allergens smallint[] not null default '{}'::smallint[];
alter table public.menu_items add column if not exists subcategory text;
update public.menu_items
set subcategory = case
  when category = 'cibo' and lower(name) ~ '(dolce|torta|gelato|dessert|crostata|biscotto|tiramis)' then 'dolci'
  when category = 'cibo' and lower(name) ~ '(patatin|contorno|insalata|verdure|polenta|fritto misto)' then 'contorni'
  when category = 'cibo' and lower(name) ~ '(pasta|risotto|lasagn|gnocc|raviol|tortell|primo)' then 'primi'
  when category = 'cibo' then 'secondi'
  when category = 'bevande' and lower(name) ~ '(birra|lager|ipa|pils|weiss|bionda|rossa)' then 'birre'
  when category = 'bevande' and lower(name) ~ '(vino|prosecco|spumante|rosso|bianco|rosé|rose)' then 'vini'
  when category = 'bevande' and lower(name) ~ '(spritz|cocktail|drink|gin|vodka|rum|amaro|grappa|mojito|negroni)' then 'drinks'
  else 'bevande'
end
where subcategory is null
  or not (
    (category = 'cibo' and subcategory in ('primi', 'secondi', 'contorni', 'dolci', 'furgone'))
    or (category = 'bevande' and subcategory in ('birre', 'vini', 'drinks', 'bevande'))
  );
alter table public.menu_items alter column subcategory set not null;
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
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_items'::regclass and conname = 'menu_items_allergens_valid') then
    alter table public.menu_items add constraint menu_items_allergens_valid
      check (allergens <@ array[1,2,3,4,5,6,7,8,9,10,11,12,13,14]::smallint[]) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.menu_items'::regclass and conname = 'menu_items_subcategory_valid') then
    alter table public.menu_items add constraint menu_items_subcategory_valid check (
      (category = 'cibo' and subcategory in ('primi', 'secondi', 'contorni', 'dolci', 'furgone'))
      or (category = 'bevande' and subcategory in ('birre', 'vini', 'drinks', 'bevande'))
    ) not valid;
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
  with check (exists (select 1 from public.profiles where id = auth.uid() and role in ('staff', 'cucina', 'admin')));
create policy "Solo lo staff modifica il menu"
  on public.menu_items for update
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('staff', 'cucina', 'admin')))
  with check (exists (select 1 from public.profiles where id = auth.uid() and role in ('staff', 'cucina', 'admin')));
create policy "Solo lo staff elimina dal menu"
  on public.menu_items for delete
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('staff', 'cucina', 'admin')));
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
    insert into public.menu_items (category, subcategory, name, price, available_portions, stock_capacity, allergens)
    select elem->>'category', elem->>'subcategory', btrim(elem->>'name'), (elem->>'price')::numeric,
      (elem->>'available_portions')::integer, (elem->>'available_portions')::integer,
      coalesce((select array_agg(value::smallint order by value::smallint)
        from jsonb_array_elements_text(coalesce(elem->'allergens', '[]'::jsonb))), '{}'::smallint[])
    from jsonb_array_elements(p_created) elem;
  end if;

  if jsonb_array_length(coalesce(p_updated, '[]'::jsonb)) > 0 then
    -- Blocca in ordine stabile i prodotti coinvolti. Se nel frattempo un ordine
    -- ha scalato le scorte, una modifica esplicita della quantità viene rifiutata
    -- invece di sovrascrivere una vendita concorrente.
    perform 1
    from public.menu_items menu
    join jsonb_array_elements(p_updated) elem on menu.id = (elem->>'id')::uuid
    order by menu.id
    for update of menu;

    if exists (
      select 1
      from public.menu_items menu
      join jsonb_array_elements(p_updated) elem on menu.id = (elem->>'id')::uuid
      where (elem->>'available_portions')::integer
          is distinct from (elem->>'original_available_portions')::integer
        and menu.available_portions
          is distinct from (elem->>'original_available_portions')::integer
    ) then
      raise exception 'stock_changed_retry';
    end if;

    update public.menu_items menu
    set category = elem->>'category', subcategory = elem->>'subcategory', name = btrim(elem->>'name'),
      price = (elem->>'price')::numeric,
      stock_capacity = case
        when (elem->>'available_portions')::integer
          is distinct from (elem->>'original_available_portions')::integer
          then (elem->>'available_portions')::integer
        else menu.stock_capacity end,
      available_portions = case
        when (elem->>'available_portions')::integer
          is distinct from (elem->>'original_available_portions')::integer
          then (elem->>'available_portions')::integer
        else menu.available_portions end,
      allergens = coalesce((select array_agg(value::smallint order by value::smallint)
        from jsonb_array_elements_text(coalesce(elem->'allergens', '[]'::jsonb))), '{}'::smallint[])
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
create table if not exists public.order_events (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Evento corrente',
  opens_at timestamptz not null default now(),
  closes_at timestamptz not null default (now() + interval '3 days'),
  manual_closed boolean not null default true,
  permanently_closed_at timestamptz,
  max_pending_orders integer not null default 100 check (max_pending_orders between 10 and 1000),
  final_report jsonb,
  is_current boolean not null default true,
  created_at timestamptz not null default now(),
  check (closes_at > opens_at)
);

create unique index if not exists order_events_one_current_idx
  on public.order_events (is_current) where is_current;

insert into public.order_events (name, opens_at, closes_at, manual_closed, is_current)
select 'Evento corrente', now(), now() + interval '3 days', true, true
where not exists (select 1 from public.order_events where is_current);

alter table public.order_events enable row level security;
revoke all on public.order_events from anon, authenticated;
grant select on public.order_events to authenticated;

drop policy if exists "Cassa legge gli eventi ordine" on public.order_events;
create policy "Cassa legge gli eventi ordine"
  on public.order_events for select
  using (exists (
    select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')
  ));

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  queue_number bigint generated always as identity,
  event_id uuid references public.order_events(id),
  display_number bigint,
  alias text,
  notes text,
  items jsonb not null,
  total numeric(7,2) not null,
  status text,
  qr_token_hash text,
  client_request_id uuid,
  claimed_token_hash text,
  claim_expires_at timestamptz,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  cancelled_at timestamptz,
  delivered_at timestamptz,
  completed_at timestamptz
);

alter table public.orders add column if not exists event_id uuid references public.order_events(id);
alter table public.orders add column if not exists display_number bigint;
alter table public.orders add column if not exists alias text;
alter table public.orders add column if not exists notes text;
alter table public.orders add column if not exists status text;
alter table public.orders add column if not exists qr_token_hash text;
alter table public.orders add column if not exists client_request_id uuid;
alter table public.orders add column if not exists claimed_token_hash text;
alter table public.orders add column if not exists claim_expires_at timestamptz;
alter table public.orders add column if not exists paid_at timestamptz;
alter table public.orders add column if not exists cancelled_at timestamptz;
alter table public.orders add column if not exists delivered_at timestamptz;

update public.orders
set event_id = (select id from public.order_events where is_current limit 1)
where event_id is null;
update public.orders set display_number = queue_number where display_number is null;
update public.orders
set status = case when completed_at is null then 'pagato' else 'consegnato' end,
    paid_at = coalesce(paid_at, created_at),
    delivered_at = case when completed_at is not null then coalesce(delivered_at, completed_at) else delivered_at end
where status is null;

alter table public.orders alter column event_id set not null;
alter table public.orders alter column display_number set not null;
alter table public.orders alter column status set default 'in_attesa_pagamento';
alter table public.orders alter column status set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.orders'::regclass and conname = 'orders_status_valid') then
    alter table public.orders add constraint orders_status_valid
      check (status in ('in_attesa_pagamento', 'pagato', 'consegnato', 'annullato')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.orders'::regclass and conname = 'orders_alias_valid') then
    alter table public.orders add constraint orders_alias_valid
      check (alias is null or length(alias) between 2 and 32) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.orders'::regclass and conname = 'orders_notes_valid') then
    alter table public.orders add constraint orders_notes_valid
      check (notes is null or length(notes) <= 300) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.orders'::regclass and conname = 'orders_pending_identity_valid') then
    alter table public.orders add constraint orders_pending_identity_valid
      check (status <> 'in_attesa_pagamento' or (qr_token_hash is not null and client_request_id is not null)) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.orders'::regclass and conname = 'orders_claim_pair_valid') then
    alter table public.orders add constraint orders_claim_pair_valid check (
      (claimed_token_hash is null) = (claim_expires_at is null)
      and (claimed_token_hash is null or status = 'in_attesa_pagamento')
    ) not valid;
  end if;
end
$$;

alter table public.orders enable row level security;

drop policy if exists "Cassa e cucina leggono gli ordini" on public.orders;
drop policy if exists "La cassa legge solo gli ordini da pagare" on public.orders;
drop policy if exists "La cucina legge solo gli ordini pagati" on public.orders;
drop policy if exists "Solo la cassa crea ordini" on public.orders;
drop policy if exists "Solo admin inserisce ordini direttamente" on public.orders;
drop policy if exists "Solo la cucina aggiorna gli ordini" on public.orders;

-- I ruoli operativi condividono la tabella, ma non lo stesso flusso dati:
-- la cassa vede esclusivamente ciò che deve ancora essere pagato; la cucina
-- esclusivamente ciò che la cassa ha già confermato. Anon non riceve alcun
-- grant sulla tabella e conosce un ordine solo tramite il risultato della RPC
-- di invio. Le RPC di modifica applicano inoltre un controllo ruolo proprio.
create policy "La cassa legge solo gli ordini da pagare"
  on public.orders for select
  using (
    status = 'in_attesa_pagamento'
    and exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin'))
  );
create policy "La cucina legge solo gli ordini pagati"
  on public.orders for select
  using (
    status = 'pagato'
    and exists (select 1 from public.profiles where id = auth.uid() and role in ('cucina', 'admin'))
  );
create unique index if not exists orders_queue_number_idx on public.orders (queue_number);
create unique index if not exists orders_event_display_number_idx on public.orders (event_id, display_number);
create unique index if not exists orders_event_request_idx
  on public.orders (event_id, client_request_id) where client_request_id is not null;
-- Il QR deve identificare un solo ordine. Il nome nuovo evita che una
-- precedente versione non-univoca dell'indice renda questa migrazione un no-op.
create unique index if not exists orders_qr_token_hash_unique_idx
  on public.orders (qr_token_hash) where qr_token_hash is not null;
drop index if exists public.orders_qr_token_hash_idx;
create index if not exists orders_active_queue_idx
  on public.orders (event_id, status, display_number)
  where status in ('in_attesa_pagamento', 'pagato');
revoke insert, update, delete on public.orders from authenticated;
grant select on public.orders to authenticated;

drop trigger if exists protect_order_updates on public.orders;
drop function if exists public.protect_order_updates();
drop function if exists public.create_order(jsonb);

create or replace function public.apply_order_stock(p_old_items jsonb, p_new_items jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  delta_row record;
  current_available integer;
  unavailable_names text[] := '{}'::text[];
begin
  for delta_row in
    with old_lines as (
      select (line->>'id')::uuid id, sum((line->>'qty')::integer)::integer qty
      from jsonb_array_elements(coalesce(p_old_items, '[]'::jsonb)) line group by 1
    ), new_lines as (
      select (line->>'id')::uuid id, sum((line->>'qty')::integer)::integer qty
      from jsonb_array_elements(coalesce(p_new_items, '[]'::jsonb)) line group by 1
    )
    select coalesce(n.id, o.id) id,
      coalesce(n.qty, 0) - coalesce(o.qty, 0) delta
    from old_lines o full join new_lines n on n.id = o.id
    order by 1
  loop
    select available_portions into current_available
    from public.menu_items where id = delta_row.id for update;
    if not found then raise exception 'unknown_menu_item'; end if;
    if delta_row.delta > 0 and current_available is not null and current_available < delta_row.delta then
      unavailable_names := array_append(unavailable_names,
        (select name from public.menu_items where id = delta_row.id));
    end if;
  end loop;

  if cardinality(unavailable_names) > 0 then
    raise exception 'stock_unavailable:%', array_to_string(unavailable_names, ', ');
  end if;

  with old_lines as (
    select (line->>'id')::uuid id, sum((line->>'qty')::integer)::integer qty
    from jsonb_array_elements(coalesce(p_old_items, '[]'::jsonb)) line group by 1
  ), new_lines as (
    select (line->>'id')::uuid id, sum((line->>'qty')::integer)::integer qty
    from jsonb_array_elements(coalesce(p_new_items, '[]'::jsonb)) line group by 1
  ), deltas as (
    select coalesce(n.id, o.id) id, coalesce(n.qty, 0) - coalesce(o.qty, 0) delta
    from old_lines o full join new_lines n on n.id = o.id
  )
  update public.menu_items menu
  set stock_capacity = case
      when menu.available_portions is not null and menu.stock_capacity is not null and deltas.delta < 0
        then greatest(menu.stock_capacity, menu.available_portions - deltas.delta)
      else menu.stock_capacity end,
    available_portions = case when menu.available_portions is null then null
      else menu.available_portions - deltas.delta end
  from deltas where menu.id = deltas.id and deltas.delta <> 0;
end;
$$;

revoke execute on function public.apply_order_stock(jsonb, jsonb) from public, anon, authenticated;

-- Lazy expiry: no scheduler or paid infrastructure. Reads/checkout release old stock.
create or replace function public.expire_unpaid_orders()
returns integer language plpgsql security definer set search_path = public as $$
declare current_event uuid; expired_order record; released integer := 0;
begin
  -- Avoid acquiring an event lock on ordinary reads when there is no work.
  if not exists (select 1 from public.orders o join public.order_events e on e.id=o.event_id
    where e.is_current and e.permanently_closed_at is null
      and o.status='in_attesa_pagamento' and o.created_at <= now()-interval '60 minutes'
      and not exists (select 1 from public.order_claim_devices c where c.order_id=o.id and c.expires_at>now()))
    then return 0; end if;
  select id into current_event from public.order_events
    where is_current and permanently_closed_at is null for update;
  if not found then return 0; end if;
  for expired_order in select o.id,o.items from public.orders o
    where o.event_id=current_event and o.status='in_attesa_pagamento'
      and o.created_at <= now()-interval '60 minutes'
      and not exists (select 1 from public.order_claim_devices c where c.order_id=o.id and c.expires_at>now())
    order by o.id for update of o
  loop
    perform public.apply_order_stock(expired_order.items,'[]'::jsonb);
    update public.orders set status='annullato',cancelled_at=now(),alias=null,notes=null,
      claimed_token_hash=null,claim_expires_at=null where id=expired_order.id;
    delete from public.order_claim_devices where order_id=expired_order.id;
    released := released+1;
  end loop;
  return released;
end;
$$;
revoke execute on function public.expire_unpaid_orders() from public, anon, authenticated;
create index if not exists orders_pending_expiry_idx on public.orders(event_id,created_at)
  where status='in_attesa_pagamento';

create or replace function public.purge_completed_order_personal_data()
returns void language plpgsql security definer set search_path=public as $$
begin
 perform 1 from public.orders
  where (alias is not null or notes is not null) and
    (status='annullato' or (status='consegnato' and delivered_at <= now()-interval '5 minutes'))
  order by id for update;
 update public.orders set alias=null,notes=null
  where (alias is not null or notes is not null) and
    (status='annullato' or (status='consegnato' and delivered_at <= now()-interval '5 minutes'));
end;
$$;
revoke execute on function public.purge_completed_order_personal_data() from public,anon,authenticated;
create index if not exists orders_personal_data_cleanup_idx on public.orders(status,delivered_at)
 where alias is not null or notes is not null;

create or replace function public.get_ordering_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  event_row public.order_events%rowtype;
  pending_count integer;
  reason text;
begin
  perform public.expire_unpaid_orders();
  perform public.purge_completed_order_personal_data();
  select * into event_row from public.order_events where is_current limit 1;
  if not found then return jsonb_build_object('accepting', false, 'reason', 'no_event'); end if;
  select count(*) into pending_count from public.orders
    where event_id = event_row.id and status = 'in_attesa_pagamento';
  reason := case
    when event_row.permanently_closed_at is not null then 'event_closed'
    when event_row.manual_closed then 'ordering_paused'
    when now() < event_row.opens_at then 'not_open_yet'
    when now() > event_row.closes_at then 'ordering_closed'
    when pending_count >= event_row.max_pending_orders then 'capacity_reached'
    else null end;
  return jsonb_build_object(
    'accepting', reason is null,
    'reason', reason,
    'event_id', event_row.id,
    'event_name', event_row.name,
    'opens_at', event_row.opens_at,
    'closes_at', event_row.closes_at,
    'reservation_minutes', 60, 'max_item_quantity', 25, 'max_order_quantity', 60
  );
end;
$$;

revoke execute on function public.get_ordering_status() from public;
grant execute on function public.get_ordering_status() to anon, authenticated;

alter table public.orders add column if not exists recovery_token_hash text;
alter table public.orders add column if not exists recovery_request_id uuid;
create index if not exists orders_recovery_idx on public.orders(recovery_token_hash,created_at,id) where recovery_token_hash is not null;
create or replace function public.recovery_order_qr(p_token text,p_request uuid)
returns text language sql immutable set search_path=public as $$
 select substr(h,1,8)||'-'||substr(h,9,4)||'-4'||substr(h,14,3)||'-8'||substr(h,18,3)||'-'||substr(h,21,12)
 from (select encode(extensions.hmac(p_request::text,p_token,'sha256'),'hex') h) derived;
$$;
revoke execute on function public.recovery_order_qr(text,uuid) from public,anon,authenticated;

-- Il token QR è una credenziale ad alta entropia conservata nel browser.
-- Permette al cliente anonimo di leggere soltanto lo stato del proprio ordine,
-- senza concedere accesso diretto alla tabella orders o ai dati di altri clienti.
drop function if exists public.get_public_order_status(text);

create or replace function public.claim_order(p_order_id uuid, p_claim_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  order_row public.orders%rowtype;
  event_row public.order_events%rowtype;
  token_hash text;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_claim_token is null or length(p_claim_token) not between 32 and 80 then
    raise exception 'invalid_claim_token';
  end if;
  token_hash := encode(extensions.digest(p_claim_token, 'sha256'), 'hex');
  select event.* into event_row from public.order_events event
  join public.orders target on target.event_id = event.id
  where target.id = p_order_id for key share of event;
  if not found or event_row.permanently_closed_at is not null then raise exception 'event_closed'; end if;
  select * into order_row from public.orders where id = p_order_id for update;
  if not found or order_row.status <> 'in_attesa_pagamento' then raise exception 'order_not_available'; end if;
  if order_row.claimed_token_hash is not null and order_row.claim_expires_at > now()
    and order_row.claimed_token_hash <> token_hash then raise exception 'order_already_claimed'; end if;
  update public.orders set claimed_token_hash = token_hash,
    claim_expires_at = now() + interval '10 minutes'
  where id = p_order_id returning * into order_row;
  return to_jsonb(order_row) - 'qr_token_hash' - 'claimed_token_hash' - 'client_request_id';
end;
$$;

revoke execute on function public.claim_order(uuid, text) from public;
grant execute on function public.claim_order(uuid, text) to authenticated;

create or replace function public.claim_order_by_qr(p_qr_token text, p_claim_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare target_id uuid;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_qr_token is null or length(p_qr_token) not between 32 and 80 then
    raise exception 'invalid_qr_token';
  end if;
  if p_claim_token is null or length(p_claim_token) not between 32 and 80 then
    raise exception 'invalid_claim_token';
  end if;
  select id into target_id from public.orders
  where qr_token_hash = encode(extensions.digest(p_qr_token, 'sha256'), 'hex')
    and status = 'in_attesa_pagamento';
  if target_id is null then raise exception 'order_not_available'; end if;
  return public.claim_order(target_id, p_claim_token);
end;
$$;

revoke execute on function public.claim_order_by_qr(text, text) from public;
grant execute on function public.claim_order_by_qr(text, text) to authenticated;

create or replace function public.release_order_claim(p_order_id uuid, p_claim_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare event_row public.order_events%rowtype;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_claim_token is null or length(p_claim_token) not between 32 and 80 then
    raise exception 'invalid_claim_token';
  end if;
  select event.* into event_row from public.order_events event
  join public.orders target on target.event_id = event.id
  where target.id = p_order_id for key share of event;
  if not found or event_row.permanently_closed_at is not null then raise exception 'event_closed'; end if;
  update public.orders set claimed_token_hash = null, claim_expires_at = null
  where id = p_order_id and status = 'in_attesa_pagamento'
    and claimed_token_hash = encode(extensions.digest(p_claim_token, 'sha256'), 'hex');
end;
$$;

revoke execute on function public.release_order_claim(uuid, text) from public;
grant execute on function public.release_order_claim(uuid, text) to authenticated;

create or replace function public.update_claimed_order(
  p_order_id uuid, p_claim_token text, p_alias text, p_notes text, p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare order_row public.orders%rowtype; event_row public.order_events%rowtype;
  normalized jsonb; calculated_total numeric;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_alias is null or length(btrim(p_alias)) not between 2 and 32 then raise exception 'invalid_alias'; end if;
  if length(coalesce(p_notes, '')) > 300 then raise exception 'notes_too_long'; end if;
  if p_claim_token is null or length(p_claim_token) not between 32 and 80 then
    raise exception 'invalid_claim_token';
  end if;
  -- Tutte le mutazioni di un ordine prendono prima il lock evento e poi il
  -- lock ordine. La chiusura definitiva usa lo stesso ordine di lock.
  select event.* into event_row from public.order_events event
  join public.orders target on target.event_id = event.id
  where target.id = p_order_id for key share of event;
  if not found or event_row.permanently_closed_at is not null then raise exception 'event_closed'; end if;
  select * into order_row from public.orders where id = p_order_id for update;
  if not found or order_row.status <> 'in_attesa_pagamento'
    or order_row.claimed_token_hash is distinct from encode(extensions.digest(p_claim_token, 'sha256'), 'hex')
    or order_row.claim_expires_at is null or order_row.claim_expires_at <= now() then
    raise exception 'claim_lost';
  end if;
  normalized := public.normalize_order_items(p_items);
  perform public.apply_order_stock(order_row.items, normalized);
  select sum((line->>'price')::numeric * (line->>'qty')::integer)
    into calculated_total from jsonb_array_elements(normalized) line;
  update public.orders set alias = btrim(p_alias), notes = nullif(btrim(coalesce(p_notes, '')), ''),
    items = normalized, total = calculated_total::numeric(7,2),
    claim_expires_at = now() + interval '10 minutes'
  where id = p_order_id returning * into order_row;
  return to_jsonb(order_row) - 'qr_token_hash' - 'claimed_token_hash' - 'client_request_id';
end;
$$;

revoke execute on function public.update_claimed_order(uuid, text, text, text, jsonb) from public;
grant execute on function public.update_claimed_order(uuid, text, text, text, jsonb) to authenticated;

create or replace function public.cancel_claimed_order(p_order_id uuid, p_claim_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare order_row public.orders%rowtype; event_row public.order_events%rowtype;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_claim_token is null or length(p_claim_token) not between 32 and 80 then
    raise exception 'invalid_claim_token';
  end if;
  select event.* into event_row from public.order_events event
  join public.orders target on target.event_id = event.id
  where target.id = p_order_id for key share of event;
  if not found or event_row.permanently_closed_at is not null then raise exception 'event_closed'; end if;
  select * into order_row from public.orders where id = p_order_id for update;
  if not found or order_row.status <> 'in_attesa_pagamento'
    or order_row.claimed_token_hash is distinct from encode(extensions.digest(p_claim_token, 'sha256'), 'hex')
    or order_row.claim_expires_at is null or order_row.claim_expires_at <= now() then
    raise exception 'claim_lost';
  end if;
  perform public.apply_order_stock(order_row.items, '[]'::jsonb);
  update public.orders set status = 'annullato', cancelled_at = now(),
    alias = null, notes = null,
    claimed_token_hash = null, claim_expires_at = null where id = p_order_id;
end;
$$;

revoke execute on function public.cancel_claimed_order(uuid, text) from public;
grant execute on function public.cancel_claimed_order(uuid, text) to authenticated;

create or replace function public.pay_claimed_order(p_order_id uuid, p_claim_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare order_row public.orders%rowtype; event_row public.order_events%rowtype; has_food boolean;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_claim_token is null or length(p_claim_token) not between 32 and 80 then
    raise exception 'invalid_claim_token';
  end if;
  select event.* into event_row from public.order_events event
  join public.orders target on target.event_id = event.id
  where target.id = p_order_id for key share of event;
  if not found or event_row.permanently_closed_at is not null then raise exception 'event_closed'; end if;
  select * into order_row from public.orders where id = p_order_id for update;
  if not found or order_row.status <> 'in_attesa_pagamento'
    or order_row.claimed_token_hash is distinct from encode(extensions.digest(p_claim_token, 'sha256'), 'hex')
    or order_row.claim_expires_at is null or order_row.claim_expires_at <= now() then
    raise exception 'claim_lost';
  end if;
  select exists (select 1 from jsonb_array_elements(order_row.items) line where line->>'category' = 'cibo') into has_food;
  update public.orders set status = case when has_food then 'pagato' else 'consegnato' end,
    paid_at = now(), delivered_at = case when has_food then null else now() end,
    completed_at = case when has_food then null else now() end,
    alias = case when has_food then alias else null end,
    notes = case when has_food then notes else null end,
    claimed_token_hash = null, claim_expires_at = null
  where id = p_order_id returning * into order_row;
  return to_jsonb(order_row) - 'qr_token_hash' - 'claimed_token_hash' - 'client_request_id';
end;
$$;

revoke execute on function public.pay_claimed_order(uuid, text) from public;
grant execute on function public.pay_claimed_order(uuid, text) to authenticated;

create or replace function public.deliver_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare event_row public.order_events%rowtype;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cucina', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select event.* into event_row from public.order_events event
  join public.orders target on target.event_id = event.id
  where target.id = p_order_id for key share of event;
  if not found or event_row.permanently_closed_at is not null then raise exception 'event_closed'; end if;
  update public.orders set status = 'consegnato', delivered_at = now(), completed_at = now(),
    alias = null, notes = null
  where id = p_order_id and status = 'pagato';
  if not found then raise exception 'order_not_available'; end if;
end;
$$;

revoke execute on function public.deliver_order(uuid) from public;
grant execute on function public.deliver_order(uuid) to authenticated;

create or replace function public.deliver_order_by_qr(p_qr_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare order_row public.orders%rowtype;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cucina', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_qr_token is null or length(p_qr_token) not between 32 and 80 then
    raise exception 'invalid_qr_token';
  end if;
  select * into order_row from public.orders
  where qr_token_hash = encode(extensions.digest(p_qr_token, 'sha256'), 'hex')
    and status = 'pagato';
  if not found then raise exception 'order_not_available'; end if;
  perform public.deliver_order(order_row.id);
  return jsonb_build_object(
    'order_id', order_row.id,
    'display_number', order_row.display_number,
    'status', 'consegnato'
  );
end;
$$;

revoke execute on function public.deliver_order_by_qr(text) from public, anon;
grant execute on function public.deliver_order_by_qr(text) to authenticated;

create or replace function public.get_order_event_admin_state()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare event_row public.order_events%rowtype; pending_count integer;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into event_row from public.order_events where is_current limit 1;
  select count(*) into pending_count from public.orders
    where event_id = event_row.id and status = 'in_attesa_pagamento';
  return to_jsonb(event_row) || jsonb_build_object('pending_count', pending_count);
end;
$$;

revoke execute on function public.get_order_event_admin_state() from public;
grant execute on function public.get_order_event_admin_state() to authenticated;

create or replace function public.update_order_event(
  p_name text, p_opens_at timestamptz, p_closes_at timestamptz, p_max_pending_orders integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare event_row public.order_events%rowtype;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if btrim(coalesce(p_name, '')) = '' or length(p_name) > 100
    or p_closes_at <= p_opens_at or p_max_pending_orders not between 10 and 1000 then
    raise exception 'invalid_event_settings';
  end if;
  update public.order_events set name = btrim(p_name), opens_at = p_opens_at,
    closes_at = p_closes_at, max_pending_orders = p_max_pending_orders
  where is_current and permanently_closed_at is null returning * into event_row;
  if not found then raise exception 'event_closed'; end if;
  return to_jsonb(event_row);
end;
$$;

revoke execute on function public.update_order_event(text, timestamptz, timestamptz, integer) from public;
grant execute on function public.update_order_event(text, timestamptz, timestamptz, integer) to authenticated;

create or replace function public.set_ordering_paused(p_paused boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  update public.order_events set manual_closed = p_paused
  where is_current and permanently_closed_at is null;
  if not found then raise exception 'event_closed'; end if;
end;
$$;

revoke execute on function public.set_ordering_paused(boolean) from public;
grant execute on function public.set_ordering_paused(boolean) to authenticated;

alter table public.orders add column if not exists report_status text;

create or replace function public.get_order_event_report()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare report jsonb;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select event_row.final_report || jsonb_build_object(
    'orders', coalesce(jsonb_agg(jsonb_build_object(
      'number', orders_row.display_number,
      'created_at', orders_row.created_at,
      'paid_at', orders_row.paid_at,
      'status', coalesce(orders_row.report_status, orders_row.status),
      'items', orders_row.items,
      'total', orders_row.total
    ) order by orders_row.display_number) filter (where orders_row.id is not null), '[]'::jsonb)
  ) into report
  from public.order_events event_row
  left join public.orders orders_row on orders_row.event_id = event_row.id
  where event_row.is_current
  group by event_row.id, event_row.final_report;
  return report;
end;
$$;

revoke execute on function public.get_order_event_report() from public;
grant execute on function public.get_order_event_report() to authenticated;

create or replace function public.create_next_order_event(
  p_name text, p_opens_at timestamptz, p_closes_at timestamptz, p_max_pending_orders integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare event_row public.order_events%rowtype;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if exists (select 1 from public.order_events where is_current and permanently_closed_at is null) then
    raise exception 'current_event_not_closed';
  end if;
  if btrim(coalesce(p_name, '')) = '' or p_closes_at <= p_opens_at
    or p_max_pending_orders not between 10 and 1000 then raise exception 'invalid_event_settings'; end if;
  update public.order_events set is_current = false where is_current;
  insert into public.order_events (name, opens_at, closes_at, max_pending_orders, is_current)
  values (btrim(p_name), p_opens_at, p_closes_at, p_max_pending_orders, true)
  returning * into event_row;
  return to_jsonb(event_row);
end;
$$;

revoke execute on function public.create_next_order_event(text, timestamptz, timestamptz, integer) from public;
grant execute on function public.create_next_order_event(text, timestamptz, timestamptz, integer) to authenticated;

-- ============================================================
-- NOTIFICHE WEB PUSH
-- ============================================================
-- Gli endpoint Push sono credenziali tecniche del dispositivo: nessun client
-- può leggerli direttamente. La registrazione pubblica passa soltanto dalla
-- RPC validata; l'invio e la pulizia sono affidati alla Edge Function con
-- service_role, mai al browser del gestore.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  source text not null default 'tournament',
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists push_subscriptions_endpoint_idx
  on public.push_subscriptions (endpoint);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from public, anon, authenticated;
grant select, delete on public.push_subscriptions to service_role;

alter table public.push_subscriptions drop constraint if exists push_subscriptions_values_valid;
alter table public.push_subscriptions add constraint push_subscriptions_values_valid check (
  endpoint ~ '^https://[^[:space:]]+$'
  and length(endpoint) between 28 and 2048
  and p256dh ~ '^[A-Za-z0-9_-]{80,120}$'
  and auth ~ '^[A-Za-z0-9_-]{16,64}$'
  and source in ('announcements', 'tournament')
  and (user_agent is null or length(user_agent) <= 500)
) not valid;

create table if not exists public.push_broadcasts (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('announcement', 'tournament')),
  title text not null check (length(title) between 2 and 80),
  message text not null check (length(message) between 2 and 240),
  sent_by uuid references auth.users(id) on delete set null,
  subscriber_count integer not null default 0 check (subscriber_count >= 0),
  success_count integer not null default 0 check (success_count >= 0),
  failure_count integer not null default 0 check (failure_count >= 0),
  created_at timestamptz not null default now()
);

alter table public.push_broadcasts enable row level security;
revoke all on public.push_broadcasts from public, anon, authenticated;
grant select on public.push_broadcasts to authenticated;
grant insert on public.push_broadcasts to service_role;

drop policy if exists "Gestori leggono lo storico notifiche" on public.push_broadcasts;
create policy "Gestori leggono lo storico notifiche"
  on public.push_broadcasts for select
  using (exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('staff', 'tournament_manager', 'admin')
  ));

create or replace function public.valid_push_endpoint(p_endpoint text)
returns boolean language sql immutable set search_path=public as $$
 select coalesce(length(p_endpoint) between 28 and 2048
  and p_endpoint ~* '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)/[^[:space:]#]+$'
  and position(chr(92) in p_endpoint)=0,false);
$$;
revoke execute on function public.valid_push_endpoint(text) from public,anon,authenticated;

create or replace function public.upsert_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_source text,
  p_user_agent text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare subscription_id uuid; subscription_count integer;
begin
  if not public.valid_push_endpoint(p_endpoint)
    or length(p_endpoint) not between 28 and 2048
    or p_p256dh is null or p_p256dh !~ '^[A-Za-z0-9_-]{87}$'
    or p_auth is null or p_auth !~ '^[A-Za-z0-9_-]{22}$'
    or p_source is null or p_source not in ('announcements', 'tournament')
    or length(coalesce(p_user_agent, '')) > 500 then
    raise exception 'invalid_push_subscription';
  end if;

  if octet_length(decode(translate(p_p256dh,'-_','+/') || '=', 'base64')) <> 65
    or get_byte(decode(translate(p_p256dh,'-_','+/') || '=', 'base64'),0) <> 4
    or octet_length(decode(translate(p_auth,'-_','+/') || '==','base64')) <> 16 then
    raise exception 'invalid_push_subscription';
  end if;
  -- Mantiene atomico il limite anche se molti telefoni si registrano nello
  -- stesso istante; non interferisce con gli altri lock applicativi.
  perform pg_advisory_xact_lock(hashtext('lag_push_subscriptions_capacity'));
  if not exists (select 1 from public.push_subscriptions where endpoint = p_endpoint) then
    select count(*) into subscription_count from public.push_subscriptions;
    if subscription_count >= 5000 then raise exception 'push_capacity_reached'; end if;
  end if;

  insert into public.push_subscriptions (endpoint, p256dh, auth, source, user_agent)
  values (p_endpoint, p_p256dh, p_auth, p_source, nullif(p_user_agent, ''))
  on conflict (endpoint) do update set
    p256dh = excluded.p256dh,
    auth = excluded.auth,
    source = excluded.source,
    user_agent = excluded.user_agent,
    updated_at = now()
  returning id into subscription_id;
  return subscription_id;
end;
$$;

revoke execute on function public.upsert_push_subscription(text, text, text, text, text) from public;
grant execute on function public.upsert_push_subscription(text, text, text, text, text) to anon, authenticated;

create or replace function public.get_push_subscription_count()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare result integer;
begin
  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('tournament_manager', 'admin')
  ) then raise exception 'not_authorized' using errcode = '42501'; end if;
  select count(*) into result from public.push_subscriptions;
  return result;
end;
$$;

revoke execute on function public.get_push_subscription_count() from public;
grant execute on function public.get_push_subscription_count() to authenticated;

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

-- Copie di sicurezza create prima di cambiare la struttura del tabellone
-- o di ripristinare una versione precedente. Non sono mai pubbliche.
create table if not exists public.tournament_snapshots (
  id uuid primary key default gen_random_uuid(),
  size integer not null,
  teams jsonb not null,
  matches jsonb not null,
  overrides jsonb not null,
  reason text not null,
  target_size integer,
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint tournament_snapshots_size_allowed check (size in (8, 16, 32, 64)),
  constraint tournament_snapshots_target_size_allowed check (target_size is null or target_size in (8, 16, 32, 64)),
  constraint tournament_snapshots_reason_allowed check (reason in ('size_change', 'restore')),
  constraint tournament_snapshots_json_valid check (
    jsonb_typeof(teams) = 'array'
    and jsonb_array_length(teams) = size
    and jsonb_typeof(matches) = 'object'
    and jsonb_typeof(overrides) = 'object'
  )
);

create index if not exists tournament_snapshots_created_at_idx
  on public.tournament_snapshots (created_at desc);

alter table public.tournament_snapshots enable row level security;

drop policy if exists "Gestori leggono gli snapshot torneo" on public.tournament_snapshots;
drop policy if exists "Gestori archiviano gli snapshot torneo" on public.tournament_snapshots;

create policy "Gestori leggono gli snapshot torneo"
  on public.tournament_snapshots for select
  using (exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('tournament_manager', 'admin')
  ));

create policy "Gestori archiviano gli snapshot torneo"
  on public.tournament_snapshots for insert
  with check (
    created_by = auth.uid()
    and exists (
      select 1 from public.profiles
      where id = auth.uid() and role in ('tournament_manager', 'admin')
    )
  );

revoke all on public.tournament_snapshots from public, anon, authenticated;
grant select, insert on public.tournament_snapshots to authenticated;

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

-- Flusso ordini multi-postazione (sincronizzato con la migrazione 20260901113000).
-- Ruolo Bar e nuova destinazione Furgone esterno.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('pending', 'admin', 'staff', 'tournament_manager', 'cassa', 'cucina', 'bar'));

alter table public.menu_items drop constraint if exists menu_items_subcategory_valid;
alter table public.menu_items add constraint menu_items_subcategory_valid check (
  (category = 'cibo' and subcategory in ('primi', 'secondi', 'contorni', 'dolci', 'furgone'))
  or (category = 'bevande' and subcategory in ('birre', 'vini', 'drinks', 'bevande'))
);

-- Lo stato globale resta semplice; il dettaglio vive nelle righe di evasione.
alter table public.orders drop constraint if exists orders_status_valid;
alter table public.orders add constraint orders_status_valid
  check (status in ('in_attesa_pagamento', 'pagato', 'ritiro_parziale', 'consegnato', 'annullato'));

-- Il client deve conoscere la sottosezione per mostrare e instradare ogni voce.
create or replace function public.get_ordering_catalog()
returns jsonb language plpgsql security definer set search_path = public as $$
declare status_payload jsonb; catalog jsonb;
begin
  status_payload := public.get_ordering_status();
  if not coalesce((status_payload->>'accepting')::boolean, false) then
    return status_payload || jsonb_build_object('items', '[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'category', category, 'subcategory', subcategory,
    'name', name, 'price', price, 'available_portions', available_portions,
    'stock_capacity', stock_capacity, 'allergens', to_jsonb(allergens)
  ) order by category, subcategory, name), '[]'::jsonb)
  into catalog from public.menu_items;
  return status_payload || jsonb_build_object('items', catalog);
end;
$$;
revoke execute on function public.get_ordering_catalog() from public;
grant execute on function public.get_ordering_catalog() to anon, authenticated;

create table if not exists public.order_claim_devices (
  order_id uuid not null references public.orders(id) on delete cascade,
  station text not null check (station in ('cassa_1', 'cassa_2', 'cassa_3', 'cassa_4', 'cassa_5')),
  device_hash text not null check (device_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  primary key (order_id, device_hash)
);
create index if not exists order_claim_devices_active_idx
  on public.order_claim_devices (order_id, expires_at);
alter table public.order_claim_devices enable row level security;
revoke all on public.order_claim_devices from public, anon, authenticated;

create table if not exists public.order_fulfillment_items (
  order_id uuid not null references public.orders(id) on delete cascade,
  menu_item_id uuid not null,
  name text not null,
  category text not null check (category in ('cibo', 'bevande')),
  subcategory text not null,
  station text not null check (station in ('primi', 'secondi', 'contorni', 'dolci', 'furgone', 'birre', 'drinks', 'bar')),
  quantity integer not null check (quantity > 0),
  delivered_quantity integer not null default 0 check (delivered_quantity >= 0 and delivered_quantity <= quantity),
  primary key (order_id, menu_item_id)
);
create index if not exists order_fulfillment_station_idx
  on public.order_fulfillment_items (station, order_id)
  where delivered_quantity < quantity;
alter table public.order_fulfillment_items enable row level security;
revoke all on public.order_fulfillment_items from public, anon, authenticated;

create table if not exists public.fulfillment_deliveries (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  station text not null check (station in ('primi', 'secondi', 'contorni', 'dolci', 'furgone', 'birre', 'drinks', 'bar')),
  quantities jsonb not null check (jsonb_typeof(quantities) = 'array'),
  delivered_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  reversed_at timestamptz,
  reversed_by uuid references auth.users(id)
);
create index if not exists fulfillment_deliveries_recent_idx
  on public.fulfillment_deliveries (station, created_at desc)
  where reversed_at is null;
alter table public.fulfillment_deliveries enable row level security;
revoke all on public.fulfillment_deliveries from public, anon, authenticated;

create or replace function public.normalize_order_items(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare normalized jsonb;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array'
    or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 100 then
    raise exception 'invalid_order_items';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) line
    where jsonb_typeof(line) <> 'object'
      or coalesce(line->>'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or coalesce(line->>'qty', '') !~ '^[1-9][0-9]*$'
      or case when coalesce(line->>'qty', '') ~ '^[1-9][0-9]*$'
        then (line->>'qty')::numeric > 999 else false end
  ) then raise exception 'invalid_order_items'; end if;

  with requested as (
    select (line->>'id')::uuid id, sum((line->>'qty')::integer)::integer qty
    from jsonb_array_elements(p_items) line group by (line->>'id')::uuid
  )
  select jsonb_agg(jsonb_build_object(
    'id', menu.id, 'name', menu.name, 'category', menu.category,
    'subcategory', menu.subcategory, 'allergens', to_jsonb(menu.allergens),
    'qty', requested.qty, 'price', menu.price
  ) order by menu.category, menu.subcategory, menu.name, menu.id)
  into normalized from requested join public.menu_items menu on menu.id = requested.id;

  if normalized is null or jsonb_array_length(normalized) <> (
    select count(distinct (line->>'id')) from jsonb_array_elements(p_items) line
  ) then raise exception 'unknown_menu_item'; end if;
  return normalized;
end;
$$;
revoke execute on function public.normalize_order_items(jsonb) from public, anon, authenticated;

create or replace function public.seed_order_fulfillment(p_order_id uuid, p_items jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.order_fulfillment_items (
    order_id, menu_item_id, name, category, subcategory, station, quantity
  )
  select p_order_id, (line->>'id')::uuid, line->>'name', line->>'category',
    coalesce(line->>'subcategory', menu.subcategory,
      case line->>'category' when 'cibo' then 'secondi' else 'bevande' end),
    case coalesce(line->>'subcategory', menu.subcategory,
      case line->>'category' when 'cibo' then 'secondi' else 'bevande' end)
      when 'vini' then 'bar' when 'bevande' then 'bar'
      else coalesce(line->>'subcategory', menu.subcategory,
        case line->>'category' when 'cibo' then 'secondi' else 'bevande' end) end,
    (line->>'qty')::integer
  from jsonb_array_elements(p_items) line
  left join public.menu_items menu on menu.id = (line->>'id')::uuid
  on conflict (order_id, menu_item_id) do nothing;
end;
$$;
revoke execute on function public.seed_order_fulfillment(uuid, jsonb) from public, anon, authenticated;

-- Recupera eventuali ordini già pagati prima della migrazione.
do $$
declare existing_order record;
begin
  for existing_order in select id, items from public.orders where status in ('pagato', 'ritiro_parziale') loop
    perform public.seed_order_fulfillment(existing_order.id, existing_order.items);
  end loop;
end
$$;

create or replace function public.get_cashier_pending_orders()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare result jsonb;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform public.expire_unpaid_orders();
  perform public.purge_completed_order_personal_data();
  delete from public.order_claim_devices where expires_at <= now();
  select coalesce(jsonb_agg(to_jsonb(queue_row) order by queue_row.created_at), '[]'::jsonb)
  into result from (
    select orders_row.id, orders_row.event_id, orders_row.display_number,
      orders_row.alias, orders_row.total, orders_row.created_at, orders_row.status,
      claim.station as claimed_station, claim.expires_at as claim_expires_at
    from public.orders orders_row
    left join lateral (
      select min(station) station, max(expires_at) expires_at
      from public.order_claim_devices
      where order_id = orders_row.id and expires_at > now()
    ) claim on true
    where orders_row.status = 'in_attesa_pagamento'
  ) queue_row;
  return result;
end;
$$;
revoke execute on function public.get_cashier_pending_orders() from public;
grant execute on function public.get_cashier_pending_orders() to authenticated;

create or replace function public.claim_order_by_qr_for_station(
  p_qr_token text, p_station text, p_device_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare target_id uuid;
begin
  if p_qr_token is null or length(p_qr_token) not between 32 and 80 then raise exception 'invalid_qr_token'; end if;
  select id into target_id from public.orders
  where qr_token_hash = encode(extensions.digest(p_qr_token, 'sha256'), 'hex')
    and status = 'in_attesa_pagamento';
  if target_id is null then raise exception 'order_not_available'; end if;
  return public.claim_order_for_station(target_id, p_station, p_device_id);
end;
$$;
revoke execute on function public.claim_order_by_qr_for_station(text, text, text) from public;
grant execute on function public.claim_order_by_qr_for_station(text, text, text) to authenticated;

create or replace function public.release_order_for_station(
  p_order_id uuid, p_station text, p_device_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  delete from public.order_claim_devices
  where order_id = p_order_id and station = p_station
    and device_hash = encode(extensions.digest(p_device_id, 'sha256'), 'hex');
end;
$$;
revoke execute on function public.release_order_for_station(uuid, text, text) from public;
grant execute on function public.release_order_for_station(uuid, text, text) to authenticated;

create or replace function public.force_release_order(p_order_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  delete from public.order_claim_devices where order_id = p_order_id;
end;
$$;
revoke execute on function public.force_release_order(uuid) from public;
grant execute on function public.force_release_order(uuid) to authenticated;

create or replace function public.cancel_order_for_station(
  p_order_id uuid, p_station text, p_device_id text
)
returns void
language plpgsql security definer set search_path = public as $$
declare order_row public.orders%rowtype; device_hash_value text;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  device_hash_value := encode(extensions.digest(p_device_id, 'sha256'), 'hex');
  perform public.lock_open_order_event(p_order_id);
  select * into order_row from public.orders where id = p_order_id for update;
  if not found or order_row.status <> 'in_attesa_pagamento' or not exists (
    select 1 from public.order_claim_devices claims where claims.order_id = p_order_id
      and claims.station = p_station and claims.device_hash = device_hash_value and claims.expires_at > now()
  ) then raise exception 'claim_lost'; end if;
  perform public.apply_order_stock(order_row.items, '[]'::jsonb);
  update public.orders set status = 'annullato', cancelled_at = now(), alias = null, notes = null where id = p_order_id;
  delete from public.order_claim_devices where order_id = p_order_id;
end;
$$;
revoke execute on function public.cancel_order_for_station(uuid, text, text) from public;
grant execute on function public.cancel_order_for_station(uuid, text, text) to authenticated;

create or replace function public.fulfillment_station_allowed(p_station text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and (
      role = 'admin'
      or (role = 'cucina' and p_station in ('cucina', 'primi', 'secondi', 'contorni', 'dolci', 'furgone'))
      or (role = 'bar' and p_station in ('birre', 'drinks', 'bar'))
    )
  );
$$;
revoke execute on function public.fulfillment_station_allowed(text) from public, anon, authenticated;

-- All order mutations lock the event before the order, then delivery/stock rows.

create or replace function public.get_recent_fulfillment_deliveries(p_station text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  if not public.fulfillment_station_allowed(p_station) then raise exception 'not_authorized' using errcode = '42501'; end if;
  perform public.purge_completed_order_personal_data();
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', delivery.id, 'order_id', delivery.order_id,
    'display_number', orders_row.display_number, 'alias', orders_row.alias,
    'station', delivery.station, 'quantities', delivery.quantities,
    'created_at', delivery.created_at, 'can_undo', delivery.created_at > now() - interval '5 minutes'
  ) order by delivery.created_at desc), '[]'::jsonb) into result
  from public.fulfillment_deliveries delivery
  join public.orders orders_row on orders_row.id = delivery.order_id
  where delivery.station = p_station and delivery.reversed_at is null
    and delivery.created_at > now() - interval '30 minutes';
  return result;
end;
$$;
revoke execute on function public.get_recent_fulfillment_deliveries(text) from public;
grant execute on function public.get_recent_fulfillment_deliveries(text) to authenticated;

-- Gli ordini creati d'emergenza in cassa entrano sempre nelle code di ritiro.

-- I ruoli di evasione leggono gli ordini attivi tramite le RPC filtrate.
drop policy if exists "La cucina legge solo gli ordini pagati" on public.orders;
drop policy if exists "Le postazioni leggono gli ordini in preparazione" on public.orders;
create policy "Le postazioni leggono gli ordini in preparazione"
  on public.orders for select using (
    status in ('pagato', 'ritiro_parziale', 'consegnato')
    and exists (select 1 from public.profiles where id = auth.uid() and role in ('cucina', 'bar', 'admin'))
  );

-- Pulisce i vecchi claim; il nuovo flusso usa sessioni per dispositivo.
update public.orders set claimed_token_hash = null, claim_expires_at = null
where claimed_token_hash is not null or claim_expires_at is not null;

create or replace function public.close_order_event()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare event_row public.order_events%rowtype; report jsonb;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into event_row from public.order_events where is_current for update;
  if not found then raise exception 'no_event'; end if;
  if event_row.permanently_closed_at is not null then return public.get_order_event_report(); end if;

  -- Completa l'ordine globale dei lock evento -> ordini -> menu. Le altre RPC
  -- mutanti mantengono un lock condiviso sull'evento finché hanno finito.
  perform 1 from public.orders
  where event_id = event_row.id order by id for update;

  with reserved as (
    select (line->>'id')::uuid id, sum((line->>'qty')::integer)::integer qty
    from public.orders orders_row
    cross join lateral jsonb_array_elements(orders_row.items) line
    where orders_row.event_id = event_row.id and orders_row.status = 'in_attesa_pagamento'
    group by 1
  )
  update public.menu_items menu set
    stock_capacity = case
      when menu.available_portions is not null and menu.stock_capacity is not null
        then greatest(menu.stock_capacity, menu.available_portions + reserved.qty)
      else menu.stock_capacity end,
    available_portions = case
      when menu.available_portions is null then null else menu.available_portions + reserved.qty end
  from reserved where menu.id = reserved.id;

  select jsonb_build_object(
    'event_id', event_row.id,
    'event_name', event_row.name,
    'closed_at', now(),
    'summary', jsonb_build_object(
      'orders_total', count(*),
      'orders_paid', count(*) filter (where status in ('pagato', 'ritiro_parziale', 'consegnato')),
      'orders_cancelled', count(*) filter (where status = 'annullato'),
      'orders_abandoned', count(*) filter (where status = 'in_attesa_pagamento'),
      'revenue_total', coalesce(sum(total) filter (where status in ('pagato', 'ritiro_parziale', 'consegnato')), 0)
    ),
    'products', coalesce((
      select jsonb_agg(product order by product->>'name') from (
        select jsonb_build_object(
          'id', line->>'id', 'name', line->>'name', 'category', line->>'category',
          'quantity', sum((line->>'qty')::integer),
          'revenue', sum((line->>'qty')::integer * (line->>'price')::numeric)
        ) product
        from public.orders paid_order
        cross join lateral jsonb_array_elements(paid_order.items) line
        where paid_order.event_id = event_row.id and paid_order.status in ('pagato', 'ritiro_parziale', 'consegnato')
        group by line->>'id', line->>'name', line->>'category'
      ) products_rows
    ), '[]'::jsonb),
    'orders', coalesce(jsonb_agg(jsonb_build_object(
      'number', display_number, 'created_at', created_at, 'paid_at', paid_at,
      'status', case when status = 'in_attesa_pagamento' then 'abbandonato' else status end,
      'items', items, 'total', total
    ) order by display_number), '[]'::jsonb)
  ) into report from public.orders where event_id = event_row.id;

  update public.orders set
    report_status = case when status = 'in_attesa_pagamento' then 'abbandonato' else status end,
    status = case
      when status = 'in_attesa_pagamento' then 'annullato'
      when status in ('pagato', 'ritiro_parziale') then 'consegnato'
      else status end,
    cancelled_at = case when status = 'in_attesa_pagamento' then now() else cancelled_at end,
    delivered_at = case when status in ('pagato', 'ritiro_parziale') then now() else delivered_at end,
    completed_at = case when status in ('pagato', 'ritiro_parziale') then now() else completed_at end,
    alias = null, notes = null, qr_token_hash = null, client_request_id = null,
    claimed_token_hash = null, claim_expires_at = null
  where event_id = event_row.id;
  update public.order_events set permanently_closed_at = now(), manual_closed = true,
    final_report = report - 'orders' where id = event_row.id;
  return report;
end;
$$;

revoke execute on function public.close_order_event() from public;
grant execute on function public.close_order_event() to authenticated;

-- Abilita gli aggiornamenti live; il client mantiene anche un polling di sicurezza.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'order_fulfillment_items') then
    alter publication supabase_realtime add table public.order_fulfillment_items;
  end if;
end
$$;

-- Corregge riferimenti ambigui rilevati dal lint PostgreSQL.

create or replace function public.get_low_stock_items()
returns table (id uuid, name text, remaining integer, available integer)
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.profiles profile
    where profile.id = auth.uid() and profile.role in ('cucina', 'admin')
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

-- Retired APIs: frontend uses only station-based RPCs. Never re-grant these.
revoke execute on function public.claim_order(uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.claim_order_by_qr(text, text) from public, anon, authenticated, service_role;
revoke execute on function public.release_order_claim(uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.update_claimed_order(uuid, text, text, text, jsonb) from public, anon, authenticated, service_role;
revoke execute on function public.cancel_claimed_order(uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.pay_claimed_order(uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.deliver_order(uuid) from public, anon, authenticated, service_role;
revoke execute on function public.deliver_order_by_qr(text) from public, anon, authenticated, service_role;

create or replace function public.get_cashier_claims()
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
 if not exists(select 1 from public.profiles where id=auth.uid() and role in ('cassa','admin')) then
  raise exception 'not_authorized' using errcode='42501';
 end if;
 select coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb) into result from (
  select claims.order_id, min(claims.station) claimed_station, max(claims.expires_at) claim_expires_at
  from public.order_claim_devices claims join public.orders o on o.id=claims.order_id
  where claims.expires_at>now() and o.status='in_attesa_pagamento' group by claims.order_id
 ) c;
 return result;
end;
$$;
revoke execute on function public.get_cashier_claims() from public,anon;
grant execute on function public.get_cashier_claims() to authenticated;

alter table public.tournament_state add column if not exists revision bigint not null default 0;
create or replace function public.publish_tournament(p_expected_revision bigint,p_size integer,p_teams jsonb,p_matches jsonb,p_overrides jsonb)
returns bigint language plpgsql security definer set search_path=public as $$
declare next_revision bigint;
begin
 if not exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','tournament_manager')) then
  raise exception 'not_authorized' using errcode='42501';
 end if;
 if p_expected_revision is null then raise exception 'revision_required'; end if;
 update public.tournament_state set size=p_size,teams=p_teams,matches=p_matches,overrides=p_overrides,
  revision=revision+1,updated_at=now() where id='main' and revision=p_expected_revision returning revision into next_revision;
 if not found then raise exception 'tournament_conflict'; end if;
 return next_revision;
end;
$$;
revoke execute on function public.publish_tournament(bigint,integer,jsonb,jsonb,jsonb) from public,anon;
grant execute on function public.publish_tournament(bigint,integer,jsonb,jsonb,jsonb) to authenticated;
revoke insert,update,delete on public.tournament_state from anon,authenticated;

-- Full rows contain unnecessary cross-area data; staff use filtered RPCs.
drop policy if exists "La cucina legge solo gli ordini pagati" on public.orders;
drop policy if exists "Le postazioni leggono gli ordini in preparazione" on public.orders;
drop policy if exists "Admin leggono gli ordini operativi" on public.orders;
create policy "Admin leggono gli ordini operativi" on public.orders for select
 using (exists(select 1 from public.profiles where id=auth.uid() and role='admin'));

alter table public.push_broadcasts add column if not exists completed_at timestamptz default now();
alter table public.push_broadcasts add column if not exists lease_token uuid;
alter table public.push_broadcasts add column if not exists lease_until timestamptz;
create table if not exists public.push_broadcast_deliveries (
 broadcast_id uuid not null references public.push_broadcasts(id) on delete cascade,
 subscription_id uuid not null,
 status text not null default 'pending' check(status in ('pending','sending','sent','failed','unknown')),
 primary key(broadcast_id,subscription_id)
);
alter table public.push_broadcast_deliveries enable row level security;
revoke all on public.push_broadcast_deliveries from public,anon,authenticated;
create index if not exists push_delivery_pending_idx on public.push_broadcast_deliveries(broadcast_id,status);

create or replace function public.claim_push_broadcast(p_id uuid,p_sender uuid,p_kind text,p_title text,p_message text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare job public.push_broadcasts%rowtype; batch jsonb; lease uuid:=gen_random_uuid();
begin
 if not exists(select 1 from public.profiles where id=p_sender and
  (role='admin' or (role='tournament_manager' and p_kind='tournament') or (role='staff' and p_kind='announcement'))) then
  raise exception 'not_authorized' using errcode='42501';
 end if;
 perform pg_advisory_xact_lock(hashtext('lag_push_job_creation'));
 select * into job from public.push_broadcasts where id=p_id for update;
 if not found then
  if exists(select 1 from public.push_broadcasts where sent_by=p_sender and
   (completed_at is null or created_at>now()-interval '1 minute')) then raise exception 'broadcast_already_pending_or_rate_limited'; end if;
  insert into public.push_broadcasts(id,kind,title,message,sent_by,completed_at)
   values(p_id,p_kind,p_title,p_message,p_sender,null) returning * into job;
  insert into public.push_broadcast_deliveries(broadcast_id,subscription_id)
   select p_id,id from public.push_subscriptions;
  update public.push_broadcasts set subscriber_count=(select count(*) from public.push_broadcast_deliveries where broadcast_id=p_id)
   where id=p_id returning * into job;
 end if;
 if job.sent_by is distinct from p_sender or job.kind<>p_kind or job.title<>p_title or job.message<>p_message then raise exception 'broadcast_conflict'; end if;
 if job.completed_at is not null then return jsonb_build_object('completed',true,'batch','[]'::jsonb,'subscribers',job.subscriber_count,'sent',job.success_count,'failed',job.failure_count); end if;
 if job.lease_until>now() then raise exception 'broadcast_busy'; end if;
 -- Never blindly resend an interrupted attempt: its delivery may already have succeeded.
 update public.push_broadcast_deliveries set status='unknown' where broadcast_id=p_id and status='sending';
 with next_batch as (
  select subscription_id from public.push_broadcast_deliveries where broadcast_id=p_id and status='pending'
   order by subscription_id limit 25 for update
 ), claimed as (
  update public.push_broadcast_deliveries d set status='sending' from next_batch n
   where d.broadcast_id=p_id and d.subscription_id=n.subscription_id returning d.subscription_id
 )
 select coalesce(jsonb_agg(jsonb_build_object('id',c.subscription_id,'endpoint',s.endpoint,'p256dh',s.p256dh,'auth',s.auth)),'[]'::jsonb)
 into batch from claimed c left join public.push_subscriptions s on s.id=c.subscription_id;
 update public.push_broadcasts set lease_token=lease,lease_until=now()+interval '90 seconds' where id=p_id;
 return jsonb_build_object('completed',false,'batch',batch,'lease',lease,'subscribers',job.subscriber_count);
end;
$$;
revoke execute on function public.claim_push_broadcast(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.claim_push_broadcast(uuid,uuid,text,text,text) to service_role;

create or replace function public.finish_push_batch(p_id uuid,p_lease uuid,p_results jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare job public.push_broadcasts%rowtype; sent integer; failed integer; uncertain integer; remaining integer;
begin
 select * into job from public.push_broadcasts where id=p_id for update;
 if not found or job.lease_token is distinct from p_lease then raise exception 'broadcast_lease_lost'; end if;
 update public.push_broadcast_deliveries d set status=case when (r->>'delivered')::boolean then 'sent' else 'failed' end
 from jsonb_array_elements(p_results) r where d.broadcast_id=p_id and d.subscription_id=(r->>'id')::uuid and d.status='sending';
 select count(*) filter(where status='sent'), count(*) filter(where status in ('failed','unknown')),
  count(*) filter(where status='unknown'),count(*) filter(where status in ('pending','sending'))
 into sent,failed,uncertain,remaining from public.push_broadcast_deliveries where broadcast_id=p_id;
 update public.push_broadcasts set success_count=sent,failure_count=failed,lease_until=null,
  completed_at=case when remaining=0 then now() else null end where id=p_id;
 return jsonb_build_object('broadcast_id',p_id,'completed',remaining=0,'subscribers',job.subscriber_count,'sent',sent,'failed',failed,'uncertain',uncertain,'removed',0);
end;
$$;
revoke execute on function public.finish_push_batch(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.finish_push_batch(uuid,uuid,jsonb) to service_role;

create or replace function public.get_my_pending_push_broadcast()
returns jsonb language sql security definer set search_path=public as $$
 select to_jsonb(j) - 'lease_token' - 'lease_until' from public.push_broadcasts j
 where j.sent_by=auth.uid() and j.completed_at is null order by j.created_at desc limit 1;
$$;
revoke execute on function public.get_my_pending_push_broadcast() from public,anon;
grant execute on function public.get_my_pending_push_broadcast() to authenticated;

create or replace function public.recover_order_history(p_token text,p_before uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare token_hash text; result jsonb;
begin
 if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' then raise exception 'invalid_recovery_token'; end if;
 token_hash:=encode(extensions.digest(p_token,'sha256'),'hex');
 perform public.expire_unpaid_orders();
 perform public.purge_completed_order_personal_data();
 select coalesce(jsonb_agg(to_jsonb(page) order by page.created_at desc,page.order_id desc),'[]'::jsonb) into result from (
  select o.id order_id,o.event_id,e.name event_name,o.display_number,coalesce(o.alias,'Ordine #'||o.display_number) alias,o.notes,o.items,o.total,o.status,o.created_at,
    public.recovery_order_qr(p_token,o.recovery_request_id) qr_token,e.permanently_closed_at event_closed_at
  from public.orders o join public.order_events e on e.id=o.event_id
  where o.recovery_token_hash=token_hash and o.recovery_request_id is not null
    and (p_before is null or (o.created_at,o.id)<(select created_at,id from public.orders where id=p_before and recovery_token_hash=token_hash))
  order by o.created_at desc,o.id desc limit 50
 ) page;
 return result;
end;
$$;
revoke execute on function public.recover_order_history(text,uuid) from public;
grant execute on function public.recover_order_history(text,uuid) to anon,authenticated;

-- The public Edge function validates a single-use Turnstile proof before this RPC.

revoke execute on function public.upsert_push_subscription(text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.upsert_push_subscription(text,text,text,text,text) to service_role;
create or replace function public.has_push_subscription(p_endpoint text,p_auth text)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.push_subscriptions where endpoint=p_endpoint and auth=p_auth);
$$;
revoke execute on function public.has_push_subscription(text,text) from public;
grant execute on function public.has_push_subscription(text,text) to anon,authenticated;

-- Deferred preparation and shared kitchen admission (100 slots).

alter table public.orders add column if not exists preparation_mode text not null default 'immediate' check(preparation_mode in ('immediate','deferred'));
alter table public.orders add column if not exists kitchen_state text not null default 'none' check(kitchen_state in ('none','reserved','dormant','waiting','active','done'));
alter table public.orders add column if not exists kitchen_requested_at timestamptz;
alter table public.orders add column if not exists kitchen_started_at timestamptz;
create index if not exists orders_kitchen_queue_idx on public.orders(event_id,kitchen_state,kitchen_requested_at,id);
-- Existing paid food orders keep their place; nothing is cancelled during upgrade.
update public.orders o set kitchen_state='active',kitchen_requested_at=paid_at,kitchen_started_at=paid_at
where kitchen_state='none' and status in ('pagato','ritiro_parziale')
and exists(select 1 from public.order_fulfillment_items f where f.order_id=o.id and f.category='cibo' and f.delivered_quantity<f.quantity);

create or replace function public.kitchen_occupied(p_event_id uuid,p_exclude uuid default null)
returns integer language sql stable security definer set search_path=public as $$
 select count(*)::integer from public.orders o where o.event_id=p_event_id
 and (p_exclude is null or o.id<>p_exclude)
 and ((o.kitchen_state='active' and o.status in ('pagato','ritiro_parziale')
       and exists(select 1 from public.order_fulfillment_items f where f.order_id=o.id and f.category='cibo' and f.delivered_quantity<f.quantity))
   or (o.kitchen_state='reserved' and o.status='in_attesa_pagamento'
       and exists(select 1 from public.order_claim_devices c where c.order_id=o.id and c.expires_at>now())));
$$;
revoke execute on function public.kitchen_occupied(uuid,uuid) from public,anon,authenticated;

create or replace function public.promote_kitchen_waiting(p_event_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare free_slots integer;
begin
 if not exists(select 1 from public.orders where event_id=p_event_id and kitchen_state='waiting' and status in ('pagato','ritiro_parziale')) then return; end if;
 perform 1 from public.order_events where id=p_event_id and is_current and permanently_closed_at is null for update;
 if not found then return; end if;
 free_slots:=greatest(0,100-public.kitchen_occupied(p_event_id));
 if free_slots=0 then return; end if;
 update public.orders set kitchen_state='active',kitchen_started_at=now()
 where id in (select id from public.orders where event_id=p_event_id and kitchen_state='waiting'
   and status in ('pagato','ritiro_parziale') order by kitchen_requested_at,id limit free_slots for update);
end;
$$;
revoke execute on function public.promote_kitchen_waiting(uuid) from public,anon,authenticated;

create or replace function public.set_order_preparation(p_order_id uuid,p_station text,p_device_id text,p_mode text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare target public.orders%rowtype; has_food boolean;
begin
 if not exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','cassa')) then
  raise exception 'not_authorized' using errcode='42501'; end if;
 if p_mode is null or p_mode not in ('immediate','deferred') then raise exception 'invalid_preparation_mode'; end if;
 perform public.lock_open_order_event(p_order_id);
 select * into target from public.orders where id=p_order_id for update;
 if not found or target.status<>'in_attesa_pagamento' or not exists(select 1 from public.order_claim_devices
   where order_id=p_order_id and station=p_station and device_hash=encode(extensions.digest(p_device_id,'sha256'),'hex') and expires_at>now())
 then raise exception 'claim_lost'; end if;
 has_food:=exists(select 1 from jsonb_array_elements(target.items) i where i->>'category'='cibo');
 -- Preserve an already reserved slot; new reservations follow paid customers waiting.
 perform public.promote_kitchen_waiting(target.event_id);
 update public.orders set preparation_mode=case when has_food then p_mode else 'immediate' end,
  kitchen_state=case when not has_food then 'none' when p_mode='deferred' then 'dormant'
    when public.kitchen_occupied(target.event_id,p_order_id)<100 then 'reserved' else 'none' end
 where id=p_order_id returning * into target;
 return to_jsonb(target)-'qr_token_hash'-'claimed_token_hash'-'client_request_id'-'recovery_token_hash'-'recovery_request_id';
end;
$$;
revoke execute on function public.set_order_preparation(uuid,text,text,text) from public;
grant execute on function public.set_order_preparation(uuid,text,text,text) to authenticated;

create or replace function public.activate_kitchen_order(p_order_id uuid,p_station text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare target public.orders%rowtype;
begin
 if p_station is null or p_station not in ('cucina','primi','secondi','contorni','dolci','furgone') or not public.fulfillment_station_allowed(p_station)
 then raise exception 'not_authorized' using errcode='42501'; end if;
 perform public.lock_open_order_event(p_order_id);
 select * into target from public.orders where id=p_order_id for update;
 if not found or target.status not in ('pagato','ritiro_parziale') or not exists(
   select 1 from public.order_fulfillment_items where order_id=p_order_id and category='cibo'
   and delivered_quantity<quantity and (p_station='cucina' or station=p_station))
 then raise exception 'order_not_available'; end if;
 if target.kitchen_state='dormant' then
   update public.orders set kitchen_state='waiting',kitchen_requested_at=clock_timestamp() where id=p_order_id;
 end if;
 perform public.promote_kitchen_waiting(target.event_id);
 select * into target from public.orders where id=p_order_id;
 return jsonb_build_object('order_id',target.id,'kitchen_state',target.kitchen_state);
end;
$$;
revoke execute on function public.activate_kitchen_order(uuid,text) from public;
grant execute on function public.activate_kitchen_order(uuid,text) to authenticated;

create or replace function public.reconcile_kitchen_order(p_order_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare target public.orders%rowtype;
begin
 select * into target from public.orders where id=p_order_id;
 if not exists(select 1 from public.order_fulfillment_items where order_id=p_order_id and category='cibo') then return; end if;
 if not exists(select 1 from public.order_fulfillment_items where order_id=p_order_id and category='cibo' and delivered_quantity<quantity) then
   update public.orders set kitchen_state='done' where id=p_order_id;
 elsif target.kitchen_state='done' then
   -- An undo restores quantities but cannot overfill the kitchen.
   update public.orders set kitchen_state='waiting',kitchen_requested_at=clock_timestamp(),kitchen_started_at=null where id=p_order_id;
 end if;
 perform public.promote_kitchen_waiting(target.event_id);
end;
$$;
revoke execute on function public.reconcile_kitchen_order(uuid) from public,anon,authenticated;

drop function if exists public.submit_public_order(text,text,jsonb,uuid,text,text,uuid,text);
drop function if exists public.create_counter_order(text,text,jsonb);
create or replace function public.lock_open_order_event(p_order_id uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  perform 1 from public.order_events e join public.orders o on o.event_id=e.id
    where o.id=p_order_id and e.is_current and e.permanently_closed_at is null for update of e;
  if not found then raise exception 'event_closed'; end if;
end;
$$;
revoke execute on function public.lock_open_order_event(uuid) from public,anon,authenticated;

create or replace function public.submit_public_order(
  p_alias text,
  p_notes text,
  p_items jsonb,
  p_client_request_id uuid,
  p_qr_token text,
  p_bot_field text default '',
  p_expected_event_id uuid default null,
  p_recovery_token text default null,
  p_preparation_mode text default 'immediate'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  event_row public.order_events%rowtype;
  existing_order public.orders%rowtype;
  normalized jsonb;
  calculated_total numeric;
  next_number bigint;
  pending_count integer;
begin
  if p_preparation_mode is null or p_preparation_mode not in ('immediate','deferred') then raise exception 'invalid_preparation_mode'; end if;
  if p_recovery_token is not null and (p_recovery_token !~ '^[A-Za-z0-9_-]{43}$'
    or p_qr_token is distinct from public.recovery_order_qr(p_recovery_token,p_client_request_id)) then
    raise exception 'invalid_recovery_token';
  end if;
  if coalesce(p_bot_field, '') <> '' then raise exception 'invalid_request'; end if;
  if p_alias is null or length(btrim(p_alias)) not between 2 and 32
    or btrim(p_alias) !~ '^[[:alnum:]][[:alnum:] _-]*$' then
    raise exception 'invalid_alias';
  end if;
  if length(coalesce(p_notes, '')) > 300 then raise exception 'notes_too_long'; end if;
  if p_client_request_id is null then raise exception 'invalid_client_request_id'; end if;
  if p_qr_token is null or length(p_qr_token) not between 32 and 80 then raise exception 'invalid_qr_token'; end if;

  perform public.expire_unpaid_orders();

  select * into event_row from public.order_events where is_current for no key update;
  if not found then raise exception 'no_event'; end if;
  if p_expected_event_id is not null and p_expected_event_id <> event_row.id then raise exception 'event_changed'; end if;

  select * into existing_order from public.orders
  where event_id = event_row.id and client_request_id = p_client_request_id;
  if found then
    if existing_order.qr_token_hash is distinct from encode(extensions.digest(p_qr_token, 'sha256'), 'hex') then
      raise exception 'request_id_conflict';
    end if;
    return jsonb_build_object(
      'event_id', event_row.id, 'event_name', event_row.name,
      'order_id', existing_order.id, 'display_number', existing_order.display_number,
      'status', existing_order.status, 'alias', existing_order.alias, 'notes', existing_order.notes,
      'preparation_mode',existing_order.preparation_mode,'kitchen_state',existing_order.kitchen_state,
      'items', existing_order.items, 'total', existing_order.total, 'qr_token', p_qr_token
    );
  end if;

  if event_row.permanently_closed_at is not null then raise exception 'event_closed'; end if;
  if event_row.manual_closed then raise exception 'ordering_paused'; end if;
  if now() < event_row.opens_at then raise exception 'not_open_yet'; end if;
  if now() > event_row.closes_at then raise exception 'ordering_closed'; end if;
  select count(*) into pending_count from public.orders
    where event_id = event_row.id and status = 'in_attesa_pagamento';
  if pending_count >= event_row.max_pending_orders then raise exception 'capacity_reached'; end if;

  -- The event lock already serializes creation. Retry lookup above does not consume this limit.
  if p_recovery_token is not null and (select count(*) from public.orders
      where recovery_token_hash = encode(extensions.digest(p_recovery_token,'sha256'),'hex')
        and created_at > now() - interval '1 minute') >= 3 then
    raise exception 'public_order_rate_limit';
  end if;

  normalized := public.normalize_order_items(p_items);
  if exists (select 1 from jsonb_array_elements(normalized) line where (line->>'qty')::integer > 25)
    or (select sum((line->>'qty')::integer) from jsonb_array_elements(normalized) line) > 60 then
    raise exception 'public_order_quantity_limit';
  end if;
  select sum((line->>'price')::numeric * (line->>'qty')::integer)
    into calculated_total from jsonb_array_elements(normalized) line;
  if calculated_total > 99999.99 then raise exception 'order_total_too_high'; end if;
  perform public.apply_order_stock('[]'::jsonb, normalized);
  select coalesce(max(display_number), 0) + 1 into next_number
    from public.orders where event_id = event_row.id;

  insert into public.orders (
    event_id, display_number, alias, notes, items, total, status,
    qr_token_hash, client_request_id, recovery_token_hash, recovery_request_id, preparation_mode
  ) values (
    event_row.id, next_number, btrim(p_alias), nullif(btrim(coalesce(p_notes, '')), ''),
    normalized, calculated_total::numeric(7,2), 'in_attesa_pagamento',
    encode(extensions.digest(p_qr_token, 'sha256'), 'hex'), p_client_request_id,
    case when p_recovery_token is not null then encode(extensions.digest(p_recovery_token,'sha256'),'hex') end,
    case when p_recovery_token is not null then p_client_request_id end,
    case when exists(select 1 from jsonb_array_elements(normalized) i where i->>'category'='cibo') then p_preparation_mode else 'immediate' end
  ) returning id into existing_order.id;

  return jsonb_build_object(
    'event_id', event_row.id, 'event_name', event_row.name,
    'order_id', existing_order.id, 'display_number', next_number,
    'status', 'in_attesa_pagamento', 'alias', btrim(p_alias), 'notes', nullif(btrim(coalesce(p_notes, '')), ''),
    'preparation_mode',p_preparation_mode,'kitchen_state','none',
    'items', normalized, 'total', calculated_total, 'qr_token', p_qr_token
  );
end;
$$;

create or replace function public.claim_order_for_station(
  p_order_id uuid, p_station text, p_device_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare order_row public.orders%rowtype; device_hash_value text; active_station text;
begin
  if not exists (select 1 from public.profiles profile where profile.id = auth.uid() and profile.role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_station !~ '^cassa_[1-5]$' then raise exception 'invalid_station'; end if;
  if p_device_id is null or length(p_device_id) not between 32 and 80 then raise exception 'invalid_device'; end if;
  perform 1 from public.order_events e join public.orders o on o.event_id=e.id
    where o.id=p_order_id and e.permanently_closed_at is null for update of e;
  if not found then raise exception 'event_closed'; end if;
  device_hash_value := encode(extensions.digest(p_device_id, 'sha256'), 'hex');
  delete from public.order_claim_devices where expires_at <= now();
  select * into order_row from public.orders where id = p_order_id for update;
  if not found or order_row.status <> 'in_attesa_pagamento' then raise exception 'order_not_available'; end if;
  if order_row.created_at <= now()-interval '60 minutes' and not exists (
    select 1 from public.order_claim_devices c where c.order_id=p_order_id and c.expires_at>now()
  ) then raise exception 'reservation_expired'; end if;
  select claims.station into active_station from public.order_claim_devices claims
    where claims.order_id = p_order_id and claims.expires_at > now() limit 1;
  if active_station is not null and active_station <> p_station then raise exception 'order_already_claimed'; end if;
  insert into public.order_claim_devices (order_id, station, device_hash, expires_at)
    values (p_order_id, p_station, device_hash_value, now() + interval '30 seconds')
    on conflict (order_id, device_hash) do update
      set station = excluded.station, expires_at = excluded.expires_at;
  perform public.set_order_preparation(p_order_id,p_station,p_device_id,order_row.preparation_mode);
  select * into order_row from public.orders where id=p_order_id;
  return (to_jsonb(order_row) - 'qr_token_hash' - 'claimed_token_hash' - 'client_request_id')
    || jsonb_build_object('claimed_station', p_station, 'claim_expires_at', now() + interval '30 seconds');
end;
$$;
revoke execute on function public.claim_order_for_station(uuid, text, text) from public;
grant execute on function public.claim_order_for_station(uuid, text, text) to authenticated;

create or replace function public.pay_order_for_station(
  p_order_id uuid, p_station text, p_device_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare order_row public.orders%rowtype; event_row public.order_events%rowtype; device_hash_value text;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  device_hash_value := encode(extensions.digest(p_device_id, 'sha256'), 'hex');
  select event.* into event_row from public.order_events event
    join public.orders target on target.event_id = event.id
    where target.id = p_order_id for update of event;
  if not found or event_row.permanently_closed_at is not null then raise exception 'event_closed'; end if;
  select * into order_row from public.orders where id = p_order_id for update;
  if not found or order_row.status <> 'in_attesa_pagamento' or not exists (
    select 1 from public.order_claim_devices claims where claims.order_id = p_order_id
      and claims.station = p_station and claims.device_hash = device_hash_value and claims.expires_at > now()
  ) then raise exception 'claim_lost'; end if;
  perform public.promote_kitchen_waiting(order_row.event_id);
  if order_row.preparation_mode='immediate' and exists(select 1 from jsonb_array_elements(order_row.items) i where i->>'category'='cibo')
    and public.kitchen_occupied(order_row.event_id,p_order_id)>=100 then raise exception 'kitchen_capacity_reached'; end if;
  perform public.seed_order_fulfillment(order_row.id, order_row.items);
  update public.orders set kitchen_state=case when not exists(select 1 from jsonb_array_elements(order_row.items) i where i->>'category'='cibo') then 'none' when order_row.preparation_mode='deferred' then 'dormant' else 'active' end,
    kitchen_requested_at=case when order_row.preparation_mode='immediate' then clock_timestamp() end,
    kitchen_started_at=case when order_row.preparation_mode='immediate' then clock_timestamp() end,
    status = 'pagato', paid_at = now(), delivered_at = null,
    completed_at = null, claimed_token_hash = null, claim_expires_at = null
    where id = p_order_id returning * into order_row;
  delete from public.order_claim_devices where order_id = p_order_id;
  return to_jsonb(order_row) - 'qr_token_hash' - 'claimed_token_hash' - 'client_request_id';
end;
$$;
revoke execute on function public.pay_order_for_station(uuid, text, text) from public;
grant execute on function public.pay_order_for_station(uuid, text, text) to authenticated;

create or replace function public.create_counter_order(p_alias text, p_notes text, p_items jsonb, p_preparation_mode text default 'immediate')
returns jsonb language plpgsql security definer set search_path = public as $$
declare event_row public.order_events%rowtype; normalized jsonb; calculated_total numeric;
  next_number bigint; created_order public.orders%rowtype;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('cassa', 'admin')) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_preparation_mode is null or p_preparation_mode not in ('immediate','deferred') then raise exception 'invalid_preparation_mode'; end if;
  if p_alias is null or length(btrim(p_alias)) not between 2 and 32 then raise exception 'invalid_alias'; end if;
  if length(coalesce(p_notes, '')) > 300 then raise exception 'notes_too_long'; end if;
  select * into event_row from public.order_events where is_current for update;
  if not found or event_row.permanently_closed_at is not null then raise exception 'event_closed'; end if;
  normalized := public.normalize_order_items(p_items);
  perform public.promote_kitchen_waiting(event_row.id);
  if p_preparation_mode='immediate' and exists(select 1 from jsonb_array_elements(normalized) i where i->>'category'='cibo')
    and public.kitchen_occupied(event_row.id)>=100 then raise exception 'kitchen_capacity_reached'; end if;
  perform public.apply_order_stock('[]'::jsonb, normalized);
  select sum((line->>'price')::numeric * (line->>'qty')::integer)
    into calculated_total from jsonb_array_elements(normalized) line;
  select coalesce(max(display_number), 0) + 1 into next_number from public.orders where event_id = event_row.id;
  insert into public.orders (event_id, display_number, alias, notes, items, total, status, paid_at, preparation_mode)
    values (event_row.id, next_number, btrim(p_alias), nullif(btrim(coalesce(p_notes, '')), ''),
      normalized, calculated_total::numeric(7,2), 'pagato', now(), p_preparation_mode) returning * into created_order;
  perform public.seed_order_fulfillment(created_order.id, created_order.items);
  update public.orders set kitchen_state=case when not exists(select 1 from public.order_fulfillment_items where order_id=created_order.id and category='cibo') then 'none'
    when p_preparation_mode='deferred' then 'dormant' else 'active' end,
    kitchen_requested_at=case when p_preparation_mode='immediate' then clock_timestamp() end,
    kitchen_started_at=case when p_preparation_mode='immediate' then clock_timestamp() end
    where id=created_order.id returning * into created_order;
  return to_jsonb(created_order) - 'qr_token_hash' - 'claimed_token_hash' - 'client_request_id';
end;
$$;

create or replace function public.get_fulfillment_queue(p_station text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  if not public.fulfillment_station_allowed(p_station) then raise exception 'not_authorized' using errcode = '42501'; end if;
  perform public.promote_kitchen_waiting(id) from public.order_events where is_current and permanently_closed_at is null;
  perform public.purge_completed_order_personal_data();
  select coalesce(jsonb_agg(order_payload order by kitchen_started_at nulls last, paid_at, display_number), '[]'::jsonb) into result
  from (
    select orders_row.id, orders_row.display_number, orders_row.alias, orders_row.notes,
      orders_row.paid_at, orders_row.status, orders_row.kitchen_state, orders_row.kitchen_started_at,
      jsonb_agg(jsonb_build_object(
        'id', fulfillment.menu_item_id, 'name', fulfillment.name,
        'subcategory', fulfillment.subcategory, 'station', fulfillment.station,
        'quantity', fulfillment.quantity, 'delivered_quantity', fulfillment.delivered_quantity
      ) order by fulfillment.subcategory, fulfillment.name) as items
    from public.orders orders_row
    join public.order_fulfillment_items fulfillment on fulfillment.order_id = orders_row.id
    where orders_row.status in ('pagato', 'ritiro_parziale')
      and (fulfillment.category<>'cibo' or orders_row.kitchen_state='active')
      and fulfillment.delivered_quantity < fulfillment.quantity
      and (case when p_station = 'cucina' then fulfillment.category = 'cibo' else fulfillment.station = p_station end)
    group by orders_row.id
  ) order_payload;
  return result;
end;
$$;
revoke execute on function public.get_fulfillment_queue(text) from public;
grant execute on function public.get_fulfillment_queue(text) to authenticated;

create or replace function public.get_fulfillment_order_by_qr(p_qr_token text, p_station text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  if not public.fulfillment_station_allowed(p_station) then raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_qr_token is null or length(p_qr_token) not between 32 and 80 then raise exception 'invalid_qr_token'; end if;
  select jsonb_build_object(
    'id', orders_row.id, 'display_number', orders_row.display_number,
    'alias', orders_row.alias, 'notes', orders_row.notes, 'paid_at', orders_row.paid_at,
    'status', orders_row.status, 'kitchen_state',orders_row.kitchen_state,
    'items', jsonb_agg(jsonb_build_object(
      'id', fulfillment.menu_item_id, 'name', fulfillment.name,
      'subcategory', fulfillment.subcategory, 'station', fulfillment.station,
      'quantity', fulfillment.quantity, 'delivered_quantity', fulfillment.delivered_quantity
    ) order by fulfillment.name)
  ) into result
  from public.orders orders_row
  join public.order_fulfillment_items fulfillment on fulfillment.order_id = orders_row.id
  where orders_row.qr_token_hash = encode(extensions.digest(p_qr_token, 'sha256'), 'hex')
    and orders_row.status in ('pagato', 'ritiro_parziale')
    and fulfillment.delivered_quantity < fulfillment.quantity
    and (case when p_station = 'cucina' then fulfillment.category = 'cibo' else fulfillment.station = p_station end)
  group by orders_row.id;
  if result is null then raise exception 'order_not_available'; end if;
  return result;
end;
$$;
revoke execute on function public.get_fulfillment_order_by_qr(text, text) from public;
grant execute on function public.get_fulfillment_order_by_qr(text, text) to authenticated;

create or replace function public.deliver_fulfillment_items(
  p_order_id uuid, p_station text, p_items jsonb
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare order_row public.orders%rowtype; normalized jsonb; delivery_id uuid;
  total_quantity integer; total_delivered integer;
begin
  if p_station = 'cucina' or not public.fulfillment_station_allowed(p_station) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'invalid_delivery';
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) item
    where coalesce(item->>'id', '') !~* '^[0-9a-f-]{36}$'
      or coalesce(item->>'qty', '') !~ '^[1-9][0-9]*$') then raise exception 'invalid_delivery'; end if;
  perform public.lock_open_order_event(p_order_id);
  select * into order_row from public.orders where id = p_order_id for update;
  if not found or order_row.status not in ('pagato', 'ritiro_parziale') then raise exception 'order_not_available'; end if;

  if p_station in ('primi','secondi','contorni','dolci','furgone') and order_row.kitchen_state<>'active'
    then raise exception 'kitchen_not_active'; end if;
  with requested as (
    select (item->>'id')::uuid id, sum((item->>'qty')::integer)::integer qty
    from jsonb_array_elements(p_items) item group by 1
  )
  select jsonb_agg(jsonb_build_object('id', requested.id, 'qty', requested.qty)) into normalized
  from requested join public.order_fulfillment_items fulfillment
    on fulfillment.order_id = p_order_id and fulfillment.menu_item_id = requested.id
  where fulfillment.station = p_station and requested.qty <= fulfillment.quantity - fulfillment.delivered_quantity;
  if normalized is null or jsonb_array_length(normalized) <> (
    select count(distinct item->>'id') from jsonb_array_elements(p_items) item
  ) then raise exception 'invalid_delivery_quantity'; end if;

  update public.order_fulfillment_items fulfillment
  set delivered_quantity = fulfillment.delivered_quantity + requested.qty
  from (select (item->>'id')::uuid id, (item->>'qty')::integer qty
    from jsonb_array_elements(normalized) item) requested
  where fulfillment.order_id = p_order_id and fulfillment.menu_item_id = requested.id;

  insert into public.fulfillment_deliveries (order_id, station, quantities, delivered_by)
    values (p_order_id, p_station, normalized, auth.uid()) returning id into delivery_id;
  select sum(quantity), sum(delivered_quantity) into total_quantity, total_delivered
    from public.order_fulfillment_items where order_id = p_order_id;
  update public.orders set
    status = case when total_delivered >= total_quantity then 'consegnato' else 'ritiro_parziale' end,
    delivered_at = case when total_delivered >= total_quantity then now() else null end,
    completed_at = case when total_delivered >= total_quantity then now() else null end
    where id = p_order_id;
  perform public.reconcile_kitchen_order(p_order_id);
  return jsonb_build_object('delivery_id', delivery_id,
    'status', case when total_delivered >= total_quantity then 'consegnato' else 'ritiro_parziale' end);
end;
$$;
revoke execute on function public.deliver_fulfillment_items(uuid, text, jsonb) from public;
grant execute on function public.deliver_fulfillment_items(uuid, text, jsonb) to authenticated;

create or replace function public.undo_fulfillment_delivery(p_delivery_id uuid, p_station text)
returns void language plpgsql security definer set search_path = public as $$
declare delivery_row public.fulfillment_deliveries%rowtype; user_role text;
begin
  select role into user_role from public.profiles where id = auth.uid();
  if not coalesce(user_role in ('admin','cucina','bar'),false) then
    raise exception 'not_authorized' using errcode='42501';
  end if;
  select * into delivery_row from public.fulfillment_deliveries where id=p_delivery_id;
  if not found then raise exception 'delivery_not_available'; end if;
  perform public.lock_open_order_event(delivery_row.order_id);
  perform 1 from public.orders where id=delivery_row.order_id for update;
  select * into delivery_row from public.fulfillment_deliveries where id=p_delivery_id for update;
  if not found or delivery_row.reversed_at is not null then raise exception 'delivery_not_available'; end if;
  if user_role <> 'admin' and (
    not coalesce(public.fulfillment_station_allowed(p_station),false)
    or delivery_row.station is distinct from p_station
    or delivery_row.created_at <= now()-interval '5 minutes'
  ) then raise exception 'undo_window_expired'; end if;
  update public.order_fulfillment_items fulfillment
  set delivered_quantity = greatest(0, fulfillment.delivered_quantity - requested.qty)
  from (select (item->>'id')::uuid id, (item->>'qty')::integer qty
    from jsonb_array_elements(delivery_row.quantities) item) requested
  where fulfillment.order_id = delivery_row.order_id and fulfillment.menu_item_id = requested.id;
  update public.fulfillment_deliveries set reversed_at = now(), reversed_by = auth.uid()
    where id = p_delivery_id;
  update public.orders set status = case when exists (
      select 1 from public.order_fulfillment_items where order_id = delivery_row.order_id and delivered_quantity > 0
    ) then 'ritiro_parziale' else 'pagato' end,
    delivered_at = null, completed_at = null where id = delivery_row.order_id;
  perform public.reconcile_kitchen_order(delivery_row.order_id);
end;
$$;
revoke execute on function public.undo_fulfillment_delivery(uuid, text) from public;
grant execute on function public.undo_fulfillment_delivery(uuid, text) to authenticated;

create or replace function public.get_public_order_statuses(p_qr_tokens text[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  if p_qr_tokens is null or cardinality(p_qr_tokens) < 1 or cardinality(p_qr_tokens) > 50 then
    raise exception 'invalid_qr_tokens';
  end if;
  if exists (select 1 from unnest(p_qr_tokens) token
    where token is null or length(token) not between 32 and 80) then raise exception 'invalid_qr_tokens'; end if;
  perform public.expire_unpaid_orders();
  perform public.purge_completed_order_personal_data();
  select coalesce(jsonb_agg(jsonb_build_object(
    'order_id', orders_row.id, 'status', orders_row.status,
    'preparation_mode',orders_row.preparation_mode,'kitchen_state',orders_row.kitchen_state,
    'progress', coalesce(progress.payload, '[]'::jsonb)
  )), '[]'::jsonb) into result
  from public.orders orders_row
  left join lateral (
    select jsonb_agg(jsonb_build_object(
      'station', station, 'quantity', quantity, 'delivered', delivered
    ) order by station) payload
    from (select station, sum(quantity)::integer quantity,
      sum(delivered_quantity)::integer delivered
      from public.order_fulfillment_items where order_id = orders_row.id group by station) grouped
  ) progress on true
  where orders_row.qr_token_hash in (
    select encode(extensions.digest(token, 'sha256'), 'hex') from unnest(p_qr_tokens) token
  );
  return result;
end;
$$;
revoke execute on function public.get_public_order_statuses(text[]) from public;
grant execute on function public.get_public_order_statuses(text[]) to anon, authenticated;
revoke execute on function public.submit_public_order(text,text,jsonb,uuid,text,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.submit_public_order(text,text,jsonb,uuid,text,text,uuid,text,text) to service_role;
revoke execute on function public.create_counter_order(text,text,jsonb,text) from public;
grant execute on function public.create_counter_order(text,text,jsonb,text) to authenticated;
create or replace function public.get_fulfillment_order_by_number(p_display_number integer, p_station text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  if not public.fulfillment_station_allowed(p_station) then raise exception 'not_authorized' using errcode = '42501'; end if;
  if p_display_number is null or p_display_number<1 then raise exception 'invalid_order_number'; end if;
  select jsonb_build_object(
    'id', orders_row.id, 'display_number', orders_row.display_number,
    'alias', orders_row.alias, 'notes', orders_row.notes, 'paid_at', orders_row.paid_at,
    'status', orders_row.status, 'kitchen_state',orders_row.kitchen_state,
    'items', jsonb_agg(jsonb_build_object(
      'id', fulfillment.menu_item_id, 'name', fulfillment.name,
      'subcategory', fulfillment.subcategory, 'station', fulfillment.station,
      'quantity', fulfillment.quantity, 'delivered_quantity', fulfillment.delivered_quantity
    ) order by fulfillment.name)
  ) into result
  from public.orders orders_row
  join public.order_fulfillment_items fulfillment on fulfillment.order_id = orders_row.id
  where orders_row.display_number=p_display_number and orders_row.event_id=(select id from public.order_events where is_current and permanently_closed_at is null)
    and orders_row.status in ('pagato', 'ritiro_parziale')
    and fulfillment.delivered_quantity < fulfillment.quantity
    and (case when p_station = 'cucina' then fulfillment.category = 'cibo' else fulfillment.station = p_station end)
  group by orders_row.id;
  if result is null then raise exception 'order_not_available'; end if;
  return result;
end;
$$;
revoke execute on function public.get_fulfillment_order_by_number(integer,text) from public;
grant execute on function public.get_fulfillment_order_by_number(integer,text) to authenticated;

commit;
