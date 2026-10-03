begin;

-- Le notifiche "annuncio" sono rimaste attive dopo la rimozione della sezione annunci:
-- un account staff poteva ancora inviare, chiamando direttamente l'API, un testo
-- qualsiasi a tutti gli iscritti alle notifiche. Ora si inviano solo notifiche del
-- torneo, da admin o tournament_manager. Lo storico in push_broadcasts resta com'è.
create or replace function public.claim_push_broadcast(p_id uuid,p_sender uuid,p_kind text,p_title text,p_message text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare job public.push_broadcasts%rowtype; batch jsonb; lease uuid:=gen_random_uuid();
begin
 -- Solo notifiche del torneo: la sezione annunci è stata rimossa con le sue notifiche.
 if p_kind<>'tournament' or not exists(select 1 from public.profiles where id=p_sender and role in ('admin','tournament_manager')) then
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

commit;
