begin;
insert into auth.users(id) values ('bcd00000-0000-4000-8000-000000000001'),('bcd00000-0000-4000-8000-000000000002');
set local role service_role;
do $test$
declare
  owner constant uuid := 'bcd00000-0000-4000-8000-000000000001';
  other constant uuid := 'bcd00000-0000-4000-8000-000000000002';
  lesson constant jsonb := '{"title":"Test","transcript":"Hello","segments":[{"text":"Hello","start":null,"end":null}]}';
  assigned jsonb;
  started jsonb;
begin
  perform public.dicta_online_create_lesson(owner,'youtube-id',lesson || '{"youtubeId":"M7lc1UVf-VE"}',0,null,30000000);
  assigned := public.dicta_online_create_lesson(owner,'audio-id',lesson,30000000,'mp3',30000000);
  if assigned->>'pending' <> 'true' then raise exception 'Audio must be reserved before transfer'; end if;
  begin
    perform public.dicta_online_create_lesson(owner,'audio-2',lesson,1,'mp3',30000000);
    raise exception 'Two simultaneous reservations may not overbook one account';
  exception when raise_exception then
    if sqlerrm <> 'ACCOUNT_AUDIO_QUOTA' then raise; end if;
  end;
  started := public.dicta_online_begin_upload(owner,'audio-id');
  begin
    perform public.dicta_online_begin_upload(owner,'audio-id');
    raise exception 'Another uploader cannot take a live reservation';
  exception when raise_exception then
    if sqlerrm <> 'UPLOAD_BUSY' then raise; end if;
  end;
  perform public.dicta_online_abort_upload(owner,'audio-id',(started->>'lease')::uuid);
  perform public.dicta_online_create_lesson(owner,'audio-id',lesson,30000000,'mp3',30000000);
  begin
    perform public.dicta_online_begin_delete(other,'youtube-id');
    raise exception 'Cannot delete other owner lesson';
  exception when raise_exception then
    if sqlerrm <> 'LESSON_NOT_FOUND' then raise; end if;
  end;
  perform public.dicta_online_update_timing(owner,'youtube-id','[{"start":0,"end":2}]');
end;
$test$;

reset role;
insert into storage.objects(bucket_id,name,metadata)
values ('other','other/audio.m4a','{"size":869999999}');
insert into storage.objects(bucket_id,name,metadata)
select 'dicta-online-audio',audio_path,'{"size":2}'::jsonb
from public.dicta_online_lessons where lesson_id='audio-id';
set local role service_role;
do $test$
declare
  other constant uuid := 'bcd00000-0000-4000-8000-000000000002';
  lesson constant jsonb := '{"title":"Second","transcript":"Hi","segments":[{"text":"Hi","start":null,"end":null}]}';
begin
  perform public.dicta_online_create_lesson(other,'one-byte',lesson,1,'m4a',30000000);
  begin
    perform public.dicta_online_create_lesson(other,'two-byte',lesson,1,'m4a',30000000);
    raise exception 'Cannot exceed the project budget';
  exception when raise_exception then
    if sqlerrm <> 'PROJECT_AUDIO_QUOTA' then raise; end if;
  end;
end;
$test$;

reset role;
update storage.objects o set metadata='{"size":30000000}'::jsonb
from public.dicta_online_lessons l where o.name=l.audio_path and l.lesson_id='audio-id';
set local role service_role;
do $test$
declare
  owner constant uuid := 'bcd00000-0000-4000-8000-000000000001';
  finished jsonb;
  shared_path text;
begin
  perform public.dicta_online_reconcile_uploads(owner);
  select jsonb_build_object('pending',upload_pending) into finished from public.dicta_online_lessons
    where user_id=owner and lesson_id='audio-id';
  if finished->>'pending' <> 'false' then raise exception 'An already stored object should safely resume'; end if;
  if public.dicta_online_claim_failed_upload(owner,'audio-id',gen_random_uuid())->>'audioPath' is not null
  then raise exception 'Cleanup must not remove published audio'; end if;
  select audio_path into shared_path from public.dicta_online_lessons where user_id=owner and lesson_id='audio-id';
  perform public.dicta_online_import(owner,'{}',jsonb_build_array(jsonb_build_object(
    'lesson_id','audio-copy','lesson','{"segments":[]}'::jsonb,'audio_path',shared_path)));
  if public.dicta_online_begin_delete(owner,'audio-copy')->>'audioPath' is not null
  then raise exception 'Shared source within one account must remain'; end if;
  perform public.dicta_online_finish_delete(owner,'audio-copy');
  if public.dicta_online_begin_delete(owner,'audio-id')->>'audioPath' is distinct from shared_path
  then raise exception 'Last reference must be deleted from storage'; end if;
  begin
    perform public.dicta_online_finish_delete(owner,'audio-id');
    raise exception 'Quota may not be released before Storage deletion';
  exception when raise_exception then
    if sqlerrm <> 'MEDIA_DELETE_PENDING' then raise; end if;
  end;
end;
$test$;

set local role authenticated;
select set_config('request.jwt.claim.sub','bcd00000-0000-4000-8000-000000000002',true);
do $test$
begin
  if exists(select 1 from public.dicta_online_lessons)
     or exists(select 1 from storage.objects where bucket_id='dicta-online-audio') then
    raise exception 'Other account or unfinished lesson is exposed';
  end if;
  begin
    perform public.dicta_online_begin_delete('bcd00000-0000-4000-8000-000000000002','one-byte');
    raise exception 'Authenticated client may not call privileged write RPC';
  exception when insufficient_privilege then null;
  end;
end;
$test$;

rollback;
