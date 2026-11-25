begin;

alter table public.dicta_online_state
  add column if not exists sync_clocks jsonb not null default '{}',
  add column if not exists sync_enabled boolean not null default false;

create table if not exists public.dicta_online_progress_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  change_id uuid not null,
  primary key (user_id, change_id)
);
alter table public.dicta_online_progress_receipts enable row level security;
revoke all on public.dicta_online_progress_receipts from public, anon, authenticated;

create or replace function public.dicta_online_save_state(p_value jsonb,p_revision bigint)
returns void language plpgsql security definer set search_path='' as $fn$
declare owner_id uuid := auth.uid();
begin
  if owner_id is null or p_revision is null or p_revision<1
    or p_revision>extract(epoch from clock_timestamp())*1000+86400000 then
    raise exception 'Invalid Dicta state revision';
  end if;
  insert into public.dicta_online_state(user_id,value,revision)
  values (owner_id,p_value,p_revision)
  on conflict(user_id) do update set value=excluded.value,revision=excluded.revision
    where not dicta_online_state.sync_enabled and dicta_online_state.revision<excluded.revision;
  if exists(select 1 from public.dicta_online_state where user_id=owner_id and sync_enabled) then
    raise exception 'Reload Dicta to continue syncing' using errcode='0A000';
  end if;
end;
$fn$;

create or replace function public.dicta_online_apply_progress(p_changes jsonb)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare
  owner_id uuid := auth.uid();
  state jsonb;
  clocks jsonb;
  acknowledged jsonb := '[]';
  change jsonb;
  value jsonb;
  change_id uuid;
  changed_at bigint;
  kind text;
  keys jsonb;
  first_key text;
  second_key text;
  clock_key text;
  lesson jsonb;
  answer jsonb;
  day jsonb;
  words jsonb;
  secs bigint;
  checks bigint;
begin
  if owner_id is null or jsonb_typeof(p_changes) is distinct from 'array'
     or jsonb_array_length(p_changes) not between 1 and 25
     or octet_length(p_changes::text) > 1100000 then
    raise exception 'Invalid Dicta change batch' using errcode='22023';
  end if;
  insert into public.dicta_online_state(user_id,value) values(owner_id,'{}') on conflict do nothing;
  select s.value,s.sync_clocks into state,clocks from public.dicta_online_state s
    where s.user_id=owner_id for update;

  for change in select item from jsonb_array_elements(p_changes) as changes(item) loop
    change_id := (change->>'id')::uuid;
    changed_at := (change->>'at')::bigint;
    kind := change->>'kind';
    keys := change->'key';
    value := change->'value';
    first_key := keys->>0;
    second_key := keys->>1;
    if change_id is null or changed_at is null or changed_at < 1
       or changed_at > extract(epoch from clock_timestamp())*1000+86400000
       or jsonb_typeof(keys) is distinct from 'array' or value is null
       or kind is null or kind not in ('position','grade','answer','day','word','setting','lastLesson')
       or jsonb_array_length(keys) <> (case when kind in ('grade','answer') then 2 when kind='lastLesson' then 0 else 1 end)
       or (kind <> 'lastLesson' and (first_key is null or first_key !~ '^[a-zA-Z0-9_-]{1,100}$'
           or first_key in ('__proto__','prototype','constructor')))
       or (kind in ('grade','answer') and (second_key is null or second_key !~ '^(whole|[0-9]{1,6})$')) then
      raise exception 'Invalid Dicta change' using errcode='22023';
    end if;
    acknowledged := acknowledged || jsonb_build_array(change_id);

    if kind = 'day' then
      if first_key !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or jsonb_typeof(value) <> 'object' then
        raise exception 'Invalid Dicta day' using errcode='22023';
      end if;
      secs := coalesce((value->>'seconds')::bigint,0);
      checks := coalesce((value->>'checks')::bigint,0);
      if secs not between 0 and 86400 or checks not between 0 and 100000 then
        raise exception 'Invalid Dicta day totals' using errcode='22023';
      end if;
      insert into public.dicta_online_progress_receipts(user_id,change_id)
        values(owner_id,change_id) on conflict do nothing;
      if found then
        day := coalesce(state#>array['days',first_key],'{}');
        day := day || jsonb_build_object('seconds',coalesce((day->>'seconds')::bigint,0)+secs,
                                       'checks',coalesce((day->>'checks')::bigint,0)+checks);
        state := state || jsonb_build_object('days',coalesce(state->'days','{}') ||
          jsonb_build_object(first_key,day));
      end if;
      continue;
    end if;

    clock_key := kind || ':' || keys::text;
    if (coalesce((clocks#>>array[clock_key,'at'])::bigint,0),
        coalesce(clocks#>>array[clock_key,'id'],'')) >= (changed_at,change_id::text) then
      continue;
    end if;

    case kind
    when 'setting' then
      state := state || jsonb_build_object('settings',coalesce(state->'settings','{}') ||
        jsonb_build_object(first_key,value));
    when 'lastLesson' then
      if jsonb_typeof(value) <> 'string' then raise exception 'Invalid lesson' using errcode='22023'; end if;
      state := state || jsonb_build_object('lastLesson',value);
    when 'word' then
      if value <> 'null'::jsonb and (jsonb_typeof(value) <> 'object' or value->>'id' is distinct from first_key) then
        raise exception 'Invalid vocabulary entry' using errcode='22023';
      end if;
      select coalesce(jsonb_agg(entry order by ord),'[]') into words
        from jsonb_array_elements(coalesce(state->'words','[]')) with ordinality as e(entry,ord)
        where entry->>'id' is distinct from first_key;
      if value <> 'null'::jsonb then words := words || jsonb_build_array(value); end if;
      state := state || jsonb_build_object('words',words);
    else
      lesson := coalesce(state#>array['progress',first_key],'{"index":0,"answers":{}}');
      if kind = 'position' then
        if jsonb_typeof(value) <> 'number' or (value::text)::integer not between 0 and 100000
          then raise exception 'Invalid position' using errcode='22023'; end if;
        lesson := lesson || jsonb_build_object('index',value);
      else
        if jsonb_typeof(value) <> 'object' or octet_length(value::text) > 100000 then
          raise exception 'Invalid answer' using errcode='22023';
        end if;
        answer := coalesce(lesson#>array['answers',second_key],'{"text":"","checks":0,"hints":0,"revealed":false}');
        if kind = 'grade' then
          if coalesce((answer->>'gradedAt')::bigint,0) > changed_at then continue; end if;
          select coalesce(jsonb_object_agg(field,item),'{}') into value from jsonb_each(value) as v(field,item)
            where field in ('checkedText','score','checks','firstScore','firstAssisted');
          answer := answer || value || jsonb_build_object('gradedAt',changed_at);
        else
          select coalesce(jsonb_object_agg(field,item),'{}') into value from jsonb_each(value) as v(field,item)
            where field in ('text','hints','revealed','range');
          answer := answer || value;
        end if;
        lesson := lesson || jsonb_build_object('answers',coalesce(lesson->'answers','{}') ||
          jsonb_build_object(second_key,answer));
      end if;
      state := state || jsonb_build_object('progress',coalesce(state->'progress','{}') ||
        jsonb_build_object(first_key,lesson));
    end case;
    clocks := clocks || jsonb_build_object(clock_key,jsonb_build_object('at',changed_at,'id',change_id));
  end loop;

  update public.dicta_online_state set
    value=state, sync_clocks=clocks, sync_enabled=true,
    revision=greatest(revision+1,floor(extract(epoch from clock_timestamp())*1000)::bigint)
    where user_id=owner_id;
  return acknowledged;
end;
$fn$;

revoke all on function public.dicta_online_apply_progress(jsonb) from public,anon,authenticated;
grant execute on function public.dicta_online_apply_progress(jsonb) to authenticated;
commit;
