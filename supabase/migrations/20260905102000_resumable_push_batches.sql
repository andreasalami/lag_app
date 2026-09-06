begin;
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

commit;
