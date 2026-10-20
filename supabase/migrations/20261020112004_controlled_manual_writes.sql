-- Stage 2: authenticated manual CAM operations; bulk import is a separate workflow.
alter table public.cams add column deleted_at timestamptz;
comment on column public.cams.deleted_at is '软删除时间：保留历史、预警和出单区间，不再显示在活动名单';
drop policy members_read_cams on public.cams;
create policy members_read_cams on public.cams for select to authenticated
  using (deleted_at is null and (select order_project_private.current_member_role()) in ('admin','editor','viewer'));

create table order_project_private.bootstrap_admin (
  email text primary key,
  claimed_by uuid references auth.users(id) on delete restrict,
  claimed_at timestamptz
);
alter table order_project_private.bootstrap_admin enable row level security;
create index bootstrap_admin_claimed_by_idx on order_project_private.bootstrap_admin(claimed_by);
revoke all on order_project_private.bootstrap_admin from public,anon,authenticated;
insert into order_project_private.bootstrap_admin(email) values ('daiyiwan666@gmail.com');

-- Privileged work is confined to a non-exposed schema. Every entry checks Auth
-- and current membership; public wrappers remain SECURITY INVOKER.
create function order_project_private.claim_admin()
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_email text; v_member public.app_members;
begin
  if v_uid is null then raise exception using errcode='42501',message='请先登录'; end if;
  select lower(email) into v_email from auth.users where id=v_uid and email_confirmed_at is not null;
  if v_email is null then raise exception using errcode='42501',message='请先完成邮箱验证'; end if;
  perform 1 from order_project_private.bootstrap_admin where email=v_email for update;
  if not found then
    select * into v_member from public.app_members where user_id=v_uid and is_active;
    return jsonb_build_object('member',case when found then to_jsonb(v_member) else null end);
  end if;
  if not exists (select 1 from order_project_private.bootstrap_admin where email=v_email and claimed_by is null)
    or exists (select 1 from public.app_members where member_role='admin' and is_active) then
    select * into v_member from public.app_members where user_id=v_uid and is_active;
    return jsonb_build_object('member',case when found then to_jsonb(v_member) else null end);
  end if;
  insert into public.app_members(user_id,display_name,member_role)
    values (v_uid,'管理员','admin') returning * into v_member;
  update order_project_private.bootstrap_admin set claimed_by=v_uid,claimed_at=statement_timestamp() where email=v_email;
  insert into public.audit_events(entity_kind,entity_id,operation,changed_fields,actor_id)
    values ('member',v_uid::text,'insert',jsonb_build_object('member_role',jsonb_build_object('before',null,'after','admin')),v_uid);
  return jsonb_build_object('member',to_jsonb(v_member));
end;
$$;

create function order_project_private.manual_cam(
  p_action text,p_cam_id text,p_expected_version bigint,p_changes jsonb
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid(); v_role text; v_old public.cams; v_new public.cams;
  v_patch jsonb := coalesce(p_changes,'{}'); v_diff jsonb; v_key text;
  v_allowed text[] := array['conversion_notes','loss_reasons','loss_notes','actions','backup_supplier','completion_tags'];
begin
  if v_uid is null then raise exception using errcode='42501',message='请先登录'; end if;
  select member_role into v_role from public.app_members where user_id=v_uid and is_active for share;
  if v_role is null or v_role not in ('admin','editor') then
    raise exception using errcode='42501',message='当前账号没有编辑权限';
  end if;
  if p_action is null or p_action not in ('create','update','delete') then raise exception '不支持的操作'; end if;
  if p_cam_id is null or btrim(p_cam_id)='' or p_cam_id<>btrim(p_cam_id) or length(p_cam_id)>200 then
    raise exception 'CAM编号不能为空，且必须保持文本格式';
  end if;
  if jsonb_typeof(v_patch)<>'object' then raise exception '修改内容必须是对象'; end if;
  if p_action='create' then
    if p_expected_version is not null then raise exception '新增记录不接受历史版本'; end if;
    v_allowed := v_allowed || array['business_user_id','registration_email','converted_at','product_title','countries'];
  elsif p_action='delete' then
    if v_role<>'admin' then raise exception using errcode='42501',message='仅管理员可以删除CAM'; end if;
    if v_patch<>'{}' then raise exception '删除操作不接受字段修改'; end if;
  end if;
  if exists(select 1 from jsonb_object_keys(v_patch) as k where not (k=any(v_allowed))) then
    raise exception '包含不允许人工修改的字段；订单和流失状态须经文件更新流程处理';
  end if;
  foreach v_key in array array['conversion_notes','loss_notes','backup_supplier','business_user_id','registration_email','product_title','converted_at'] loop
    if v_patch ? v_key and (jsonb_typeof(v_patch->v_key)<>'string' or length(v_patch->>v_key)>20000) then
      raise exception '文本字段格式不正确';
    end if;
  end loop;
  foreach v_key in array array['loss_reasons','actions','completion_tags','countries'] loop
    if v_patch ? v_key then
      if jsonb_typeof(v_patch->v_key)<>'array' then raise exception '标签必须使用数组格式'; end if;
      if jsonb_array_length(v_patch->v_key)>100 or exists(select 1 from jsonb_array_elements(v_patch->v_key) a
        where jsonb_typeof(a)<>'string' or length(a#>>'{}')>300 or btrim(a#>>'{}')='') then
        raise exception '标签格式或长度不正确';
      end if;
    end if;
  end loop;

  if p_action='create' then
    if coalesce(btrim(v_patch->>'business_user_id'),'')='' or coalesce(v_patch->>'converted_at','')='' then
      raise exception '新增CAM须填写业务用户ID和转化日期';
    end if;
    if (v_patch->>'converted_at') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$' then raise exception '转化日期必须带明确时区'; end if;
    v_new := jsonb_populate_record(null::public.cams,v_patch);
    insert into public.cams(cam_id,business_user_id,registration_email,converted_at,product_title,countries,
      order_count,paid_order_count,is_lost,conversion_notes,loss_reasons,loss_notes,actions,backup_supplier,completion_tags)
    values (p_cam_id,v_new.business_user_id,coalesce(v_new.registration_email,''),v_new.converted_at,
      coalesce(v_new.product_title,''),coalesce(v_new.countries,'{}'),0,0,false,
      coalesce(v_new.conversion_notes,''),coalesce(v_new.loss_reasons,'{}'),coalesce(v_new.loss_notes,''),
      coalesce(v_new.actions,'{}'),coalesce(v_new.backup_supplier,''),coalesce(v_new.completion_tags,'{}'))
    returning * into v_new;
  else
    if p_expected_version is null or p_expected_version<1 then raise exception '缺少有效版本号'; end if;
    select * into v_old from public.cams where cam_id=p_cam_id and deleted_at is null for update;
    if not found then return jsonb_build_object('ok',false,'code','not_found'); end if;
    if v_old.row_version<>p_expected_version then
      return jsonb_build_object('ok',false,'code','conflict','current',to_jsonb(v_old));
    end if;
    if p_action='delete' then
      update public.cams set deleted_at=statement_timestamp() where cam_id=p_cam_id returning * into v_new;
      update public.alerts set alert_state='superseded',resolved_at=statement_timestamp(),resolved_by=v_uid
        where cam_id=p_cam_id and alert_state='pending';
    else
      v_new := jsonb_populate_record(v_old,v_patch);
      update public.cams set conversion_notes=v_new.conversion_notes,loss_reasons=v_new.loss_reasons,
        loss_notes=v_new.loss_notes,actions=v_new.actions,backup_supplier=v_new.backup_supplier,
        completion_tags=v_new.completion_tags where cam_id=p_cam_id returning * into v_new;
      if not found then v_new:=v_old; end if;
    end if;
  end if;
  select coalesce(jsonb_object_agg(k,jsonb_build_object('before',to_jsonb(v_old)->k,'after',v)), '{}') into v_diff
    from jsonb_each(to_jsonb(v_new)) as e(k,v)
    where k<>all(array['row_version','created_at','updated_at','updated_by'])
      and v is distinct from to_jsonb(v_old)->k;
  if v_diff<>'{}' then
    insert into public.audit_events(entity_kind,entity_id,operation,changed_fields,actor_id)
      values ('cam',p_cam_id,case p_action when 'create' then 'insert' when 'delete' then 'delete' else 'update' end,v_diff,v_uid);
  end if;
  return jsonb_build_object('ok',true,'record',to_jsonb(v_new));
end;
$$;

create function order_project_private.set_member(p_email text,p_role text,p_active boolean,p_expected_version bigint)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid:=auth.uid(); v_target uuid; v_old public.app_members; v_new public.app_members;
begin
  if v_uid is null then raise exception using errcode='42501',message='请先登录'; end if;
  -- All membership changes serialize, preventing two admins from disabling each other.
  perform pg_advisory_xact_lock(hashtextextended('order-project-membership',0));
  if not exists(select 1 from public.app_members where user_id=v_uid and member_role='admin' and is_active) then
    raise exception using errcode='42501',message='仅管理员可以维护成员';
  end if;
  if p_role is null or p_role not in ('admin','editor','viewer') or p_active is null then raise exception '无效的角色或启用状态'; end if;
  select id into v_target from auth.users where lower(email)=lower(btrim(p_email)) and email_confirmed_at is not null;
  if v_target is null then raise exception '该邮箱尚未注册并完成邮箱验证'; end if;
  select * into v_old from public.app_members where user_id=v_target for update;
  if found then
    if p_expected_version is null or p_expected_version<>v_old.row_version then
      return jsonb_build_object('ok',false,'code','conflict','current',to_jsonb(v_old));
    end if;
    if v_old.member_role='admin' and v_old.is_active and (p_role<>'admin' or not p_active)
      and not exists(select 1 from public.app_members where member_role='admin' and is_active and user_id<>v_target) then
      raise exception '不能停用或降级最后一位管理员';
    end if;
    update public.app_members set member_role=p_role,is_active=p_active where user_id=v_target returning * into v_new;
    if not found then v_new:=v_old; end if;
  else
    if p_expected_version is not null then return jsonb_build_object('ok',false,'code','conflict'); end if;
    insert into public.app_members(user_id,display_name,member_role,is_active)
      values(v_target,split_part(p_email,'@',1),p_role,p_active) returning * into v_new;
  end if;
  if v_new.row_version is distinct from v_old.row_version then
    insert into public.audit_events(entity_kind,entity_id,operation,changed_fields,actor_id)
      values('member',v_target::text,case when v_old.user_id is null then 'insert' else 'update' end,
        jsonb_build_object('member_role',jsonb_build_object('before',v_old.member_role,'after',v_new.member_role),
          'is_active',jsonb_build_object('before',v_old.is_active,'after',v_new.is_active)),v_uid);
  end if;
  return jsonb_build_object('ok',true,'member',to_jsonb(v_new));
end;
$$;

create function order_project_private.list_members()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if auth.uid() is null or not exists(select 1 from public.app_members where user_id=auth.uid() and is_active and member_role='admin') then
    raise exception using errcode='42501',message='仅管理员可以查看成员列表';
  end if;
  return coalesce((select jsonb_agg(to_jsonb(m)||jsonb_build_object('email',u.email) order by m.created_at)
    from public.app_members m join auth.users u on u.id=m.user_id),'[]');
end;
$$;

revoke all on function order_project_private.claim_admin(),order_project_private.manual_cam(text,text,bigint,jsonb),
  order_project_private.set_member(text,text,boolean,bigint),order_project_private.list_members() from public,anon;
grant execute on function order_project_private.claim_admin(),order_project_private.manual_cam(text,text,bigint,jsonb),
  order_project_private.set_member(text,text,boolean,bigint),order_project_private.list_members() to authenticated;

create function public.op_claim_admin() returns jsonb language sql security invoker set search_path=''
  as $$ select order_project_private.claim_admin(); $$;
create function public.op_manual_cam(p_action text,p_cam_id text,p_expected_version bigint default null,p_changes jsonb default '{}')
  returns jsonb language sql security invoker set search_path=''
  as $$ select order_project_private.manual_cam(p_action,p_cam_id,p_expected_version,p_changes); $$;
create function public.op_set_member(p_email text,p_role text,p_active boolean default true,p_expected_version bigint default null)
  returns jsonb language sql security invoker set search_path=''
  as $$ select order_project_private.set_member(p_email,p_role,p_active,p_expected_version); $$;
create function public.op_list_members() returns jsonb language sql stable security invoker set search_path=''
  as $$ select order_project_private.list_members(); $$;
revoke all on function public.op_claim_admin(),public.op_manual_cam(text,text,bigint,jsonb),
  public.op_set_member(text,text,boolean,bigint),public.op_list_members() from public,anon;
grant execute on function public.op_claim_admin(),public.op_manual_cam(text,text,bigint,jsonb),
  public.op_set_member(text,text,boolean,bigint),public.op_list_members() to authenticated;
notify pgrst,'reload schema';
