begin;

alter table public.dicta_online_lessons
  add column if not exists upload_pending boolean not null default false,
  add column if not exists deleting boolean not null default false;
alter table public.dicta_online_lessons drop constraint if exists dicta_online_lessons_check;
alter table public.dicta_online_lessons drop constraint if exists dicta_online_audio_owner_path;
alter table public.dicta_online_lessons add constraint dicta_online_audio_owner_path check (
  audio_path is null or audio_path ~ ('^'||user_id::text||'/[a-f0-9]{64}\.(m4a|mp3)$'));
alter table public.dicta_online_audio_reservations
  add column if not exists expires_at timestamptz,
  add column if not exists lease uuid,
  add column if not exists lease_until timestamptz;

grant delete on public.dicta_online_lessons to service_role;
grant update on public.dicta_online_audio_reservations to service_role;
update storage.buckets set allowed_mime_types=array['audio/mp4','audio/mpeg']
  where id='dicta-online-audio';

drop policy if exists dicta_online_read_my_lessons on public.dicta_online_lessons;
create policy dicta_online_read_my_lessons on public.dicta_online_lessons for select to authenticated
  using (user_id=(select auth.uid()) and not upload_pending);
drop policy if exists dicta_online_read_my_audio on storage.objects;
create policy dicta_online_read_my_audio on storage.objects for select to authenticated using (
  bucket_id='dicta-online-audio' and (storage.foldername(name))[1]=(select auth.uid()::text)
  and exists(select 1 from public.dicta_online_lessons l where l.audio_path=storage.objects.name
    and l.user_id=(select auth.uid()) and not l.upload_pending and not l.deleting)
);

create or replace function public.dicta_online_create_lesson(
  p_user uuid,p_id text,p_lesson jsonb,p_bytes bigint,p_extension text,p_quota bigint)
returns jsonb language plpgsql security invoker set search_path='' as $fn$
declare
  existing public.dicta_online_lessons;
  target text;
  used_total bigint;
  used_personal bigint;
  now_at timestamptz := clock_timestamp();
begin
  if p_user is null or p_id is null or p_id !~ '^[a-zA-Z0-9_-]{1,100}$'
     or jsonb_typeof(p_lesson) is distinct from 'object'
     or p_bytes is null or p_bytes not between 0 and 47185920
     or p_quota is null or p_quota not between 1 and 900000000
     or (p_bytes > 0 and (p_extension is null or p_extension not in ('mp3','m4a')))
     or (p_bytes = 0 and (p_lesson->>'youtubeId' is null or p_lesson->>'youtubeId' !~ '^[a-zA-Z0-9_-]{11}$')) then
    raise exception 'INVALID_LESSON';
  end if;

  -- Keep the limit atomic with the pre-existing offline migration uploader.
  perform pg_advisory_xact_lock(73910429);
  delete from public.dicta_online_lessons l using public.dicta_online_audio_reservations r
    where l.audio_path=r.audio_path and l.upload_pending and not l.deleting and
      r.expires_at < now_at and (r.lease_until is null or r.lease_until < now_at)
      and not exists(select 1 from storage.objects o where o.bucket_id='dicta-online-audio' and o.name=r.audio_path);
  delete from public.dicta_online_audio_reservations r
    where r.expires_at < now_at and (r.lease_until is null or r.lease_until < now_at)
      and not exists(select 1 from public.dicta_online_lessons l where l.audio_path=r.audio_path)
      and not exists(select 1 from storage.objects o where o.bucket_id='dicta-online-audio' and o.name=r.audio_path);
  select l.* into existing from public.dicta_online_lessons l where l.user_id=p_user and l.lesson_id=p_id;
  if found then
    if existing.deleting then raise exception 'UPLOAD_BUSY'; end if;
    return jsonb_build_object('id',p_id,'pending',existing.upload_pending);
  end if;

  if p_bytes > 0 then
    with used as (
      select coalesce((o.metadata->>'size')::bigint,0) as bytes,
        o.bucket_id='dicta-online-audio' and split_part(o.name,'/',1)=p_user::text as mine
      from storage.objects o
      union all
      select greatest(r.bytes-coalesce((o.metadata->>'size')::bigint,0),0),
        split_part(r.audio_path,'/',1)=p_user::text
      from public.dicta_online_audio_reservations r
      left join storage.objects o on o.bucket_id='dicta-online-audio' and o.name=r.audio_path
    )
    select coalesce(sum(bytes),0),coalesce(sum(bytes) filter (where mine),0)
      into used_total,used_personal from used;
    if used_personal+p_bytes>p_quota then raise exception 'ACCOUNT_AUDIO_QUOTA'; end if;
    if used_total+p_bytes>900000000 then raise exception 'PROJECT_AUDIO_QUOTA'; end if;
    target := p_user::text || '/' || replace(gen_random_uuid()::text || gen_random_uuid()::text,'-','') || '.' || p_extension;
    insert into public.dicta_online_audio_reservations(audio_path,bytes,expires_at)
      values(target,p_bytes,now_at + interval '1 day');
  end if;
  insert into public.dicta_online_lessons(user_id,lesson_id,lesson,audio_path,upload_pending)
    values(p_user,p_id,p_lesson,target,p_bytes>0);
  return jsonb_build_object('id',p_id,'pending',p_bytes>0);
end;
$fn$;

create or replace function public.dicta_online_begin_upload(p_user uuid,p_id text)
returns jsonb language plpgsql security invoker set search_path='' as $fn$
declare row_data public.dicta_online_lessons; reservation public.dicta_online_audio_reservations;
  current_lease uuid := gen_random_uuid();
begin
  perform pg_advisory_xact_lock(73910429);
  select l.* into row_data from public.dicta_online_lessons l where l.user_id=p_user and l.lesson_id=p_id;
  if not found then raise exception 'LESSON_NOT_FOUND'; end if;
  if row_data.deleting then raise exception 'UPLOAD_BUSY'; end if;
  if not row_data.upload_pending then return jsonb_build_object('id',p_id,'pending',false); end if;
  select r.* into reservation from public.dicta_online_audio_reservations r where r.audio_path=row_data.audio_path;
  if not found then raise exception 'LESSON_NOT_FOUND'; end if;
  if exists(select 1 from storage.objects o where o.bucket_id='dicta-online-audio' and o.name=row_data.audio_path
    and (o.metadata->>'size')::bigint=reservation.bytes) then
    update public.dicta_online_lessons set upload_pending=false where user_id=p_user and lesson_id=p_id;
    delete from public.dicta_online_audio_reservations where audio_path=row_data.audio_path;
    return jsonb_build_object('id',p_id,'pending',false);
  end if;
  if reservation.lease_until > clock_timestamp() then raise exception 'UPLOAD_BUSY'; end if;
  update public.dicta_online_audio_reservations
    set lease=current_lease, lease_until=clock_timestamp()+interval '3 minutes',
      expires_at=clock_timestamp()+interval '1 day' where audio_path=row_data.audio_path;
  return jsonb_build_object('id',p_id,'pending',true,'audioPath',row_data.audio_path,
    'bytes',reservation.bytes,'lease',current_lease);
end;
$fn$;

create or replace function public.dicta_online_finish_upload(p_user uuid,p_id text,p_lease uuid)
returns jsonb language plpgsql security invoker set search_path='' as $fn$
declare row_data public.dicta_online_lessons; expected bigint;
begin
  perform pg_advisory_xact_lock(73910429);
  select l.* into row_data from public.dicta_online_lessons l where l.user_id=p_user and l.lesson_id=p_id;
  if not found then raise exception 'LESSON_NOT_FOUND'; end if;
  if row_data.deleting then raise exception 'UPLOAD_BUSY'; end if;
  if not row_data.upload_pending then return jsonb_build_object('id',p_id,'pending',false); end if;
  select r.bytes into expected from public.dicta_online_audio_reservations r
    where r.audio_path=row_data.audio_path and r.lease=p_lease;
  if not found then raise exception 'UPLOAD_BUSY'; end if;
  if not exists(select 1 from storage.objects o where o.bucket_id='dicta-online-audio' and o.name=row_data.audio_path
      and (o.metadata->>'size')::bigint=expected) then raise exception 'UPLOAD_SIZE_MISMATCH'; end if;
  update public.dicta_online_lessons set upload_pending=false where user_id=p_user and lesson_id=p_id;
  delete from public.dicta_online_audio_reservations where audio_path=row_data.audio_path;
  return jsonb_build_object('id',p_id,'pending',false);
end;
$fn$;

create or replace function public.dicta_online_abort_upload(p_user uuid,p_id text,p_lease uuid)
returns boolean language plpgsql security invoker set search_path='' as $fn$
declare target text;
begin
  perform pg_advisory_xact_lock(73910429);
  select l.audio_path into target from public.dicta_online_lessons l
    join public.dicta_online_audio_reservations r on l.audio_path=r.audio_path
    where l.user_id=p_user and l.lesson_id=p_id and l.upload_pending and r.lease=p_lease;
  if not found then return false; end if;
  if exists(select 1 from storage.objects o where o.bucket_id='dicta-online-audio' and o.name=target) then
    update public.dicta_online_audio_reservations set lease=null,lease_until=null where audio_path=target;
    return false;
  end if;
  delete from public.dicta_online_lessons where user_id=p_user and lesson_id=p_id;
  delete from public.dicta_online_audio_reservations where audio_path=target;
  return true;
end;
$fn$;

create or replace function public.dicta_online_claim_failed_upload(p_user uuid,p_id text,p_lease uuid)
returns jsonb language plpgsql security invoker set search_path='' as $fn$
declare target text; reserved_bytes bigint;
begin
  perform pg_advisory_xact_lock(73910429);
  select l.audio_path,r.bytes into target,reserved_bytes from public.dicta_online_lessons l
    join public.dicta_online_audio_reservations r on l.audio_path=r.audio_path
    where l.user_id=p_user and l.lesson_id=p_id and l.upload_pending and not l.deleting
      and r.lease=p_lease and r.lease_until>clock_timestamp();
  if not found or exists(select 1 from storage.objects o where o.bucket_id='dicta-online-audio'
      and o.name=target and (o.metadata->>'size')::bigint=reserved_bytes) then return '{}'::jsonb; end if;
  update public.dicta_online_lessons set deleting=true where user_id=p_user and lesson_id=p_id;
  return jsonb_build_object('id',p_id,'audioPath',target);
end;
$fn$;

create or replace function public.dicta_online_reconcile_uploads(p_user uuid)
returns jsonb language plpgsql security invoker set search_path='' as $fn$
declare targets jsonb;
begin
  perform pg_advisory_xact_lock(73910429);
  with completed as (
    update public.dicta_online_lessons l set upload_pending=false
    from public.dicta_online_audio_reservations r, storage.objects o
    where l.user_id=p_user and l.upload_pending and not l.deleting and r.audio_path=l.audio_path
      and o.bucket_id='dicta-online-audio' and o.name=r.audio_path and (o.metadata->>'size')::bigint=r.bytes
    returning l.audio_path
  )
  delete from public.dicta_online_audio_reservations r using completed c where r.audio_path=c.audio_path;

  with expired as (
    select l.lesson_id from public.dicta_online_lessons l
    join public.dicta_online_audio_reservations r on l.audio_path=r.audio_path
    where l.user_id=p_user and l.upload_pending and not l.deleting
      and r.expires_at<clock_timestamp() and (r.lease_until is null or r.lease_until<clock_timestamp())
    order by l.lesson_id limit 8
  )
  update public.dicta_online_lessons l set deleting=true from expired e
    where l.user_id=p_user and l.lesson_id=e.lesson_id;

  select coalesce(jsonb_agg(jsonb_build_object('id',row_data.lesson_id,'audioPath',row_data.audio_path)),'[]')
    into targets from (
      select l.lesson_id,l.audio_path from public.dicta_online_lessons l
      where l.user_id=p_user and l.upload_pending and l.deleting order by l.lesson_id limit 8
    ) row_data;
  return targets;
end;
$fn$;

create or replace function public.dicta_online_update_timing(p_user uuid,p_id text,p_timing jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $fn$
declare row_data public.dicta_online_lessons; next_segments jsonb := '[]'; mark jsonb;
  ordinal integer := 0; start_at numeric; end_at numeric; last_start numeric := -1;
begin
  select l.* into row_data from public.dicta_online_lessons l
    where l.user_id=p_user and l.lesson_id=p_id and not l.upload_pending and not l.deleting for update;
  if not found then raise exception 'LESSON_NOT_FOUND'; end if;
  if jsonb_typeof(p_timing) is distinct from 'array'
    or jsonb_array_length(p_timing) is distinct from jsonb_array_length(row_data.lesson->'segments') then
    raise exception 'INVALID_TIMING';
  end if;
  for mark in select item from jsonb_array_elements(p_timing) as items(item) loop
    start_at := (mark->>'start')::numeric;
    end_at := (mark->>'end')::numeric;
    if start_at is null or end_at is null or start_at < 0 or start_at < last_start or end_at<=start_at
      then raise exception 'INVALID_TIMING'; end if;
    next_segments := next_segments || jsonb_build_array(row_data.lesson->'segments'->ordinal ||
      jsonb_build_object('start',start_at,'end',end_at));
    last_start := start_at;
    ordinal := ordinal+1;
  end loop;
  update public.dicta_online_lessons set lesson=jsonb_set(lesson,'{segments}',next_segments)
    where user_id=p_user and lesson_id=p_id;
  return jsonb_build_object('id',p_id);
end;
$fn$;

create or replace function public.dicta_online_begin_delete(p_user uuid,p_id text)
returns jsonb language plpgsql security invoker set search_path='' as $fn$
declare target text;
begin
  perform pg_advisory_xact_lock(73910429);
  select l.audio_path into target from public.dicta_online_lessons l where l.user_id=p_user and l.lesson_id=p_id;
  if not found then raise exception 'LESSON_NOT_FOUND'; end if;
  if exists(select 1 from public.dicta_online_audio_reservations r where r.audio_path=target
        and r.lease_until>clock_timestamp()) then raise exception 'UPLOAD_BUSY'; end if;
  update public.dicta_online_lessons set deleting=true where user_id=p_user and lesson_id=p_id;
  if exists(select 1 from public.dicta_online_lessons l where l.audio_path=target and not l.deleting) then
    target := null;
  end if;
  return jsonb_build_object('audioPath',target);
end;
$fn$;

create or replace function public.dicta_online_finish_delete(p_user uuid,p_id text)
returns boolean language plpgsql security invoker set search_path='' as $fn$
declare target text;
begin
  perform pg_advisory_xact_lock(73910429);
  select l.audio_path into target from public.dicta_online_lessons l
    where l.user_id=p_user and l.lesson_id=p_id and l.deleting;
  if not found then return false; end if;
  if not exists(select 1 from public.dicta_online_lessons l where l.audio_path=target and not l.deleting) then
    if exists(select 1 from storage.objects o where o.bucket_id='dicta-online-audio' and o.name=target)
      then raise exception 'MEDIA_DELETE_PENDING'; end if;
    delete from public.dicta_online_audio_reservations where audio_path=target;
  end if;
  delete from public.dicta_online_lessons where user_id=p_user and lesson_id=p_id;
  return true;
end;
$fn$;

revoke all on function public.dicta_online_create_lesson(uuid,text,jsonb,bigint,text,bigint),
  public.dicta_online_begin_upload(uuid,text), public.dicta_online_finish_upload(uuid,text,uuid),
  public.dicta_online_abort_upload(uuid,text,uuid), public.dicta_online_update_timing(uuid,text,jsonb),
  public.dicta_online_begin_delete(uuid,text), public.dicta_online_finish_delete(uuid,text),
  public.dicta_online_claim_failed_upload(uuid,text,uuid), public.dicta_online_reconcile_uploads(uuid)
  from public,anon,authenticated;
grant execute on function public.dicta_online_create_lesson(uuid,text,jsonb,bigint,text,bigint),
  public.dicta_online_begin_upload(uuid,text), public.dicta_online_finish_upload(uuid,text,uuid),
  public.dicta_online_abort_upload(uuid,text,uuid), public.dicta_online_update_timing(uuid,text,jsonb),
  public.dicta_online_begin_delete(uuid,text), public.dicta_online_finish_delete(uuid,text),
  public.dicta_online_claim_failed_upload(uuid,text,uuid), public.dicta_online_reconcile_uploads(uuid)
  to service_role;
commit;
