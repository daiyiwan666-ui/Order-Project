-- Order-Project: shared database foundation. No business/sample data is inserted.
-- Client write access stays closed until version-checked business RPCs are ready.

create schema if not exists order_project_private;
revoke all on schema order_project_private from public, anon;
grant usage on schema order_project_private to authenticated, service_role;

create table public.app_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  member_role text not null check (member_role in ('admin', 'editor', 'viewer')),
  is_active boolean not null default true,
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
comment on table public.app_members is '应用成员：登录账号与业务用户ID分开，只有启用成员可访问业务数据';

create function order_project_private.current_member_role()
returns text language sql stable security invoker set search_path = ''
as $$
  select m.member_role from public.app_members as m
  where m.user_id = (select auth.uid()) and m.is_active;
$$;
revoke all on function order_project_private.current_member_role() from public, anon;
grant execute on function order_project_private.current_member_role() to authenticated, service_role;

create function order_project_private.cam_status(
  p_is_lost boolean, p_order_count bigint, p_last_order_at timestamptz, p_lost_on date
)
returns text language sql immutable security invoker set search_path = ''
as $$
  select case
    when p_is_lost and p_lost_on is not null
      and (p_last_order_at at time zone 'Asia/Shanghai')::date > p_lost_on then '流失又回'
    when p_is_lost then '已流失'
    when p_order_count = 0 then '待下单'
    else '下单中'
  end;
$$;
revoke all on function order_project_private.cam_status(boolean,bigint,timestamptz,date) from public, anon;
grant execute on function order_project_private.cam_status(boolean,bigint,timestamptz,date) to authenticated, service_role;

create table public.cams (
  cam_id text primary key check (length(btrim(cam_id)) > 0 and cam_id = btrim(cam_id)),
  business_user_id text not null check (length(btrim(business_user_id)) > 0),
  registration_email text not null default '',
  countries text[] not null default '{}',
  converted_at timestamptz not null,
  ad_placements text[] not null default '{}',
  owners text[] not null default '{}',
  product_title text not null default '',
  conversion_url text not null default '',
  conversion_notes text not null default '',
  last_order_at timestamptz,
  order_count bigint not null check (order_count between 0 and 9007199254740991),
  paid_order_count bigint not null check (paid_order_count between 0 and 9007199254740991),
  fulfillment_apps text[] not null default '{}',
  is_lost boolean not null,
  conversion_reasons text[] not null default '{}',
  loss_reasons text[] not null default '{}',
  lost_on date,
  loss_notes text not null default '',
  actions text[] not null default '{}',
  backup_supplier text not null default '',
  completion_tags text[] not null default '{}',
  source_extras jsonb not null default '{}' check (jsonb_typeof(source_extras) = 'object'),
  conversion_status text generated always as
    (order_project_private.cam_status(is_lost,order_count,last_order_at,lost_on)) stored,
  conversion_year smallint generated always as
    (extract(year from converted_at at time zone 'Asia/Shanghai')::smallint) stored,
  conversion_quarter smallint generated always as
    (extract(quarter from converted_at at time zone 'Asia/Shanghai')::smallint) stored,
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint cams_last_order_not_before_conversion check (last_order_at is null or last_order_at >= converted_at),
  constraint cams_loss_not_before_conversion check
    (lost_on is null or lost_on >= (converted_at at time zone 'Asia/Shanghai')::date)
);
comment on table public.cams is '转化用户名单：一行一个CAM；广告id是唯一标识，长编号按文本保存';
comment on column public.cams.business_user_id is '原文件用户ID，非Supabase登录账号UUID';
comment on column public.cams.registration_email is '用户注册邮箱';
comment on column public.cams.countries is '国家，多值标签';
comment on column public.cams.converted_at is '转化日期，源无时区时间按Asia/Shanghai解析';
comment on column public.cams.ad_placements is '广告位，对应文件转化素材';
comment on column public.cams.owners is '负责人，从标签提取';
comment on column public.cams.product_title is '商品标题';
comment on column public.cams.conversion_url is '转化链接，对应推荐供端URL';
comment on column public.cams.conversion_notes is '转化备注，人工维护';
comment on column public.cams.last_order_at is '最近下单日期';
comment on column public.cams.order_count is '转化下单量，累计值替换不相加';
comment on column public.cams.paid_order_count is '支付订单；大于下单量属于待复核，不以数据库约束禁止确认后的有效修正';
comment on column public.cams.fulfillment_apps is '第三方插件';
comment on column public.cams.is_lost is '是否流失，文件yes/no对应true/false';
comment on column public.cams.conversion_reasons is '转化原因，标准化标签；不写入人工转化备注';
comment on column public.cams.loss_reasons is '流失原因，人工复盘';
comment on column public.cams.lost_on is '流失日期；同日下单不算回流';
comment on column public.cams.loss_notes is '流失备注，人工复盘';
comment on column public.cams.actions is '操作，人工标签';
comment on column public.cams.backup_supplier is '备选推荐供端，人工维护';
comment on column public.cams.completion_tags is '是否完成，保留现有标签语义';
comment on column public.cams.source_extras is '套餐等仍需保留的隐藏源字段；不作为数据库权限依据';
comment on column public.cams.conversion_status is '转化跟踪，系统自动派生四种状态';
comment on column public.cams.row_version is '并发版本，后续写入RPC须携带expected_version并原子比较';
comment on column public.cams.updated_at is '最后编辑时间，由数据库维护，不随查看或动态计时刷新';

create table public.order_projects (
  id uuid primary key default gen_random_uuid(),
  project_date date,
  project_name text not null default '',
  distributed_users bigint check (distributed_users >= 0),
  conversion_orders bigint check (conversion_orders >= 0),
  active_distributed_users bigint check (active_distributed_users >= 0),
  impressions bigint check (impressions >= 0),
  cta_clicks bigint check (cta_clicks >= 0),
  converted_users bigint check (converted_users >= 0),
  converted_products bigint check (converted_products >= 0),
  source_extras jsonb not null default '{}' check (jsonb_typeof(source_extras) = 'object'),
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
comment on table public.order_projects is '订单推品项目数据；年月周及效率指标按底层计数计算，保留缺值与0的区别';

create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null default gen_random_uuid() unique,
  file_name text not null,
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  sheet_name text not null default '',
  batch_state text not null default 'prepared' check
    (batch_state in ('prepared','processing','completed','partially_completed','failed')),
  total_rows integer not null default 0 check (total_rows >= 0),
  inserted_rows integer not null default 0 check (inserted_rows >= 0),
  updated_rows integer not null default 0 check (updated_rows >= 0),
  unchanged_rows integer not null default 0 check (unchanged_rows >= 0),
  flagged_rows integer not null default 0 check (flagged_rows >= 0),
  imported_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint import_batches_valid_finish check (finished_at is null or finished_at >= created_at)
);
comment on table public.import_batches is '文件导入批次：request_id用于请求幂等，文件摘要用于识别重复上传，不存整份每日主表副本';

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  cam_id text references public.cams(cam_id) on update cascade on delete restrict,
  source_cam_id text,
  import_batch_id uuid references public.import_batches(id) on delete set null,
  source_rows integer[] not null default '{}',
  alert_type text not null,
  fingerprint text not null check (length(btrim(fingerprint)) > 0),
  expected_version bigint check (expected_version > 0),
  is_confirmable boolean not null default false,
  before_values jsonb not null default '{}' check (jsonb_typeof(before_values) = 'object'),
  candidate_values jsonb not null default '{}' check (jsonb_typeof(candidate_values) = 'object'),
  issues jsonb not null default '[]' check (jsonb_typeof(issues) = 'array'),
  alert_state text not null default 'pending' check (alert_state in ('pending','accepted','ignored','superseded')),
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  row_version bigint not null default 1 check (row_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint alerts_resolution_state check
    ((alert_state = 'pending' and resolved_at is null) or (alert_state <> 'pending' and resolved_at is not null))
);
comment on table public.alerts is '共享异常预警；未入表CAM保留source_cam_id；订单回退确认前不更新原记录';
create unique index alerts_pending_fingerprint_idx on public.alerts(fingerprint) where alert_state = 'pending';

create table public.cam_order_periods (
  id uuid primary key default gen_random_uuid(),
  cam_id text not null references public.cams(cam_id) on update cascade on delete restrict,
  started_at timestamptz not null,
  ended_at timestamptz,
  is_estimated boolean not null default false,
  estimate_source text,
  import_batch_id uuid references public.import_batches(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint cam_periods_ordered check (ended_at is null or ended_at >= started_at)
);
comment on table public.cam_order_periods is '持续出单区间：停止和恢复时保存区间，展示时累计有效时长，不每分钟写库';
create unique index cam_periods_one_active_idx on public.cam_order_periods(cam_id) where ended_at is null;

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  entity_kind text not null check (entity_kind in ('cam','order_project','member','import_batch','alert','order_period')),
  entity_id text not null,
  operation text not null check (operation in ('insert','update','delete','approve','ignore','import')),
  changed_fields jsonb not null default '{}' check (jsonb_typeof(changed_fields) = 'object'),
  actor_id uuid references auth.users(id) on delete set null,
  import_batch_id uuid references public.import_batches(id) on delete set null,
  created_at timestamptz not null default now()
);
comment on table public.audit_events is '业务操作日志：由后续受控写入事务记录变化字段，不保存无变化整表快照';

create function order_project_private.set_row_metadata()
returns trigger language plpgsql security invoker set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.row_version := 1;
    new.created_at := statement_timestamp();
  else
    -- Generated columns are not populated in NEW until after BEFORE triggers.
    if (to_jsonb(new) - array['row_version','created_at','updated_at','updated_by',
        'conversion_status','conversion_year','conversion_quarter'])
      = (to_jsonb(old) - array['row_version','created_at','updated_at','updated_by',
        'conversion_status','conversion_year','conversion_quarter']) then
      return null;
    end if;
    new.row_version := old.row_version + 1;
    new.created_at := old.created_at;
  end if;
  new.updated_at := statement_timestamp();
  new.updated_by := auth.uid();
  return new;
end;
$$;
revoke all on function order_project_private.set_row_metadata() from public, anon, authenticated, service_role;

create trigger app_members_metadata before insert or update on public.app_members
  for each row execute function order_project_private.set_row_metadata();
create trigger cams_metadata before insert or update on public.cams
  for each row execute function order_project_private.set_row_metadata();
create trigger order_projects_metadata before insert or update on public.order_projects
  for each row execute function order_project_private.set_row_metadata();
create trigger alerts_metadata before insert or update on public.alerts
  for each row execute function order_project_private.set_row_metadata();

create index app_members_updated_by_idx on public.app_members(updated_by);
create index cams_updated_by_idx on public.cams(updated_by);
create index cams_business_user_idx on public.cams(business_user_id);
create index cams_year_date_idx on public.cams(conversion_year, converted_at desc, cam_id);
create index cams_updated_at_idx on public.cams(updated_at, cam_id);
create index cams_countries_idx on public.cams using gin(countries);
create index cams_owners_idx on public.cams using gin(owners);
create index cams_ad_placements_idx on public.cams using gin(ad_placements);
create index cams_conversion_reasons_idx on public.cams using gin(conversion_reasons);
create index order_projects_updated_by_idx on public.order_projects(updated_by);
create index order_projects_date_idx on public.order_projects(project_date desc, id);
create index import_batches_imported_by_idx on public.import_batches(imported_by);
create index import_batches_file_sha_idx on public.import_batches(file_sha256);
create index alerts_cam_idx on public.alerts(cam_id);
create index alerts_batch_idx on public.alerts(import_batch_id);
create index alerts_resolved_by_idx on public.alerts(resolved_by);
create index alerts_updated_by_idx on public.alerts(updated_by);
create index alerts_state_created_idx on public.alerts(alert_state, created_at desc, id);
create index cam_periods_cam_start_idx on public.cam_order_periods(cam_id, started_at);
create index cam_periods_batch_idx on public.cam_order_periods(import_batch_id);
create index audit_events_actor_idx on public.audit_events(actor_id);
create index audit_events_batch_idx on public.audit_events(import_batch_id);
create index audit_events_entity_date_idx on public.audit_events(entity_kind, entity_id, created_at desc);

alter table public.app_members enable row level security;
alter table public.cams enable row level security;
alter table public.order_projects enable row level security;
alter table public.import_batches enable row level security;
alter table public.alerts enable row level security;
alter table public.cam_order_periods enable row level security;
alter table public.audit_events enable row level security;

revoke all on public.app_members, public.cams, public.order_projects, public.import_batches,
  public.alerts, public.cam_order_periods, public.audit_events from public, anon, authenticated;
grant select on public.app_members, public.cams, public.order_projects, public.import_batches,
  public.alerts, public.cam_order_periods, public.audit_events to authenticated;
grant all on public.app_members, public.cams, public.order_projects, public.import_batches,
  public.alerts, public.cam_order_periods, public.audit_events to service_role;

create policy members_read_self on public.app_members for select to authenticated
  using (user_id = (select auth.uid()) and is_active);
create policy members_read_cams on public.cams for select to authenticated
  using ((select order_project_private.current_member_role()) in ('admin','editor','viewer'));
create policy members_read_orders on public.order_projects for select to authenticated
  using ((select order_project_private.current_member_role()) in ('admin','editor','viewer'));
create policy members_read_imports on public.import_batches for select to authenticated
  using ((select order_project_private.current_member_role()) in ('admin','editor','viewer'));
create policy members_read_alerts on public.alerts for select to authenticated
  using ((select order_project_private.current_member_role()) in ('admin','editor','viewer'));
create policy members_read_periods on public.cam_order_periods for select to authenticated
  using ((select order_project_private.current_member_role()) in ('admin','editor','viewer'));
create policy members_read_audit on public.audit_events for select to authenticated
  using ((select order_project_private.current_member_role()) in ('admin','editor','viewer'));

notify pgrst, 'reload schema';
