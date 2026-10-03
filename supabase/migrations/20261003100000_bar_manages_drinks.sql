begin;

-- Il bar gestisce le bevande (scorte, prezzi, prodotti) ma non può toccare né
-- spostare in cucina i piatti: ogni riga resta nella categoria "bevande".
drop policy if exists "Il bar scrive le bevande" on public.menu_items;
drop policy if exists "Il bar modifica le bevande" on public.menu_items;
drop policy if exists "Il bar elimina le bevande" on public.menu_items;
create policy "Il bar scrive le bevande"
  on public.menu_items for insert
  with check (category = 'bevande' and exists (select 1 from public.profiles where id = auth.uid() and role = 'bar'));
create policy "Il bar modifica le bevande"
  on public.menu_items for update
  using (category = 'bevande' and exists (select 1 from public.profiles where id = auth.uid() and role = 'bar'))
  with check (category = 'bevande' and exists (select 1 from public.profiles where id = auth.uid() and role = 'bar'));
create policy "Il bar elimina le bevande"
  on public.menu_items for delete
  using (category = 'bevande' and exists (select 1 from public.profiles where id = auth.uid() and role = 'bar'));

-- Lo storico delle notifiche serve solo a chi le invia: torneo e admin. Lo staff lo
-- leggeva ancora per via degli annunci, rimossi.
drop policy if exists "Gestori leggono lo storico notifiche" on public.push_broadcasts;
create policy "Gestori leggono lo storico notifiche"
  on public.push_broadcasts for select
  using (exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('tournament_manager', 'admin')
  ));

commit;
