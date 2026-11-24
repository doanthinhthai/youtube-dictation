-- Apply after the Dicta Online storage/data schema. Supabase Auth owns passwords.
begin;

create table if not exists public.dicta_online_usernames (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,24}$')
);
alter table public.dicta_online_usernames enable row level security;
revoke all on public.dicta_online_usernames from public, anon, authenticated;
grant select on public.dicta_online_usernames to authenticated;
drop policy if exists dicta_read_my_username on public.dicta_online_usernames;
create policy dicta_read_my_username on public.dicta_online_usernames
  for select to authenticated using (user_id=(select auth.uid()));

create or replace function public.dicta_claim_username(p_username text)
returns text language plpgsql security definer set search_path='' as $$
declare who uuid := auth.uid();
declare name_to_claim text := lower(btrim(p_username));
begin
  if who is null or not exists (
    select 1 from auth.users where id=who and email_confirmed_at is not null
  ) then
    raise exception 'A verified account is required' using errcode='42501';
  end if;
  if name_to_claim is null or name_to_claim !~ '^[a-z0-9_]{3,24}$' then
    raise exception 'Invalid username' using errcode='22023';
  end if;
  insert into public.dicta_online_usernames(user_id,username) values(who,name_to_claim)
  on conflict(user_id) do update set username=excluded.username;
  return name_to_claim;
end $$;
revoke all on function public.dicta_claim_username(text) from public, anon, authenticated;
grant execute on function public.dicta_claim_username(text) to authenticated;

-- Only the Worker may map a username to an email. No browser role can call this.
create or replace function public.dicta_login_email(p_username text)
returns text language sql stable security definer set search_path='' as $$
  select u.email from public.dicta_online_usernames n join auth.users u on u.id=n.user_id
  where n.username=lower(btrim(p_username)) and u.email_confirmed_at is not null
$$;
revoke all on function public.dicta_login_email(text) from public, anon, authenticated;
grant execute on function public.dicta_login_email(text) to service_role;

commit;
