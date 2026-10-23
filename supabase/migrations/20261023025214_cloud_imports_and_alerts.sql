-- Cloud imports: upload all chunks before processing; each processing RPC is atomic.
alter table public.import_batches add column duplicate_rows integer not null default 0 check(duplicate_rows>=0);
create table order_project_private.import_uploads (
  batch_id uuid primary key references public.import_batches(id) on delete cascade,
  chunk_count integer not null check(chunk_count between 1 and 100),
  sealed boolean not null default false,
  first_rows jsonb not null default '{}',
  conflicting_cams text[] not null default '{}'
);
create table order_project_private.import_chunks (
  batch_id uuid not null references order_project_private.import_uploads(batch_id) on delete cascade,
  chunk_no integer not null check(chunk_no>=0),
  payload jsonb not null check(jsonb_typeof(payload)='array'),
  payload_hash text not null,
  processed boolean not null default false,
  primary key(batch_id,chunk_no)
);
alter table order_project_private.import_uploads enable row level security;
alter table order_project_private.import_chunks enable row level security;
revoke all on order_project_private.import_uploads,order_project_private.import_chunks from public,anon,authenticated;
create policy import_uploads_closed on order_project_private.import_uploads for all using(false) with check(false);
create policy import_chunks_closed on order_project_private.import_chunks for all using(false) with check(false);
comment on table order_project_private.import_chunks is '导入暂存：整份文件收齐后处理，完成后清除payload，只留请求校验摘要';

create function order_project_private.import_issue(p_type text,p_field text,p_before jsonb,p_after jsonb,p_message text,p_hard boolean default true)
returns jsonb language sql immutable security invoker set search_path='' as $$
  select jsonb_build_array(jsonb_build_object('type',p_type,'field',p_field,'before',coalesce(p_before,'""'::jsonb),
    'after',coalesce(p_after,'""'::jsonb),'message',p_message,'hard',p_hard));
$$;
create function order_project_private.import_time(p_value text,p_date_only boolean default false)
returns timestamptz language plpgsql immutable security invoker set search_path='' as $$
begin
  if p_date_only then
    if p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return null; end if;
    return p_value::date::timestamp at time zone 'Asia/Shanghai';
  end if;
  if p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?(Z|[+-][0-9]{2}:[0-9]{2})$' then return null; end if;
  return p_value::timestamptz;
exception when invalid_datetime_format or datetime_field_overflow then return null;
end;
$$;

create function order_project_private.import_count(p_value jsonb)
returns bigint language plpgsql immutable security invoker set search_path='' as $$
declare v text:=p_value#>>'{}'; n numeric;
begin
  if v is null or v !~ '^[0-9]+$' then return null; end if;
  n:=v::numeric;
  if n>9007199254740991 then return null; end if;
  return n::bigint;
exception when numeric_value_out_of_range then return null;
end;
$$;
create function order_project_private.import_tags(p_value jsonb)
returns text[] language plpgsql immutable security invoker set search_path='' as $$
declare v text[];
begin
  if p_value is null or p_value='null' then return '{}'; end if;
  if jsonb_typeof(p_value)<>'array' or jsonb_array_length(p_value)>100 then return null; end if;
  if exists(select 1 from jsonb_array_elements(p_value) a where jsonb_typeof(a)<>'string' or length(a#>>'{}')>300) then return null; end if;
  select coalesce(array_agg(t order by ord),'{}') into v from (
    select t,min(ord) ord from (
      select case when lower(regexp_replace(btrim(x),'\s','','g')) in ('unmapped商品','unmmapped商品') then 'Unmmapped商品'
        when lower(regexp_replace(btrim(x),'\s','','g')) in ('未通过dsers下单','未通过dsers下单行为') then '未通过DSers下单行为'
        else btrim(x) end t,ord from jsonb_array_elements_text(p_value) with ordinality a(x,ord)
    ) a where t<>'' group by t
  ) a;
  return v;
end;
$$;

create function order_project_private.evaluate_import(p_data jsonb,p_parse jsonb,p_old public.cams)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare
  n public.cams:=p_old; problems jsonb:='[]'; k text; label text; t timestamptz;
  tags text[]; all_tags text[]; reasons text[]; hit text[];
  known text[]:=array['高价值用户','有DSers下单行为','未通过DSers下单行为','原供库存不足','原供物流不可用','价格优势','部分价优','推荐供端库存充足','推荐供端部分SKU库存较少','库存较少','AE断联','Unmmapped商品','1688商品'];
  mutex jsonb:='[["高价值用户","有DSers下单行为","未通过DSers下单行为"],["原供库存不足","原供物流不可用"],["价格优势","部分价优"],["推荐供端库存充足","推荐供端部分SKU库存较少","库存较少"]]'; grp jsonb;
begin
  if jsonb_typeof(p_data)<>'object' then raise exception '导入行必须是对象'; end if;
  -- Parser diagnostics may add a block, never grant permission or bypass server validation.
  if jsonb_typeof(p_parse)='array' and jsonb_array_length(p_parse)>0 then
    problems:=problems||order_project_private.import_issue('文件解析异常','源文件',null,p_parse,'源文件包含编号精度或解析异常，请修正后重传');
  end if;
  n.cam_id:=btrim(p_data->>'cam_id');
  if coalesce(n.cam_id,'')='' or length(n.cam_id)>200 or jsonb_typeof(p_data->'cam_id')<>'string' then
    problems:=problems||order_project_private.import_issue('CAM匹配异常','转化CAM',null,p_data->'cam_id','CAM编号必须是非空文本');
  end if;
  if coalesce(btrim(p_data->>'business_user_id'),'')='' or jsonb_typeof(p_data->'business_user_id')<>'string' then
    problems:=problems||order_project_private.import_issue('CAM归属冲突','user_id',null,p_data->'business_user_id','缺少有效文本用户ID');
  elsif p_old.cam_id is not null and p_old.business_user_id<>btrim(p_data->>'business_user_id') then
    problems:=problems||order_project_private.import_issue('CAM归属冲突','user_id',to_jsonb(p_old.business_user_id),p_data->'business_user_id','同一CAM对应不同用户ID，请修正文件');
  end if;
  if p_old.cam_id is not null and p_old.deleted_at is not null then
    problems:=problems||order_project_private.import_issue('CAM匹配异常','转化CAM',null,p_data->'cam_id','CAM已删除，不能通过导入自动恢复');
  end if;
  foreach k in array array['order_count','paid_order_count'] loop
    label:=case k when 'order_count' then '转化下单量' else '支付订单' end;
    if order_project_private.import_count(p_data->k) is null then
      problems:=problems||order_project_private.import_issue('订单值无效',label,to_jsonb(p_old)->k,p_data->k,'订单量必须为非负安全整数，不能缺失');
    elsif p_old.cam_id is not null and order_project_private.import_count(p_data->k)<(to_jsonb(p_old)->>k)::bigint then
      problems:=problems||order_project_private.import_issue('异常订单预警',label,to_jsonb(p_old)->k,p_data->k,label||'低于历史累计值',false);
    end if;
  end loop;
  n.order_count:=order_project_private.import_count(p_data->'order_count');
  n.paid_order_count:=order_project_private.import_count(p_data->'paid_order_count');
  n.is_lost:=case lower(p_data->>'is_lost') when 'true' then true when 'yes' then true when '是' then true
    when 'false' then false when 'no' then false when '否' then false else null end;
  if n.is_lost is null then problems:=problems||order_project_private.import_issue('流失信息缺失','是否流失',null,p_data->'is_lost','是否流失只能为yes/no或是/否'); end if;
  n.last_order_at:=order_project_private.import_time(p_data->>'last_order_at');
  if coalesce(p_data->>'last_order_at','')<>'' and n.last_order_at is null then
    problems:=problems||order_project_private.import_issue('日期逻辑异常','最近下单日期',null,p_data->'last_order_at','最近下单时间无效或缺少时区');
  end if;
  if n.order_count>0 and n.last_order_at is null or p_old.last_order_at is not null and n.last_order_at is null then
    problems:=problems||order_project_private.import_issue('关键更新字段缺失','最近下单日期',to_jsonb(p_old.last_order_at),p_data->'last_order_at','有订单或已有历史下单时间时，最近下单时间不能缺失');
  end if;
  if n.last_order_at<p_old.last_order_at then
    problems:=problems||order_project_private.import_issue('最近下单时间回退','最近下单日期',to_jsonb(p_old.last_order_at),p_data->'last_order_at','最近下单时间早于历史值',false);
  end if;
  t:=order_project_private.import_time(p_data->>'lost_on',true);
  n.lost_on:=(t at time zone 'Asia/Shanghai')::date;
  if coalesce(p_data->>'lost_on','')<>'' and t is null or n.is_lost and t is null then
    problems:=problems||order_project_private.import_issue('流失信息缺失','流失日期',null,p_data->'lost_on','流失日期无效，或已流失但缺少日期');
  end if;
  if p_old.cam_id is null then
    n.business_user_id:=btrim(p_data->>'business_user_id');n.converted_at:=order_project_private.import_time(p_data->>'converted_at');
    n.registration_email:=coalesce(p_data->>'registration_email','');n.product_title:=coalesce(p_data->>'product_title','');n.conversion_url:=coalesce(p_data->>'conversion_url','');
    n.conversion_notes:='';n.loss_reasons:='{}';n.loss_notes:='';n.actions:='{}';n.backup_supplier:='';n.completion_tags:='{}';
    n.source_extras:=coalesce(p_data->'source_extras','{}');
    if jsonb_typeof(n.source_extras)<>'object' or octet_length(n.source_extras::text)>65536 then
      problems:=problems||order_project_private.import_issue('文件解析异常','隐藏源字段',null,null,'隐藏字段必须为对象且不超过64KB');n.source_extras:='{}';
    end if;
    foreach k in array array['countries','ad_placements','owners','fulfillment_apps','conversion_reasons'] loop
      tags:=order_project_private.import_tags(p_data->k);
      if tags is null then problems:=problems||order_project_private.import_issue('标签冲突',k,null,p_data->k,'标签必须是长度合理的文本数组');tags:='{}';end if;
      case k when 'countries' then n.countries:=tags; when 'ad_placements' then n.ad_placements:=tags;
        when 'owners' then n.owners:=tags; when 'fulfillment_apps' then n.fulfillment_apps:=tags; else n.conversion_reasons:=tags; end case;
    end loop;
    if p_data ? 'source_tags' and p_data->'source_tags'<>'null' then
      all_tags:=order_project_private.import_tags(p_data->'source_tags');
      if all_tags is null then problems:=problems||order_project_private.import_issue('标签冲突','标签',null,null,'源标签格式无效');all_tags:='{}';end if;
      select coalesce(array_agg(x),'{}') into n.owners from unnest(all_tags) x where x in ('唐华','庞遵毅')
        or x in (select unnest(owners) from public.cams where deleted_at is null);
      n.conversion_reasons:=array(select x from unnest(known) x where x=any(all_tags));
    else n.conversion_reasons:=array(select x from unnest(known) x where x=any(n.conversion_reasons)); end if;
  end if;
  if n.converted_at is null then problems:=problems||order_project_private.import_issue('关键更新字段缺失','转化日期',null,p_data->'converted_at','缺少有效且带时区的转化日期'); end if;
  if n.last_order_at<n.converted_at or n.lost_on<(n.converted_at at time zone 'Asia/Shanghai')::date then
    problems:=problems||order_project_private.import_issue('日期逻辑异常','日期',to_jsonb(n.converted_at),null,'最近下单或流失日期早于转化日期');
  end if;
  if n.paid_order_count>n.order_count then
    problems:=problems||order_project_private.import_issue('支付量大于下单量','支付订单',to_jsonb(n.order_count),to_jsonb(n.paid_order_count),'支付订单大于下单量，请人工复核',false);
  end if;
  for grp in select value from jsonb_array_elements(mutex) loop
    hit:=array(select x from jsonb_array_elements_text(grp) x where x=any(n.conversion_reasons));
    if cardinality(hit)>1 then problems:=problems||order_project_private.import_issue('标签冲突','转化原因',null,to_jsonb(hit),'互斥原因标签同时出现');end if;
  end loop;
  return jsonb_build_object('candidate',to_jsonb(n),'problems',problems,
    'hard',exists(select 1 from jsonb_array_elements(problems) a where (a->>'hard')::boolean));
end;
$$;

create function order_project_private.apply_import(p_old public.cams,p_candidate jsonb,p_batch uuid,p_except_alert uuid default null)
returns public.cams language plpgsql security invoker set search_path='' as $$
declare n public.cams:=jsonb_populate_record(null::public.cams,p_candidate); saved public.cams; active public.cam_order_periods;
  v_stop timestamptz; v_start timestamptz; new_status text; diff jsonb;
begin
  if p_old.cam_id is null then
    insert into public.cams(cam_id,business_user_id,registration_email,countries,converted_at,ad_placements,owners,product_title,conversion_url,
      last_order_at,order_count,paid_order_count,fulfillment_apps,is_lost,conversion_reasons,lost_on,source_extras)
    values(n.cam_id,n.business_user_id,n.registration_email,n.countries,n.converted_at,n.ad_placements,n.owners,n.product_title,n.conversion_url,
      n.last_order_at,n.order_count,n.paid_order_count,n.fulfillment_apps,n.is_lost,n.conversion_reasons,n.lost_on,n.source_extras) returning * into saved;
  else
    update public.cams set last_order_at=n.last_order_at,order_count=n.order_count,paid_order_count=n.paid_order_count,is_lost=n.is_lost,lost_on=n.lost_on
      where cam_id=p_old.cam_id returning * into saved;
    if not found then return p_old; end if;
  end if;
  new_status:=saved.conversion_status;
  v_stop:=saved.lost_on::timestamp at time zone 'Asia/Shanghai';
  select * into active from public.cam_order_periods where cam_id=saved.cam_id and ended_at is null for update;
  if p_old.cam_id is null and saved.order_count>0 then
    if new_status in ('已流失','流失又回') then
      if v_stop>=saved.converted_at then insert into public.cam_order_periods(cam_id,started_at,ended_at,is_estimated,estimate_source,import_batch_id)
        values(saved.cam_id,saved.converted_at,v_stop,true,'历史首次下单不清晰，以转化日期估算',p_batch);end if;
      if new_status='流失又回' then insert into public.cam_order_periods(cam_id,started_at,is_estimated,import_batch_id)
        values(saved.cam_id,saved.last_order_at,false,p_batch);end if;
    else insert into public.cam_order_periods(cam_id,started_at,is_estimated,estimate_source,import_batch_id)
      values(saved.cam_id,saved.converted_at,true,'历史首次下单不清晰，以转化日期估算',p_batch);end if;
  elsif p_old.cam_id is not null then
    if new_status in ('已流失','流失又回') then
      if active.id is not null and (p_old.conversion_status not in ('已流失','流失又回') or saved.lost_on is distinct from p_old.lost_on) then
        update public.cam_order_periods set ended_at=greatest(active.started_at,v_stop) where id=active.id;
        active.id:=null;
      elsif saved.lost_on is distinct from p_old.lost_on and p_old.lost_on is not null then
        update public.cam_order_periods set ended_at=greatest(started_at,v_stop)
          where id=(select id from public.cam_order_periods where cam_id=saved.cam_id
            and ended_at=p_old.lost_on::timestamp at time zone 'Asia/Shanghai' order by started_at desc limit 1);
      end if;
      if new_status='已流失' and active.id is not null then
        update public.cam_order_periods set ended_at=greatest(started_at,v_stop) where id=active.id;
      elsif new_status='流失又回' and active.id is null then
        insert into public.cam_order_periods(cam_id,started_at,is_estimated,import_batch_id) values(saved.cam_id,saved.last_order_at,false,p_batch);
      end if;
    elsif new_status='待下单' and active.id is not null then
      -- A confirmed correction to zero does not create fictitious active duration.
      delete from public.cam_order_periods where id=active.id;
    elsif new_status='下单中' and active.id is null then
      insert into public.cam_order_periods(cam_id,started_at,is_estimated,import_batch_id) values(saved.cam_id,saved.last_order_at,false,p_batch);
    end if;
  end if;
  select coalesce(jsonb_object_agg(k,jsonb_build_object('before',to_jsonb(p_old)->k,'after',v)),'{}') into diff
    from jsonb_each(to_jsonb(saved)) a(k,v) where k<>all(array['row_version','created_at','updated_at','updated_by']) and v is distinct from to_jsonb(p_old)->k;
  insert into public.audit_events(entity_kind,entity_id,operation,changed_fields,actor_id,import_batch_id)
    values('cam',saved.cam_id,case when p_old.cam_id is null then 'insert' else 'update' end,diff,auth.uid(),p_batch);
  update public.alerts set alert_state='superseded',resolved_at=statement_timestamp(),resolved_by=auth.uid()
    where cam_id=saved.cam_id and alert_state='pending' and (p_except_alert is null or id<>p_except_alert);
  return saved;
end;
$$;
create function order_project_private.cloud_import(p_mode text,p_args jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  uid uuid:=auth.uid(); role_name text; b public.import_batches; upload order_project_private.import_uploads;
  chunk order_project_private.import_chunks; body jsonb; data jsonb; old public.cams; saved public.cams; evaluated jsonb; problems jsonb;
  cam text; row_no integer; expected bigint; fingerprint text; chunk_hash text; v_alert uuid;
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
      count(distinct jsonb_build_object('data',r->'data','parse',coalesce(r->'parse_issues','[]'))) variants
      from rows where coalesce(btrim(r->'data'->>'cam_id'),'')<>'' group by 1)
    select coalesce(jsonb_object_agg(cam,first_row),'{}'),coalesce(array_agg(cam) filter(where variants>1),'{}') into all_first,conflicts from grouped;
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
      fingerprint:=encode(sha256(convert_to(jsonb_build_object('cam',cam,'row',case when coalesce(cam,'')='' then row_no else null end,
        'version',old.row_version,'data',data,'issues',problems)::text,'UTF8')),'hex');
      if not exists(select 1 from public.alerts where public.alerts.fingerprint=cloud_import.fingerprint) then
        update public.alerts set alert_state='superseded',resolved_at=statement_timestamp(),resolved_by=uid
          where source_cam_id=cam and coalesce(cam,'')<>'' and alert_state='pending';
        insert into public.alerts(cam_id,source_cam_id,import_batch_id,source_rows,alert_type,fingerprint,expected_version,
          is_confirmable,before_values,candidate_values,issues)
        values(old.cam_id,cam,b.id,array[row_no],case when exists(select 1 from jsonb_array_elements(problems) p where p->>'type'='异常订单预警') then '异常订单预警' else '数据异常预警' end,
          fingerprint,old.row_version,not hard,coalesce(to_jsonb(old),'{}'),data,problems) returning id into v_alert;
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

create function order_project_private.resolve_import_alert(p_id uuid,p_expected_version bigint,p_decision text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); role_name text; a public.alerts; old public.cams; evaluated jsonb; saved public.cams; cam text;
begin
  if uid is null then raise exception using errcode='42501',message='请先登录';end if;
  select member_role into role_name from public.app_members where user_id=uid and is_active for share;
  if role_name is null or role_name not in ('admin','editor') then raise exception using errcode='42501',message='当前账号没有处理预警权限';end if;
  if p_decision is null or p_decision not in ('confirm','ignore') then raise exception '不支持的预警处理';end if;
  perform pg_advisory_xact_lock(hashtextextended('order-project-import',0));
  select coalesce(cam_id,source_cam_id) into cam from public.alerts where id=p_id;
  select * into old from public.cams where cam_id=cam for update;
  select * into a from public.alerts where id=p_id for update;
  if not found then return jsonb_build_object('ok',false,'code','not_found');end if;
  if a.alert_state<>'pending' or a.row_version is distinct from p_expected_version then return jsonb_build_object('ok',false,'code','conflict');end if;
  if p_decision='confirm' then
    if not a.is_confirmable then raise exception '该预警不能直接确认，请修正文件后重传';end if;
    if a.expected_version is distinct from old.row_version or old.deleted_at is not null then return jsonb_build_object('ok',false,'code','conflict');end if;
    evaluated:=order_project_private.evaluate_import(a.candidate_values,'[]',old);
    if (evaluated->>'hard')::boolean then raise exception '重新校验未通过，请修正文件后重传';end if;
    saved:=order_project_private.apply_import(old,evaluated->'candidate',a.import_batch_id,a.id);
  end if;
  update public.alerts set alert_state=case when p_decision='confirm' then 'accepted' else 'ignored' end,
    resolved_by=uid,resolved_at=statement_timestamp() where id=p_id;
  insert into public.audit_events(entity_kind,entity_id,operation,changed_fields,actor_id,import_batch_id)
    values('alert',p_id::text,case when p_decision='confirm' then 'approve' else 'ignore' end,
      jsonb_build_object('state',jsonb_build_object('before','pending','after',case when p_decision='confirm' then 'accepted' else 'ignored' end)),uid,a.import_batch_id);
  return jsonb_build_object('ok',true);
end;
$$;

revoke all on all functions in schema order_project_private from public,anon,authenticated;
-- Preserve the two read helpers required by existing RLS/generated-column access.
grant execute on function order_project_private.current_member_role(),order_project_private.cam_status(boolean,bigint,timestamptz,date),
  order_project_private.claim_admin(),order_project_private.manual_cam(text,text,bigint,jsonb),order_project_private.set_member(text,text,boolean,bigint),
  order_project_private.list_members(),order_project_private.cloud_import(text,jsonb),order_project_private.resolve_import_alert(uuid,bigint,text) to authenticated;
create function public.op_import_file(p_mode text,p_args jsonb) returns jsonb language sql security invoker set search_path='' as $$
  select order_project_private.cloud_import(p_mode,p_args);
$$;
create function public.op_resolve_alert(p_id uuid,p_expected_version bigint,p_decision text) returns jsonb language sql security invoker set search_path='' as $$
  select order_project_private.resolve_import_alert(p_id,p_expected_version,p_decision);
$$;
revoke all on function public.op_import_file(text,jsonb),public.op_resolve_alert(uuid,bigint,text) from public,anon;
grant execute on function public.op_import_file(text,jsonb),public.op_resolve_alert(uuid,bigint,text) to authenticated;
notify pgrst,'reload schema';
