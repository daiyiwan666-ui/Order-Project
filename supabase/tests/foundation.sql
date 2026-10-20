-- Run as database administrator against the foundation migration.
-- All temporary Auth users and business fixtures are rolled back.
begin;

do $$
declare
  v_member uuid := gen_random_uuid();
  v_outsider uuid := gen_random_uuid();
  v_cam text := 'foundation-test-' || gen_random_uuid()::text;
  v_role text;
  v_version bigint;
  v_updated timestamptz;
  v_count integer;
begin
  if (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and c.relrowsecurity
    and c.relname in ('app_members','cams','order_projects','import_batches','alerts','cam_order_periods','audit_events')) <> 7 then
    raise exception 'Expected RLS on all seven tables';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prosecdef) then
    raise exception 'Unexpected exposed security-definer function';
  end if;

  insert into auth.users(id,email) values
    (v_member, v_member::text || '@example.invalid'),
    (v_outsider, v_outsider::text || '@example.invalid');
  perform set_config('request.jwt.claim.sub',v_member::text,true);
  insert into public.app_members(user_id,member_role) values (v_member,'admin');
  insert into public.cams(cam_id,business_user_id,converted_at,last_order_at,order_count,paid_order_count,is_lost)
    values (v_cam,'20928156567025090001','2026-10-01 08:00+08','2026-10-02 08:00+08',1,0,false);
  if not exists (select 1 from public.cams where cam_id=v_cam and conversion_status='下单中'
    and conversion_year=2026 and conversion_quarter=4 and row_version=1 and updated_by=v_member) then
    raise exception 'Initial generated status, period, version, actor or long ID failed';
  end if;
  select row_version,updated_at into v_version,v_updated from public.cams where cam_id=v_cam;
  update public.cams set conversion_notes=conversion_notes,row_version=99,updated_at=now()+interval '1 day' where cam_id=v_cam;
  if not exists (select 1 from public.cams where cam_id=v_cam and row_version=v_version and updated_at=v_updated) then
    raise exception 'No-op edit changed metadata';
  end if;
  update public.cams set conversion_notes='manual note',row_version=99 where cam_id=v_cam;
  if (select row_version from public.cams where cam_id=v_cam) <> 2 then
    raise exception 'Real edit did not advance server-maintained version';
  end if;
  update public.cams set conversion_notes='stale overwrite' where cam_id=v_cam and row_version=1;
  get diagnostics v_count = row_count;
  if v_count <> 0 then raise exception 'Stale version was not excluded'; end if;

  update public.cams set order_count=0,last_order_at=null where cam_id=v_cam;
  if (select conversion_status from public.cams where cam_id=v_cam) <> '待下单' then
    raise exception 'Waiting status failed';
  end if;
  update public.cams set order_count=2,is_lost=true,lost_on='2026-10-03',last_order_at='2026-10-03 23:59+08' where cam_id=v_cam;
  if (select conversion_status from public.cams where cam_id=v_cam) <> '已流失' then
    raise exception 'Same-calendar-day order must remain lost';
  end if;
  update public.cams set last_order_at='2026-10-04 00:00+08' where cam_id=v_cam;
  if (select conversion_status from public.cams where cam_id=v_cam) <> '流失又回' then
    raise exception 'Next-calendar-day return status failed';
  end if;
  -- Reviewable anomaly: database permits a human-confirmed payment total above orders.
  update public.cams set paid_order_count=3 where cam_id=v_cam;
  begin
    update public.cams set order_count=-1 where cam_id=v_cam;
    raise exception 'Negative count unexpectedly accepted';
  exception when check_violation then null; end;
  begin
    insert into public.cams(cam_id,business_user_id,converted_at,order_count,paid_order_count,is_lost)
      values (v_cam,'other','2026-10-01 08:00+08',1,0,false);
    raise exception 'Duplicate CAM unexpectedly accepted';
  exception when unique_violation then null; end;
  begin
    update public.cams set last_order_at='2026-09-30 08:00+08' where cam_id=v_cam;
    raise exception 'Impossible timeline unexpectedly accepted';
  exception when check_violation then null; end;

  insert into public.cam_order_periods(cam_id,started_at) values (v_cam,'2026-10-01 08:00+08');
  begin
    insert into public.cam_order_periods(cam_id,started_at) values (v_cam,'2026-10-02 08:00+08');
    raise exception 'Two active periods unexpectedly accepted';
  exception when unique_violation then null; end;
  begin
    insert into public.cam_order_periods(cam_id,started_at,ended_at)
      values (v_cam,'2026-10-02 08:00+08','2026-10-01 08:00+08');
    raise exception 'Reversed period unexpectedly accepted';
  exception when check_violation then null; end;
  insert into public.alerts(cam_id,alert_type,fingerprint) values (v_cam,'order_decrease',v_cam);
  begin
    insert into public.alerts(cam_id,alert_type,fingerprint) values (v_cam,'order_decrease',v_cam);
    raise exception 'Duplicate pending alert unexpectedly accepted';
  exception when unique_violation then null; end;

  foreach v_role in array array['admin','editor','viewer'] loop
    update public.app_members set member_role=v_role where user_id=v_member;
    perform set_config('role','authenticated',true);
    if not exists (select 1 from public.cams where cam_id=v_cam) then
      raise exception 'Enabled member cannot read CAM';
    end if;
    if has_table_privilege('public.cams','INSERT') or has_table_privilege('public.cams','UPDATE')
      or has_table_privilege('public.cams','DELETE') then
      raise exception 'Direct client writes must remain closed until versioned RPCs exist';
    end if;
    perform set_config('role','postgres',true);
  end loop;

  update public.app_members set is_active=false where user_id=v_member;
  perform set_config('role','authenticated',true);
  if exists (select 1 from public.cams where cam_id=v_cam) then
    raise exception 'Inactive member can read CAM';
  end if;
  perform set_config('role','postgres',true);
  perform set_config('request.jwt.claim.sub',v_outsider::text,true);
  perform set_config('role','authenticated',true);
  if exists (select 1 from public.cams where cam_id=v_cam) or exists (select 1 from public.app_members) then
    raise exception 'Non-member can read business data or membership';
  end if;
  perform set_config('role','postgres',true);
  perform set_config('role','anon',true);
  if has_table_privilege('public.cams','SELECT') then raise exception 'Anonymous table read is open'; end if;
  begin
    perform count(*) from public.cams;
    raise exception 'Anonymous query unexpectedly succeeded';
  exception when insufficient_privilege then null; end;
  perform set_config('role','postgres',true);
end;
$$;

rollback;
select 'foundation checks passed; all test data rolled back' as result;
