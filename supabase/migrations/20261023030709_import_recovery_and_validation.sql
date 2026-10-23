create or replace function order_project_private.cloud_import(p_mode text,p_args jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  uid uuid:=auth.uid(); role_name text; b public.import_batches; upload order_project_private.import_uploads;
  chunk order_project_private.import_chunks; body jsonb; data jsonb; old public.cams; saved public.cams; evaluated jsonb; problems jsonb;
  cam text; row_no integer; expected bigint; v_fingerprint text; chunk_hash text; v_alert uuid;
  inserted integer:=0; updated integer:=0; unchanged integer:=0; flagged integer:=0; duplicates integer:=0;
  all_first jsonb; conflicts text[]; supplied integer; distinct_rows integer; hard boolean; daily_old jsonb; daily_new jsonb;
begin
  if uid is null then raise exception using errcode='42501',message='请先登录';end if;
  select member_role into role_name from public.app_members where user_id=uid and is_active for share;
  if role_name is null or role_name not in ('admin','editor') then raise exception using errcode='42501',message='当前账号没有导入权限';end if;
  if jsonb_typeof(p_args)<>'object' then raise exception '导入参数无效';end if;
  if p_mode='begin' then
    if coalesce(length(btrim(p_args->>'file_name')),0) not between 1 and 255
      or coalesce(p_args->>'file_sha256','') !~ '^[0-9a-f]{64}$'
      or (p_args->>'total_rows')::integer not between 1 and 10000
      or (p_args->>'chunk_count')::integer not between 1 and 100
      or p_args->>'total_rows' is null or p_args->>'chunk_count' is null or p_args->>'request_id' is null then
      raise exception '文件信息无效：单次支持1至10000条数据';
    end if;
    insert into public.import_batches(request_id,file_name,file_sha256,sheet_name,total_rows,imported_by)
      values((p_args->>'request_id')::uuid,p_args->>'file_name',p_args->>'file_sha256',coalesce(p_args->>'sheet_name',''),(p_args->>'total_rows')::integer,uid)
      on conflict(request_id) do nothing;
    select * into b from public.import_batches where request_id=(p_args->>'request_id')::uuid for update;
    if b.imported_by is distinct from uid or b.file_sha256<>p_args->>'file_sha256' or b.file_name<>p_args->>'file_name'
      or b.sheet_name<>coalesce(p_args->>'sheet_name','') or b.total_rows<>(p_args->>'total_rows')::integer then
      raise exception '同一请求标识不能用于其他文件或账号';
    end if;
    insert into order_project_private.import_uploads(batch_id,chunk_count) values(b.id,(p_args->>'chunk_count')::integer) on conflict do nothing;
    if (select chunk_count from order_project_private.import_uploads where batch_id=b.id)<>(p_args->>'chunk_count')::integer then raise exception '重试的文件分块数不一致';end if;
    return jsonb_build_object('batch',to_jsonb(b));
  end if;
  if p_mode='process' then perform pg_advisory_xact_lock(hashtextextended('order-project-import',0));end if;
  select * into b from public.import_batches where id=(p_args->>'batch_id')::uuid for update;
  if not found or b.imported_by is distinct from uid then raise exception using errcode='42501',message='导入批次不存在或不属于当前账号';end if;
  select * into upload from order_project_private.import_uploads where batch_id=b.id for update;
  if p_mode='cancel' then
    if b.finished_at is not null then return jsonb_build_object('ok',true,'batch',to_jsonb(b));end if;
    delete from order_project_private.import_uploads where batch_id=b.id;
    update public.import_batches set batch_state='failed',finished_at=statement_timestamp() where id=b.id returning * into b;
    insert into public.audit_events(entity_kind,entity_id,operation,changed_fields,actor_id,import_batch_id)
      values('import_batch',b.id::text,'update',jsonb_build_object('state','failed','reason','用户终止未完成导入，已保存记录保留'),uid,b.id);
    return jsonb_build_object('ok',true,'batch',to_jsonb(b));
  end if;
  if b.batch_state='failed' then raise exception '批次已终止，请重新选择文件开始新导入';end if;
  if p_mode='chunk' then
    body:=p_args->'rows';
    if jsonb_typeof(body)<>'array' or body is null then raise exception '导入分块必须为数组';end if;
    if jsonb_array_length(body) not between 1 and 200 or octet_length(body::text)>1048576
      or (p_args->>'chunk_no')::integer not between 0 and upload.chunk_count-1 or p_args->>'chunk_no' is null then raise exception '分块大小或序号无效，请拆分文件';end if;
    if exists(select 1 from jsonb_array_elements(body) r where jsonb_typeof(r)<>'object' or jsonb_typeof(r->'data') is distinct from 'object'
      or coalesce(r->>'row_number','') !~ '^[1-9][0-9]{0,7}$' or jsonb_typeof(coalesce(r->'parse_issues','[]'))<>'array'
      or (r->>'expected_version' is not null and r->>'expected_version' !~ '^[1-9][0-9]{0,14}$')) then raise exception '分块行格式无效';end if;
    chunk_hash:=encode(sha256(convert_to(body::text,'UTF8')),'hex');
    select * into chunk from order_project_private.import_chunks where batch_id=b.id and chunk_no=(p_args->>'chunk_no')::integer;
    if found then
      if chunk.payload_hash<>chunk_hash then raise exception '重试内容与已上传分块不同，请重新开始导入';end if;
      return jsonb_build_object('ok',true);
    end if;
    if upload.sealed or b.batch_state<>'prepared' then raise exception '导入已封存，不能添加分块';end if;
    insert into order_project_private.import_chunks(batch_id,chunk_no,payload,payload_hash) values(b.id,(p_args->>'chunk_no')::integer,body,chunk_hash);
    return jsonb_build_object('ok',true);
  elsif p_mode<>'process' then raise exception '不支持的导入操作';end if;
  if b.batch_state in ('completed','partially_completed') then return jsonb_build_object('done',true,'batch',to_jsonb(b));end if;
  -- Concurrent imports/approvals serialize; each call commits at most 200 source rows.
  if not upload.sealed then
    if (select count(*) from order_project_private.import_chunks where batch_id=b.id)<>upload.chunk_count then raise exception '文件分块尚未收齐，请重试上传';end if;
    select count(*),count(distinct (r->>'row_number')::integer) into supplied,distinct_rows
      from order_project_private.import_chunks c cross join lateral jsonb_array_elements(c.payload) r where c.batch_id=b.id;
    if supplied<>b.total_rows or supplied<>distinct_rows then raise exception '文件行数量或源行号不一致';end if;
    with rows as (select r from order_project_private.import_chunks c cross join lateral jsonb_array_elements(c.payload) r where c.batch_id=b.id),
    grouped as (select btrim(r->'data'->>'cam_id') cam,min((r->>'row_number')::integer) first_row,
      count(distinct jsonb_build_object('data',(r->'data')-'source_tags','parse',coalesce(r->'parse_issues','[]'))) variants
      from rows where coalesce(btrim(r->'data'->>'cam_id'),'')<>'' group by 1)
    select coalesce(jsonb_object_agg(g.cam,g.first_row),'{}'),coalesce(array_agg(g.cam) filter(where g.variants>1),'{}') into all_first,conflicts from grouped g;
    update order_project_private.import_uploads set sealed=true,first_rows=all_first,conflicting_cams=conflicts where batch_id=b.id returning * into upload;
    update public.import_batches set batch_state='processing' where id=b.id;
  end if;
  select * into chunk from order_project_private.import_chunks where batch_id=b.id and not processed order by chunk_no limit 1 for update;
  if not found then raise exception '批次状态不一致';end if;
  for body in select value from jsonb_array_elements(chunk.payload) loop
    data:=body->'data';cam:=btrim(data->>'cam_id');row_no:=(body->>'row_number')::integer;
    if coalesce(cam,'')<>'' and (upload.first_rows->>cam)::integer<>row_no then duplicates:=duplicates+1;continue;end if;
    old:=null;select * into old from public.cams where cam_id=cam for update;
    evaluated:=order_project_private.evaluate_import(data,coalesce(body->'parse_issues','[]'),old);
    problems:=evaluated->'problems';
    if cam=any(upload.conflicting_cams) then problems:=problems||order_project_private.import_issue('CAM匹配异常','转化CAM',to_jsonb(cam),to_jsonb(cam),'文件内同一CAM存在冲突记录，整组不写入');end if;
    expected:=(body->>'expected_version')::bigint;
    if expected is distinct from old.row_version then problems:=problems||order_project_private.import_issue('数据版本冲突','转化CAM',to_jsonb(expected),to_jsonb(old.row_version),'预览后记录已变化，请刷新名单后重新上传');end if;
    hard:=exists(select 1 from jsonb_array_elements(problems) p where (p->>'hard')::boolean);
    if jsonb_array_length(problems)>0 then
      v_fingerprint:=encode(sha256(convert_to(jsonb_build_object('cam',cam,'row',case when coalesce(cam,'')='' then row_no else null end,
        'version',old.row_version,'data',data,'issues',problems)::text,'UTF8')),'hex');
      if not exists(select 1 from public.alerts where public.alerts.fingerprint=v_fingerprint) then
        update public.alerts set alert_state='superseded',resolved_at=statement_timestamp(),resolved_by=uid
          where source_cam_id=cam and coalesce(cam,'')<>'' and alert_state='pending';
        insert into public.alerts(cam_id,source_cam_id,import_batch_id,source_rows,alert_type,fingerprint,expected_version,
          is_confirmable,before_values,candidate_values,issues)
        values(old.cam_id,cam,b.id,array[row_no],case when exists(select 1 from jsonb_array_elements(problems) p where p->>'type'='异常订单预警') then '异常订单预警' else '数据异常预警' end,
          v_fingerprint,old.row_version,not hard,coalesce(to_jsonb(old),'{}'),data,problems) returning id into v_alert;
        insert into public.audit_events(entity_kind,entity_id,operation,changed_fields,actor_id,import_batch_id)
          values('alert',v_alert::text,'insert',jsonb_build_object('state','pending','cam',cam),uid,b.id);
      end if;
      flagged:=flagged+1;continue;
    end if;
    daily_old:=jsonb_build_array(old.last_order_at,old.order_count,old.paid_order_count,old.is_lost,old.lost_on);
    daily_new:=jsonb_build_array(evaluated->'candidate'->'last_order_at',evaluated->'candidate'->'order_count',evaluated->'candidate'->'paid_order_count',evaluated->'candidate'->'is_lost',evaluated->'candidate'->'lost_on');
    if old.cam_id is not null and daily_old=daily_new then
      update public.alerts set alert_state='superseded',resolved_at=statement_timestamp(),resolved_by=uid where cam_id=old.cam_id and alert_state='pending';
      unchanged:=unchanged+1;continue;end if;
    saved:=order_project_private.apply_import(old,evaluated->'candidate',b.id);
    if old.cam_id is null then inserted:=inserted+1;else updated:=updated+1;end if;
  end loop;
  update order_project_private.import_chunks set processed=true where batch_id=b.id and chunk_no=chunk.chunk_no;
  update public.import_batches set inserted_rows=inserted_rows+inserted,updated_rows=updated_rows+updated,
    unchanged_rows=unchanged_rows+unchanged,flagged_rows=flagged_rows+flagged,duplicate_rows=duplicate_rows+duplicates where id=b.id;
  if not exists(select 1 from order_project_private.import_chunks where batch_id=b.id and not processed) then
    update public.import_batches set batch_state=case when flagged_rows>0 then 'partially_completed' else 'completed' end,finished_at=statement_timestamp() where id=b.id;
    -- Retain receipt hashes, discard whole-file payload after successful processing.
    update order_project_private.import_chunks set payload='[]' where batch_id=b.id;
    update order_project_private.import_uploads set first_rows='{}',conflicting_cams='{}' where batch_id=b.id;
    insert into public.audit_events(entity_kind,entity_id,operation,changed_fields,actor_id,import_batch_id)
      values('import_batch',b.id::text,'import',jsonb_build_object('processed',true),uid,b.id);
  end if;
  select * into b from public.import_batches where id=b.id;
  return jsonb_build_object('done',b.finished_at is not null,'processed_chunk',chunk.chunk_no,'batch',to_jsonb(b));
end;
$$;

create or replace function order_project_private.import_time(p_value text,p_date_only boolean default false)
returns timestamptz language plpgsql immutable security invoker set search_path='' as $$
begin
  if p_date_only then
    if p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return null; end if;
    return p_value::date::timestamp at time zone 'Asia/Shanghai';
  end if;
  if p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?(Z|[+-][0-9]{2}:[0-9]{2})$' then return null; end if;
  return p_value::timestamptz;
exception when invalid_datetime_format or datetime_field_overflow or invalid_time_zone_displacement_value then return null;
end;
$$;

