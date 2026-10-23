-- Real RPC behavior with temporary accounts/data; never uses real user passwords.
begin;
set local statement_timeout='60s';
do $$
declare
  uid uuid:=gen_random_uuid(); viewer uuid:=gen_random_uuid(); cam text:='QA-IMPORT-'||gen_random_uuid()::text;
  d jsonb; r jsonb; batch uuid; request uuid; a public.alerts; version bigint; start_time timestamptz; seen integer;
  changes jsonb; i integer; outcome text; payload jsonb;
begin
  insert into auth.users(id,email,email_confirmed_at) values(uid,uid::text||'@example.invalid',now()),(viewer,viewer::text||'@example.invalid',now());
  insert into public.app_members(user_id,member_role) values(uid,'editor'),(viewer,'viewer');
  perform set_config('request.jwt.claim.sub',uid::text,true);perform set_config('role','authenticated',true);
  d:=jsonb_build_object('cam_id',cam,'business_user_id','QA-USER','converted_at','2026-10-01T08:00:00+08:00',
    'last_order_at','2026-10-02T08:00:00+08:00','order_count',5,'paid_order_count',3,'is_lost',false,'lost_on',null,
    'product_title','Original title','source_extras',jsonb_build_object('套餐','Advanced'),
    'source_tags',jsonb_build_array('唐华','unmapped商品','新品','推荐供端缺少SKU'));
  request:=gen_random_uuid();
  r:=public.op_import_file('begin',jsonb_build_object('request_id',request,'file_name','test.xlsx','file_sha256',repeat('a',64),'sheet_name','Data','total_rows',1,'chunk_count',1));batch:=(r->'batch'->>'id')::uuid;
  payload:=jsonb_build_array(jsonb_build_object('row_number',2,'data',d,'expected_version',null,'parse_issues','[]'::jsonb));
  perform public.op_import_file('chunk',jsonb_build_object('batch_id',batch,'chunk_no',0,'rows',payload));
  r:=public.op_import_file('process',jsonb_build_object('batch_id',batch));
  if r->'batch'->>'inserted_rows'<>'1' or (r->>'done')::boolean is not true then raise exception 'New CAM import failed';end if;
  if not exists(select 1 from public.cams where cam_id=cam and owners=array['唐华'] and conversion_reasons=array['Unmmapped商品'] and source_extras->>'套餐'='Advanced') then raise exception 'Server tag extraction or hidden fields failed';end if;
  select started_at into start_time from public.cam_order_periods where cam_id=cam and ended_at is null;
  if start_time<>'2026-10-01T08:00:00+08:00'::timestamptz then raise exception 'Historical start failed';end if;
  select count(*) into seen from public.audit_events where entity_id=cam;
  perform public.op_import_file('chunk',jsonb_build_object('batch_id',batch,'chunk_no',0,'rows',payload));
  perform public.op_import_file('process',jsonb_build_object('batch_id',batch));
  if (select count(*) from public.audit_events where entity_id=cam)<>seen then raise exception 'Retry duplicated writes';end if;
  perform public.op_manual_cam('update',cam,1,'{"conversion_notes":"manual note"}');
  d:=d||'{"order_count":6,"paid_order_count":4,"last_order_at":"2026-10-03T08:00:00+08:00","product_title":"Ignored replacement","converted_at":"2026-10-03T08:00:00+08:00"}'::jsonb;
  for i in 1..8 loop
    select row_version into version from public.cams where cam_id=cam;
    changes:=case i when 1 then '{}'::jsonb when 2 then '{}'::jsonb
      when 3 then '{"order_count":4,"paid_order_count":2}'::jsonb
      when 4 then '{"is_lost":true,"lost_on":"2026-10-04"}'::jsonb
      when 5 then '{"last_order_at":"2026-10-04T23:59:00+08:00"}'::jsonb
      when 6 then '{"last_order_at":"2026-10-05T00:00:00+08:00"}'::jsonb
      when 7 then '{"last_order_at":"2026-10-06T00:00:00+08:00"}'::jsonb
      else '{"lost_on":"2026-10-07"}'::jsonb end;
    d:=d||changes;
    r:=public.op_import_file('begin',jsonb_build_object('request_id',gen_random_uuid(),'file_name','daily.xlsx','file_sha256',repeat('b',64),'total_rows',1,'chunk_count',1));batch:=(r->'batch'->>'id')::uuid;
    perform public.op_import_file('chunk',jsonb_build_object('batch_id',batch,'chunk_no',0,'rows',jsonb_build_array(jsonb_build_object('row_number',2,'data',d,'expected_version',version))));
    r:=public.op_import_file('process',jsonb_build_object('batch_id',batch));
    if i=2 then
      if r->'batch'->>'unchanged_rows'<>'1' or (select row_version from public.cams where cam_id=cam)<>version then raise exception 'Unchanged import edited CAM';end if;
    elsif i=3 then
      if r->'batch'->>'flagged_rows'<>'1' or (select order_count from public.cams where cam_id=cam)<>6 then raise exception 'Regression was not held';end if;
      select * into a from public.alerts where cam_id=cam and alert_state='pending';
      if not a.is_confirmable then raise exception 'Reviewable regression blocked';end if;
      perform set_config('request.jwt.claim.sub',viewer::text,true);
      begin perform public.op_resolve_alert(a.id,a.row_version,'confirm');raise exception 'Viewer confirmed alert';exception when insufficient_privilege then null;end;
      perform set_config('request.jwt.claim.sub',uid::text,true);
      r:=public.op_resolve_alert(a.id,a.row_version,'confirm');
      if (r->>'ok')::boolean is not true or (select order_count from public.cams where cam_id=cam)<>4 then raise exception 'Approval did not replace totals';end if;
      r:=public.op_resolve_alert(a.id,a.row_version,'confirm');if r->>'code'<>'conflict' then raise exception 'Double approval accepted';end if;
    else
      if r->'batch'->>'updated_rows'<>'1' then raise exception 'Daily update failed at case %: %',i,r;end if;
    end if;
    if not exists(select 1 from public.cams where cam_id=cam and conversion_notes='manual note' and product_title='Original title' and converted_at='2026-10-01T08:00:00+08:00') then raise exception 'Daily import overwrote manual/identity fields';end if;
    if i=5 and (select conversion_status from public.cams where cam_id=cam)<>'已流失' then raise exception 'Same-day return incorrectly counted';end if;
    if i=6 and (select conversion_status from public.cams where cam_id=cam)<>'流失又回' then raise exception 'Next-day return failed';end if;
    if i=7 and (select started_at from public.cam_order_periods where cam_id=cam and ended_at is null)<>'2026-10-05T00:00:00+08:00'::timestamptz then raise exception 'Later order reset active start';end if;
  end loop;
  if (select sum(extract(epoch from ended_at-started_at)) from public.cam_order_periods where cam_id=cam)<>403200 then raise exception 'Loss gap or multiple periods calculated incorrectly';end if;
  -- A manual edit after the warning invalidates an older approval.
  select row_version into version from public.cams where cam_id=cam;
  d:=d||'{"order_count":3,"paid_order_count":1}'::jsonb;
  r:=public.op_import_file('begin',jsonb_build_object('request_id',gen_random_uuid(),'file_name','stale.xlsx','file_sha256',repeat('c',64),'total_rows',1,'chunk_count',1));batch:=(r->'batch'->>'id')::uuid;
  perform public.op_import_file('chunk',jsonb_build_object('batch_id',batch,'chunk_no',0,'rows',jsonb_build_array(jsonb_build_object('row_number',2,'data',d,'expected_version',version))));
  perform public.op_import_file('process',jsonb_build_object('batch_id',batch));
  select * into a from public.alerts where cam_id=cam and alert_state='pending';
  perform public.op_manual_cam('update',cam,version,'{"loss_notes":"new manual edit"}');
  r:=public.op_resolve_alert(a.id,a.row_version,'confirm');if r->>'code'<>'conflict' then raise exception 'Stale approval overwrote newer edit';end if;
  perform public.op_resolve_alert(a.id,a.row_version,'ignore');
  -- Invalid source values cannot be confirmed.
  select row_version into version from public.cams where cam_id=cam;
  d:=d||'{"order_count":-1}'::jsonb;
  r:=public.op_import_file('begin',jsonb_build_object('request_id',gen_random_uuid(),'file_name','invalid.xlsx','file_sha256',repeat('d',64),'total_rows',1,'chunk_count',1));batch:=(r->'batch'->>'id')::uuid;
  perform public.op_import_file('chunk',jsonb_build_object('batch_id',batch,'chunk_no',0,'rows',jsonb_build_array(jsonb_build_object('row_number',2,'data',d,'expected_version',version))));
  perform public.op_import_file('process',jsonb_build_object('batch_id',batch));
  select * into a from public.alerts where cam_id=cam and alert_state='pending';if a.is_confirmable then raise exception 'Invalid count confirmable';end if;
  -- Conflicting duplicate CAMs across separate chunks must not partly insert.
  d:=d||jsonb_build_object('cam_id',cam||'-duplicate','order_count',1,'paid_order_count',0,'is_lost',false,'lost_on',null,'converted_at','2026-10-01T08:00:00+08:00');
  r:=public.op_import_file('begin',jsonb_build_object('request_id',gen_random_uuid(),'file_name','duplicate.xlsx','file_sha256',repeat('e',64),'total_rows',2,'chunk_count',2));batch:=(r->'batch'->>'id')::uuid;
  perform public.op_import_file('chunk',jsonb_build_object('batch_id',batch,'chunk_no',0,'rows',jsonb_build_array(jsonb_build_object('row_number',2,'data',d))));
  begin perform public.op_import_file('process',jsonb_build_object('batch_id',batch));raise exception 'Incomplete upload processed';exception when raise_exception then if sqlerrm<>'文件分块尚未收齐，请重试上传' then raise;end if;end;
  perform public.op_import_file('chunk',jsonb_build_object('batch_id',batch,'chunk_no',1,'rows',jsonb_build_array(jsonb_build_object('row_number',3,'data',d||'{"order_count":2}'::jsonb))));
  perform public.op_import_file('process',jsonb_build_object('batch_id',batch));r:=public.op_import_file('process',jsonb_build_object('batch_id',batch));
  if exists(select 1 from public.cams where cam_id=cam||'-duplicate') or r->'batch'->>'duplicate_rows'<>'1' or r->'batch'->>'flagged_rows'<>'1' then raise exception 'Cross-chunk duplicate conflict failed';end if;
  -- Identical duplicates, including ignored operational tags, merge across chunks.
  d:=d||jsonb_build_object('cam_id',cam||'-identical');
  r:=public.op_import_file('begin',jsonb_build_object('request_id',gen_random_uuid(),'file_name','identical.xlsx','file_sha256',repeat('f',64),'total_rows',2,'chunk_count',2));batch:=(r->'batch'->>'id')::uuid;
  perform public.op_import_file('chunk',jsonb_build_object('batch_id',batch,'chunk_no',0,'rows',jsonb_build_array(jsonb_build_object('row_number',2,'data',d))));
  perform public.op_import_file('chunk',jsonb_build_object('batch_id',batch,'chunk_no',1,'rows',jsonb_build_array(jsonb_build_object('row_number',3,'data',d||jsonb_build_object('source_tags',(d->'source_tags')||'["9.14运营商品"]'::jsonb)))));
  perform public.op_import_file('process',jsonb_build_object('batch_id',batch));r:=public.op_import_file('process',jsonb_build_object('batch_id',batch));
  if r->'batch'->>'inserted_rows'<>'1' or r->'batch'->>'duplicate_rows'<>'1' or r->'batch'->>'flagged_rows'<>'0' then raise exception 'Identical duplicates did not merge';end if;
  begin perform public.op_import_file(null,jsonb_build_object('batch_id',batch));raise exception 'Null mode accepted';exception when raise_exception then if sqlerrm<>'不支持的导入操作' then raise;end if;end;
  -- Cancel abandons staging only; it never removes already saved CAMs.
  r:=public.op_import_file('begin',jsonb_build_object('request_id',gen_random_uuid(),'file_name','cancel.xlsx','file_sha256',repeat('a',64),'total_rows',2,'chunk_count',2));batch:=(r->'batch'->>'id')::uuid;
  perform public.op_import_file('chunk',jsonb_build_object('batch_id',batch,'chunk_no',0,'rows',jsonb_build_array(jsonb_build_object('row_number',2,'data',d))));
  r:=public.op_import_file('cancel',jsonb_build_object('batch_id',batch));if r->'batch'->>'batch_state'<>'failed' then raise exception 'Cancellation failed';end if;
  perform set_config('request.jwt.claim.sub',viewer::text,true);
  begin perform public.op_import_file('begin','{}');raise exception 'Viewer import bypass';exception when insufficient_privilege then null;end;
  perform set_config('role','postgres',true);
  if exists(select 1 from order_project_private.import_uploads where batch_id=batch) then raise exception 'Cancelled staging retained';end if;
  if order_project_private.import_time('2026-10-23T09:00:00+99:99') is not null then raise exception 'Invalid timezone accepted';end if;
end;
$$;
rollback;
select 'PASS: cloud imports, replay, daily fields, shared alerts, confirmation CAS, validation, duplicate staging and continuous periods; fixtures rolled back' as result;
