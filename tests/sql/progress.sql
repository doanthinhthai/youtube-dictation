begin;

insert into auth.users(id) values
  ('9ec10000-0000-4000-8000-000000000001'),
  ('9ec10000-0000-4000-8000-000000000002');
insert into public.dicta_online_state(user_id, value, revision) values
  ('9ec10000-0000-4000-8000-000000000001',
   '{"settings":{"goal":15},"progress":{"legacy":{"index":0,"answers":{"0":{"score":90}}}}}', 10);

set local role authenticated;
select set_config('request.jwt.claim.sub','9ec10000-0000-4000-8000-000000000001',true);

do $test$
declare result jsonb; saved jsonb;
begin
  result := public.dicta_online_apply_progress('[
    {"id":"9ec20000-0000-4000-8000-000000000001","at":200,"kind":"grade","key":["office","0"],"value":{"score":100,"checkedText":"the office","checks":1}},
    {"id":"9ec20000-0000-4000-8000-000000000002","at":150,"kind":"grade","key":["office","1"],"value":{"score":80}},
    {"id":"9ec20000-0000-4000-8000-000000000003","at":500,"kind":"day","key":["2026-11-25"],"value":{"seconds":31,"checks":1}}
  ]');
  if jsonb_array_length(result) <> 3 then raise exception 'Changes must be acknowledged'; end if;
  perform public.dicta_online_apply_progress('[
    {"id":"9ec20000-0000-4000-8000-000000000004","at":100,"kind":"grade","key":["office","0"],"value":{"score":50}},
    {"id":"9ec20000-0000-4000-8000-000000000003","at":500,"kind":"day","key":["2026-11-25"],"value":{"seconds":31,"checks":1}},
    {"id":"9ec20000-0000-4000-8000-000000000005","at":350,"kind":"answer","key":["office","0"],"value":{"text":"a new attempt","score":10}},
    {"id":"9ec20000-0000-4000-8000-000000000006","at":200,"kind":"setting","key":["goal"],"value":20}
  ]');
  select value into saved from public.dicta_online_state;
  if (saved#>>'{progress,office,answers,0,score}') is distinct from '100'
    or (saved#>>'{progress,office,answers,0,text}') is distinct from 'a new attempt'
    or (saved#>>'{progress,office,answers,1,score}') is distinct from '80'
    or (saved#>>'{progress,legacy,answers,0,score}') is distinct from '90'
    or (saved#>>'{days,2026-11-25,seconds}') is distinct from '31'
    or (saved#>>'{settings,goal}') is distinct from '20'
  then raise exception 'The merged state lost or duplicated data'; end if;
  begin
    perform public.dicta_online_save_state('{}', 251);
    raise exception 'Legacy clients must not overwrite the migrated state';
  exception when feature_not_supported then null;
  end;
  begin
    perform public.dicta_online_apply_progress('[{
      "id":"9ec20000-0000-4000-8000-000000000007","at":250,"kind":"setting",
      "key":["__proto__"],"value":{},"user_id":"9ec10000-0000-4000-8000-000000000002"
    }]');
    raise exception 'Invalid and unsafe change keys must be rejected';
  exception when invalid_parameter_value then null;
  end;
end;
$test$;

select set_config('request.jwt.claim.sub','9ec10000-0000-4000-8000-000000000002',true);
do $test$
begin
  if exists(select 1 from public.dicta_online_state) then raise exception 'Another account could read state'; end if;
  perform public.dicta_online_apply_progress('[{
    "id":"9ec20000-0000-4000-8000-000000000010","at":310,"kind":"setting","key":["goal"],"value":35,
    "user_id":"9ec10000-0000-4000-8000-000000000001"
  }]');
  if not exists(select 1 from public.dicta_online_state where value#>>'{settings,goal}' = '35')
  then raise exception 'Changes must be bound to the authenticated account'; end if;
end;
$test$;

select set_config('request.jwt.claim.sub','9ec10000-0000-4000-8000-000000000001',true);
do $test$
begin
  if not exists(select 1 from public.dicta_online_state where value#>>'{settings,goal}' = '20')
  then raise exception 'Another account wrote to this account'; end if;
end;
$test$;

rollback;
