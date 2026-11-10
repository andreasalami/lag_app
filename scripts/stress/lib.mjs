// PostgreSQL usa-e-getta per gli stress test locali: una cartella temporanea, solo socket
// Unix (nessuna porta di rete), schema.sql installato con i ruoli di Supabase. Non si collega
// mai a Supabase. Ogni createDb() ha la sua cartella: più processi possono girare insieme.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

// Letterali SQL: i valori sono generati qui (UUID, costanti), mai input esterno.
export const lit = (value) =>
  value === null || value === undefined ? "null" : `'${String(value).replaceAll("'", "''")}'`;
export const jsonb = (value) => `${lit(JSON.stringify(value))}::jsonb`;
export const messageOf = (error) => error?.message ?? "";

const PAID = "('pagato', 'ritiro_parziale', 'consegnato')";

/** Regole che non devono mai essere violate: ogni riga restituita è un'incoerenza sugli ordini. */
export const invariantSql = `
with o as (select o.*, coalesce(o.report_status, o.status) as eff from public.orders o),
 ful as (select order_id, count(*) n, sum(quantity) q, sum(delivered_quantity) d from public.order_fulfillment_items group by order_id),
 ledger as (
   select d.order_id, (e->>'id')::uuid item, sum((e->>'qty')::integer) q
   from public.fulfillment_deliveries d cross join lateral jsonb_array_elements(d.quantities) e
   where d.reversed_at is null group by 1, 2)
select coalesce(json_agg(v), '[]'::json) from (
  select 'dup_client_request_id' rule, client_request_id::text ref, count(*)::text detail
    from o where client_request_id is not null group by event_id, client_request_id having count(*) > 1
  union all
  select 'dup_display_number', event_id || '/' || display_number, count(*)::text
    from o group by event_id, display_number having count(*) > 1
  union all
  select 'display_number_gap', event_id::text, min(display_number) || '..' || max(display_number) || ' su ' || count(*)
    from o group by event_id having min(display_number) <> 1 or max(display_number) <> count(*)
  union all
  select 'total_not_sum_of_items', id::text, total || ' contro ' || calc
    from (select id, total, (select coalesce(sum((l->>'price')::numeric * (l->>'qty')::integer), 0) from jsonb_array_elements(items) l) calc from o) t
    where total <> calc
  union all
  select 'status_vs_timestamps', id::text, status || ' paid=' || coalesce(paid_at::text, '-') || ' canc=' || coalesce(cancelled_at::text, '-') || ' deliv=' || coalesce(delivered_at::text, '-') || ' compl=' || coalesce(completed_at::text, '-')
    from o where not (case status
      when 'in_attesa_pagamento' then paid_at is null and cancelled_at is null and delivered_at is null and completed_at is null and qr_token_hash is not null and client_request_id is not null
      when 'pagato' then paid_at is not null and cancelled_at is null and delivered_at is null and completed_at is null
      when 'ritiro_parziale' then paid_at is not null and cancelled_at is null and delivered_at is null and completed_at is null
      when 'consegnato' then paid_at is not null and cancelled_at is null and delivered_at is not null and completed_at is not null
      when 'annullato' then cancelled_at is not null and paid_at is null and delivered_at is null
      else false end)
  union all
  select 'legacy_claim_columns_set', id::text, status from o where claimed_token_hash is not null or claim_expires_at is not null
  union all
  select 'fulfillment_vs_status', o.id::text, o.eff || ' consegnato=' || coalesce(f.d, 0) || '/' || coalesce(f.q, 0)
    from o left join ful f on f.order_id = o.id
    where case when o.eff in ${PAID}
      then f.n is null or not (case o.eff when 'pagato' then f.d = 0 when 'ritiro_parziale' then f.d > 0 and f.d < f.q else f.d = f.q end)
      else f.n is not null end
  union all
  select 'fulfillment_rows_vs_items', o.id::text, 'righe di evasione diverse dallo snapshot'
    from o where o.eff in ${PAID} and (
      (select count(*) from jsonb_array_elements(o.items) l) <> (select count(*) from public.order_fulfillment_items f where f.order_id = o.id)
      or exists (select 1 from jsonb_array_elements(o.items) l
        left join public.order_fulfillment_items f on f.order_id = o.id and f.menu_item_id = (l->>'id')::uuid
        where f.order_id is null or f.quantity <> (l->>'qty')::integer or f.name <> l->>'name'
          or f.station <> case l->>'subcategory' when 'vini' then 'bar' when 'bevande' then 'bar' else l->>'subcategory' end))
  union all
  select 'delivered_vs_delivery_ledger', f.order_id || '/' || f.menu_item_id, f.delivered_quantity || ' contro registro ' || coalesce(l.q, 0)
    from public.order_fulfillment_items f left join ledger l on l.order_id = f.order_id and l.item = f.menu_item_id
    where f.delivered_quantity <> coalesce(l.q, 0)
  union all
  select 'kitchen_over_capacity', event_id::text, count(*)::text
    from o where kitchen_state = 'active' and status in ('pagato', 'ritiro_parziale')
      and exists (select 1 from public.order_fulfillment_items f where f.order_id = o.id and f.category = 'cibo' and f.delivered_quantity < f.quantity)
    group by event_id having count(*) > 100
  union all
  select 'kitchen_state_vs_food', o.id::text, o.kitchen_state || ' modo=' || o.preparation_mode || ' stato=' || o.status
    from o where o.report_status is null and o.status in ('pagato', 'ritiro_parziale', 'consegnato') and not (
      case
        when not exists (select 1 from public.order_fulfillment_items f where f.order_id = o.id and f.category = 'cibo') then o.kitchen_state = 'none'
        when not exists (select 1 from public.order_fulfillment_items f where f.order_id = o.id and f.category = 'cibo' and f.delivered_quantity < f.quantity) then o.kitchen_state = 'done'
        when o.preparation_mode = 'immediate' then o.kitchen_state in ('waiting', 'active')
        else o.kitchen_state in ('dormant', 'waiting', 'active') end)
  union all
  select 'kitchen_started_at_vs_state', id::text, kitchen_state || ' avvio=' || coalesce(kitchen_started_at::text, '-')
    from o where status in ('pagato', 'ritiro_parziale')
      and ((kitchen_state = 'active' and kitchen_started_at is null) or (kitchen_state in ('waiting', 'dormant') and kitchen_started_at is not null))
  union all
  select 'kitchen_occupied_over_100', e.id::text, public.kitchen_occupied(e.id)::text
    from public.order_events e where public.kitchen_occupied(e.id) > 100
  union all
  select 'deferred_mode_without_food', o.id::text, o.status
    from o where o.preparation_mode = 'deferred' and not exists (select 1 from jsonb_array_elements(o.items) l where l->>'category' = 'cibo')
  union all
  select 'kitchen_state_on_pending', o.id::text, o.kitchen_state
    from o where o.status = 'in_attesa_pagamento' and o.kitchen_state in ('active', 'waiting', 'done')
  union all
  select 'claim_two_stations', order_id::text, string_agg(distinct station, ',')
    from public.order_claim_devices where expires_at > now() group by order_id having count(distinct station) > 1
  union all
  select 'claim_on_non_pending_order', c.order_id::text, o.status
    from public.order_claim_devices c join o on o.id = c.order_id join public.order_events e on e.id = o.event_id
    where o.status <> 'in_attesa_pagamento' and e.permanently_closed_at is null
  union all
  select 'negative_stock', id::text, available_portions::text from public.menu_items where available_portions < 0
) v`;

export function createDb() {
  // Binari PostgreSQL: dal PATH, oppure da LOADTEST_PG_BIN (per esempio /opt/homebrew/opt/postgresql@17/bin).
  const bin = (name) => (process.env.LOADTEST_PG_BIN ? join(process.env.LOADTEST_PG_BIN, name) : name);
  // Su macOS il postmaster si rifiuta di partire senza una LC_ALL valida.
  const pgEnv = { ...process.env, LC_ALL: "C" };
  const workDir = mkdtempSync(join(tmpdir(), "lag-stress-"));
  const dataDir = join(workDir, "data");
  const port = "55432"; // Solo il nome del socket: listen_addresses vuoto, nessuna porta TCP.
  const PSQL_ARGS = ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"];
  const connection = ["-h", workDir, "-p", port, "-U", "postgres", "-d", "postgres"];

  /** Esegue SQL in una connessione propria: come browser (anon), gateway (service_role) o utente autenticato. */
  function sql(query, { as = "postgres", user = null } = {}) {
    const preamble = as === "postgres" ? "" : `set role ${as};\nset request.jwt.claim.sub = ${lit(user ?? "")};\n`;
    return new Promise((resolve) => {
      const started = performance.now();
      const child = spawn(bin("psql"), [...PSQL_ARGS, ...connection]);
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      child.on("close", (code) => {
        const ms = performance.now() - started;
        if (code === 0) {
          const text = out.trim();
          let data = text;
          try {
            data = text === "" ? null : JSON.parse(text);
          } catch {
            /* risultato non JSON: resta testo */
          }
          resolve({ data, error: null, ms });
        } else {
          const match = err.match(/ERROR:\s+([0-9A-Z]{5}):\s+([^\n]*)/);
          resolve({ data: null, error: { code: match?.[1] ?? null, message: match?.[2] ?? err.trim() }, ms });
        }
      });
      child.stdin.end(`${preamble}${query}\n`);
    });
  }

  async function admin_sql(query) {
    const result = await sql(query);
    if (result.error) throw new Error(`${query.slice(0, 80)}: ${result.error.message}`);
    return result.data;
  }

  const rpc = (name, args, options) => sql(`select public.${name}(${args.join(", ")})`, options);

  function start({ maxConnections = 300 } = {}) {
    execFileSync(bin("initdb"), ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--locale=C"], {
      stdio: "ignore",
      env: pgEnv,
    });
    try {
      execFileSync(
        bin("pg_ctl"),
        [
          "-D",
          dataDir,
          "-l",
          join(workDir, "postgres.log"),
          "-o",
          `-k ${workDir} -p ${port} -c listen_addresses='' -c max_connections=${maxConnections}`,
          "-w",
          "start",
        ],
        { stdio: "ignore", env: pgEnv },
      );
    } catch {
      throw new Error(
        `PostgreSQL temporaneo non avviato:\n${readFileSync(join(workDir, "postgres.log"), "utf8").slice(-1500)}`,
      );
    }
  }

  async function installSchema() {
    // Ruoli, auth.uid() e pgcrypto come su Supabase.
    await admin_sql(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth; create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create schema extensions; create extension pgcrypto with schema extensions;
grant usage on schema public, auth, extensions to anon, authenticated, service_role;
create publication supabase_realtime;`);
    const schema = new URL("../../supabase/schema.sql", import.meta.url);
    const install = spawn(bin("psql"), [...PSQL_ARGS, ...connection, "-f", schema.pathname]);
    let err = "";
    install.stderr.on("data", (chunk) => (err += chunk));
    const code = await new Promise((resolve) => install.on("close", resolve));
    if (code !== 0) throw new Error(`installazione schema.sql: ${err.trim()}`);
  }

  function stop() {
    try {
      execFileSync(bin("pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "stop"], { stdio: "ignore", env: pgEnv });
    } catch {
      /* cluster mai avviato */
    }
    rmSync(workDir, { recursive: true, force: true });
  }

  return { workDir, sql, admin_sql, rpc, start, installSchema, stop };
}
