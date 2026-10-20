-- Temporary fixtures only. Run as postgres. Never use real passwords.
begin;
do $$
declare
  v_admin uuid:=gen_random_uuid(); v_editor uuid:=gen_random_uuid(); v_viewer uuid:=gen_random_uuid();
  v_stranger uuid:=gen_random_uuid(); v_unverified uuid:=gen_random_uuid();
  v_email text; v_cam text:='manual-test-'||gen_random_uuid()::text; v_result jsonb; v_n bigint;
begin
  if exists(select 1 from public.app_members where member_role='admin' and is_active) then
    raise exception 'Run these bootstrap tests only before real members are onboarded';
  end if;
  v_email:=v_admin::text||'@example.invalid';
  insert into auth.users(id,email,email_confirmed_at) values
    (v_admin,v_email,now()),(v_editor,v_editor::text||'@example.invalid',now()),
    (v_viewer,v_viewer::text||'@example.invalid',now()),(v_stranger,v_stranger::text||'@example.invalid',now()),
    (v_unverified,v_unverified::text||'@example.invalid',null);
  insert into order_project_private.bootstrap_admin(email) values(v_email),(v_unverified::text||'@example.invalid');
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claim.sub',v_unverified::text,true);
  begin
    perform public.op_claim_admin(); raise exception 'Unverified admin claim accepted';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub',v_stranger::text,true);
  v_result:=public.op_claim_admin();
  if v_result->'member'<>'null'::jsonb then raise exception 'Unlisted email gained membership'; end if;
  begin
    perform public.op_manual_cam('create',v_cam,null,'{}');raise exception 'Non-member write accepted';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  v_result:=public.op_claim_admin();
  if v_result->'member'->>'member_role'<>'admin' then raise exception 'Verified bootstrap failed'; end if;
  perform public.op_claim_admin(); -- Repeated bootstrap must not insert or escalate again.
  perform public.op_set_member(v_editor::text||'@example.invalid','editor');
  perform public.op_set_member(v_viewer::text||'@example.invalid','viewer');
  begin
    perform public.op_set_member(v_email,'viewer',true,1);raise exception 'Last admin downgrade accepted';
  exception when raise_exception then
    if sqlerrm<>'不能停用或降级最后一位管理员' then raise; end if;
  end;
  if jsonb_array_length(public.op_list_members())<>3 then raise exception 'Admin member listing failed'; end if;

  v_result:=public.op_manual_cam('create',v_cam,null,
    jsonb_build_object('business_user_id','20928156567025090001','converted_at','2026-10-20T09:00:00+08:00'));
  if (v_result->>'ok')::boolean is not true or v_result->'record'->>'conversion_status'<>'待下单'
    or v_result->'record'->>'updated_by'<>v_admin::text then raise exception 'Create defaults or actor failed'; end if;
  begin
    perform public.op_manual_cam('create',v_cam,null,
      jsonb_build_object('business_user_id','other','converted_at','2026-10-20T09:00:00+08:00'));
    raise exception 'Duplicate CAM accepted';
  exception when unique_violation then null; end;
  begin
    perform public.op_manual_cam('update',v_cam,1,'{"order_count":99}');raise exception 'Order whitelist bypass accepted';
  exception when raise_exception then
    if sqlerrm not like '包含不允许人工修改的字段%' then raise; end if;
  end;
  begin
    perform public.op_manual_cam('update',v_cam,1,'{"loss_reasons":[123]}');raise exception 'Invalid tag accepted';
  exception when raise_exception then
    if sqlerrm<>'标签格式或长度不正确' then raise; end if;
  end;
  perform set_config('request.jwt.claim.sub',v_editor::text,true);
  v_result:=public.op_manual_cam('update',v_cam,1,'{"conversion_notes":"editor note","actions":["复盘"]}');
  if v_result->'record'->>'row_version'<>'2' or v_result->'record'->>'updated_by'<>v_editor::text then
    raise exception 'Editor write/version/actor failed';
  end if;
  v_result:=public.op_manual_cam('update',v_cam,1,'{"conversion_notes":"stale note"}');
  if v_result->>'code'<>'conflict' or v_result->'current'->>'conversion_notes'<>'editor note' then
    raise exception 'Stale write did not return current record';
  end if;
  select count(*) into v_n from public.audit_events where entity_id=v_cam;
  perform public.op_manual_cam('update',v_cam,2,'{"conversion_notes":"editor note"}');
  if (select count(*) from public.audit_events where entity_id=v_cam)<>v_n
    or (select row_version from public.cams where cam_id=v_cam)<>2 then raise exception 'No-op generated history'; end if;
  begin
    perform public.op_manual_cam('delete',v_cam,2);raise exception 'Editor delete accepted';
  exception when insufficient_privilege then null; end;
  begin
    perform public.op_set_member(v_email,'viewer',true,1);raise exception 'Editor membership write accepted';
  exception when insufficient_privilege then null; end;
  begin
    update public.cams set conversion_notes='direct write' where cam_id=v_cam;raise exception 'Direct write accepted';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub',v_viewer::text,true);
  if not exists(select 1 from public.cams where cam_id=v_cam) then raise exception 'Viewer read failed'; end if;
  begin
    perform public.op_manual_cam('update',v_cam,2,'{"conversion_notes":"viewer"}');raise exception 'Viewer write accepted';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  v_result:=public.op_manual_cam('delete',v_cam,2);
  if (v_result->>'ok')::boolean is not true or exists(select 1 from public.cams where cam_id=v_cam) then
    raise exception 'Soft deletion is visible to members';
  end if;
  if (select count(*) from public.audit_events where entity_id=v_cam)<>3 then raise exception 'Expected insert/update/delete history'; end if;
  perform public.op_set_member(v_editor::text||'@example.invalid','editor',false,1);
  perform set_config('request.jwt.claim.sub',v_editor::text,true);
  begin
    perform public.op_manual_cam('create',v_cam||'-inactive',null,'{}');raise exception 'Inactive editor accepted';
  exception when insufficient_privilege then null; end;
  perform set_config('role','postgres',true);
  perform set_config('role','anon',true);
  begin
    perform public.op_claim_admin();raise exception 'Anonymous RPC accepted';
  exception when insufficient_privilege then null; end;
  perform set_config('role','postgres',true);
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef) then
    raise exception 'Exposed security-definer function';
  end if;
end;
$$;
rollback;
select 'manual write, membership, conflict and audit checks passed; fixtures rolled back' as result;
