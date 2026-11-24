-- Dicta Online for Supabase Free. Every enrolled user owns separate state and lessons.
begin;

create table if not exists public.dicta_online_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  value jsonb not null check (jsonb_typeof(value)='object' and octet_length(value::text)<=2000000),
  revision bigint not null default 0 check (revision>=0)
);
create table if not exists public.dicta_online_lessons (
  user_id uuid not null references auth.users(id) on delete cascade,
  lesson_id text not null check (lesson_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  lesson jsonb not null check (jsonb_typeof(lesson)='object' and octet_length(lesson::text)<=2500000),
  audio_path text,
  primary key (user_id, lesson_id),
  check (audio_path is null or audio_path ~ ('^'||user_id::text||'/[a-f0-9]{64}\.m4a$'))
);
create table if not exists public.dicta_online_audio_reservations (
  audio_path text primary key,
  bytes bigint not null check (bytes between 1 and 47185920)
);

alter table public.dicta_online_state enable row level security;
alter table public.dicta_online_lessons enable row level security;
alter table public.dicta_online_audio_reservations enable row level security;
revoke all on public.dicta_online_state, public.dicta_online_lessons,
  public.dicta_online_audio_reservations from public, anon, authenticated;
grant select on public.dicta_online_state, public.dicta_online_lessons to authenticated;
grant select, insert, update on public.dicta_online_state, public.dicta_online_lessons to service_role;
grant select, insert, delete on public.dicta_online_audio_reservations to service_role;

drop policy if exists dicta_online_read_my_state on public.dicta_online_state;
create policy dicta_online_read_my_state on public.dicta_online_state for select
  to authenticated using (user_id=(select auth.uid()));
drop policy if exists dicta_online_read_my_lessons on public.dicta_online_lessons;
create policy dicta_online_read_my_lessons on public.dicta_online_lessons for select
  to authenticated using (user_id=(select auth.uid()));

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('dicta-online-audio','dicta-online-audio',false,47185920,array['audio/mp4'])
on conflict (id) do update set public=false,file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists dicta_online_read_my_audio on storage.objects;
create policy dicta_online_read_my_audio on storage.objects for select to authenticated
  using (bucket_id='dicta-online-audio' and (storage.foldername(name))[1]=(select auth.uid()::text));

-- Derive the owner from the JWT. Delayed requests cannot overwrite a later save.
create or replace function public.dicta_online_save_state(p_value jsonb,p_revision bigint)
returns void language plpgsql security definer set search_path='' as $$
declare owner_id uuid := auth.uid();
begin
  if owner_id is null or p_revision is null or p_revision<1
    or p_revision>extract(epoch from clock_timestamp())*1000+86400000 then
    raise exception 'Invalid Dicta state revision';
  end if;
  insert into public.dicta_online_state(user_id,value,revision)
  values (owner_id,p_value,p_revision)
  on conflict(user_id) do update set value=excluded.value,revision=excluded.revision
    where dicta_online_state.revision<excluded.revision;
end $$;
revoke all on function public.dicta_online_save_state(jsonb,bigint) from public,anon,authenticated;
grant execute on function public.dicta_online_save_state(jsonb,bigint) to authenticated;

-- Guard the total project allowance before uploading, including in-flight audio.
create or replace function public.dicta_online_reserve_audio(p_path text,p_bytes bigint)
returns boolean language plpgsql security invoker set search_path='' as $$
declare used_bytes bigint;
begin
  perform pg_advisory_xact_lock(73910429);
  if exists(select 1 from storage.objects where bucket_id='dicta-online-audio' and name=p_path) then
    return false;
  end if;
  if exists(select 1 from public.dicta_online_audio_reservations where audio_path=p_path) then
    return true;
  end if;
  select coalesce(sum((metadata->>'size')::bigint),0) into used_bytes from storage.objects;
  select used_bytes+coalesce(sum(r.bytes),0) into used_bytes
  from public.dicta_online_audio_reservations as r
  where not exists(select 1 from storage.objects where bucket_id='dicta-online-audio' and name=r.audio_path);
  if used_bytes+p_bytes>900000000 then raise exception 'Dicta storage budget reached'; end if;
  insert into public.dicta_online_audio_reservations(audio_path,bytes) values(p_path,p_bytes);
  return true;
end $$;
revoke all on function public.dicta_online_reserve_audio(text,bigint) from public,anon,authenticated;
grant execute on function public.dicta_online_reserve_audio(text,bigint) to service_role;

-- Transfer is atomic at the database layer and keeps newer progress and existing lessons.
create or replace function public.dicta_online_import(p_user uuid,p_state jsonb,p_lessons jsonb)
returns void language plpgsql security invoker set search_path='' as $$
begin
  insert into public.dicta_online_state(user_id,value)
  values(p_user,p_state) on conflict(user_id) do nothing;
  insert into public.dicta_online_lessons as saved (user_id,lesson_id,lesson,audio_path)
  select p_user,l.lesson_id,l.lesson,l.audio_path
  from jsonb_to_recordset(p_lessons) as l(lesson_id text,lesson jsonb,audio_path text)
  on conflict(user_id,lesson_id) do nothing;
end $$;
revoke all on function public.dicta_online_import(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.dicta_online_import(uuid,jsonb,jsonb) to service_role;

commit;
