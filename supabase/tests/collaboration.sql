-- Safe to run after real administrators have registered. No bootstrap changes.
-- Temporary accounts are inserted inside a rollback transaction, without passwords
-- or email delivery. This tests SQL/RPC behavior, not browser authentication.
begin isolation level repeatable read;
set local statement_timeout = '15s';
set local lock_timeout = '3s';

do $$
declare
  v_admin uuid:=gen_random_uuid(); v_editor uuid:=gen_random_uuid();
  v_viewer uuid:=gen_random_uuid(); v_outsider uuid:=gen_random_uuid();
  v_cam text:='QA-SQL-'||gen_random_uuid()::text;
  v_result jsonb; v_count bigint; v_time timestamptz;
begin
  insert into auth.users(id,email,email_confirmed_at) values
    (v_admin,v_admin::text||'@example.invalid',now()),
    (v_editor,v_editor::text||'@example.invalid',now()),
    (v_viewer,v_viewer::text||'@example.invalid',now()),
    (v_outsider,v_outsider::text||'@example.invalid',now());
  insert into public.app_members(user_id,member_role) values
    (v_admin,'admin'),(v_editor,'editor'),(v_viewer,'viewer');
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  perform set_config('role','authenticated',true);
  v_result:=public.op_manual_cam('create',v_cam,null,
    jsonb_build_object('business_user_id','QA-SQL-USER','converted_at','2026-10-23T09:00:00+08:00','product_title','SQL rollback test'));
  if (v_result->>'ok')::boolean is not true or v_result->'record'->>'conversion_status'<>'待下单'
    or v_result->'record'->>'updated_by'<>v_admin::text then raise exception 'Create/default/actor failed'; end if;
  if not exists(select 1 from public.cams where cam_id=v_cam and row_version=1 and order_count=0 and paid_order_count=0) then
    raise exception 'Read after create failed'; end if;
  perform set_config('request.jwt.claim.sub',v_editor::text,true);
  v_result:=public.op_manual_cam('update',v_cam,1,
    '{"conversion_notes":"QA备注","loss_reasons":["待复盘"],"loss_notes":"QA流失备注","actions":["QA操作"],"backup_supplier":"https://example.invalid/supplier","completion_tags":["待完成"]}');
  if (v_result->>'ok')::boolean is not true or v_result->'record'->>'row_version'<>'2'
    or v_result->'record'->>'updated_by'<>v_editor::text then raise exception 'Editor change/version/actor failed'; end if;
  if not exists(select 1 from public.cams where cam_id=v_cam and conversion_notes='QA备注'
    and loss_reasons=array['待复盘'] and actions=array['QA操作'] and completion_tags=array['待完成']) then
    raise exception 'Six-field persistence failed'; end if;
  select updated_at into v_time from public.cams where cam_id=v_cam;
  select count(*) into v_count from public.audit_events where entity_id=v_cam;
  perform public.op_manual_cam('update',v_cam,2,'{"conversion_notes":"QA备注"}');
  if (select row_version from public.cams where cam_id=v_cam)<>2
    or (select updated_at from public.cams where cam_id=v_cam)<>v_time
    or (select count(*) from public.audit_events where entity_id=v_cam)<>v_count then raise exception 'No-op changed metadata/history'; end if;
  v_result:=public.op_manual_cam('update',v_cam,1,'{"conversion_notes":"stale overwrite"}');
  if v_result->>'code'<>'conflict' or v_result->'current'->>'conversion_notes'<>'QA备注' then raise exception 'Stale version accepted'; end if;
  begin
    perform public.op_manual_cam('update',v_cam,2,'{"order_count":123}');raise exception 'Source field bypass';
  exception when raise_exception then
    if sqlerrm not like '包含不允许人工修改的字段%' then raise; end if;
  end;
  begin
    update public.cams set conversion_notes='direct write' where cam_id=v_cam;raise exception 'Direct write bypass';
  exception when insufficient_privilege then null; end;
  begin
    perform public.op_manual_cam('delete',v_cam,2);raise exception 'Editor delete bypass';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub',v_viewer::text,true);
  if not exists(select 1 from public.cams where cam_id=v_cam and conversion_notes='QA备注') then raise exception 'Viewer cannot see editor change'; end if;
  begin
    perform public.op_manual_cam('update',v_cam,2,'{"conversion_notes":"viewer overwrite"}');raise exception 'Viewer write bypass';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub',v_outsider::text,true);
  if exists(select 1 from public.cams where cam_id=v_cam) then raise exception 'Non-member can read CAM'; end if;
  begin
    perform public.op_manual_cam('create',v_cam||'-outsider',null,'{}');raise exception 'Non-member write bypass';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  v_result:=public.op_manual_cam('delete',v_cam,1);
  if v_result->>'code'<>'conflict' then raise exception 'Stale delete accepted'; end if;
  v_result:=public.op_manual_cam('delete',v_cam,2);
  if (v_result->>'ok')::boolean is not true or exists(select 1 from public.cams where cam_id=v_cam) then raise exception 'Soft-deleted row remains visible'; end if;
  perform set_config('role','postgres',true);
  if not exists(select 1 from public.cams where cam_id=v_cam and deleted_at is not null and row_version=3) then raise exception 'Deletion history missing'; end if;
  if (select count(*) from public.audit_events where entity_id=v_cam)<>3 then raise exception 'Expected create/update/delete audit events'; end if;
  if exists(select 1 from public.audit_events where entity_id=v_cam and actor_id not in (v_admin,v_editor)) then raise exception 'Wrong audit actor'; end if;
  perform set_config('role','anon',true);
  begin
    perform public.op_manual_cam('update',v_cam,3,'{}');raise exception 'Anonymous RPC bypass';
  exception when insufficient_privilege then null; end;
  perform set_config('role','postgres',true);
end;
$$;

rollback;
select 'PASS: shared reads, six manual fields, no-op, stale writes/deletes, roles, soft deletion and audit; all SQL fixtures rolled back' as result;
