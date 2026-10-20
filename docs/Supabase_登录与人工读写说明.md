# Supabase 登录与人工读写开发记录

日期：2026-10-20。对应 V2.1.0-beta.1 云端协作测试版；GitHub版本以提交及标签为准。本轮不替换既有在线预览。

## 开发原理

```text
邮箱和密码 → Supabase Auth 验证 → 返回登录凭证
          → 数据库确认 app_members 有效成员 → 网页读取共享数据

人工修改 → 只提交 CAM + 指定字段 + expected_version
        → 数据库确认身份、角色、字段白名单
        → 锁定当前 CAM 并核对版本
        → 同一事务保存业务字段、编辑信息和审计记录
        → 返回数据库记录 → 网页显示已保存

版本冲突 → 返回冲突和当前记录 → 保留本页草稿，刷新后核对重填
网络失败 → 不显示保存成功 → 保留本页草稿，重新读取云端核对结果
```

密码只交给 Supabase Auth，业务表不保存密码。网页只带公开客户端配置；没有 service_role、数据库密码或管理员密钥。客户端隐藏按钮只是体验，最终授权、字段限制和版本检查全部在数据库执行。

## 本轮已交付范围

- 邮箱密码登录、注册、邮箱验证引导、退出、密码重设页面。
- 唯一指定邮箱 `daiyiwan666@gmail.com` 完成邮箱验证后首次登录，可认领首位管理员。认领标记保存在私有表，其他先注册者不会自动获权。
- 已注册且验证的同事由管理员按邮箱添加为管理员、编辑者或查看者。成员停用后服务端立即拒绝其业务访问/写入；不依赖过期 JWT 中的角色声明。
- 所有活动 CAM 分批读取后一次替换页面数据；不把默认 API 单页数量误当成完整数据。当前仍全量渲染，服务端筛选分页及完整范围汇总是后续阶段。
- 云端只允许人工复盘字段自动保存：转化备注、流失原因、流失备注、操作、备选推荐供端、是否完成。源数据、转化原因、订单和系统派生字段显示只读。
- 管理员或编辑者可新建待下单 CAM，填写文本 CAM/业务用户ID、转化时间和可选标题/邮箱；服务端固定下单量0、支付订单0、未流失。已有订单的历史记录走后续正式导入。
- 仅管理员可按 CAM 编号软删除；版本冲突则拒绝。保留原记录和关联历史，活动名单不再显示；同 CAM 不可重复新增。相关待处理预警标记为被替代。
- 数据库自动维护 row_version、updated_at、updated_by；实际变化才生成编辑元数据和审计事件。相同内容重存不产生新版本或审计。
- 保存完成后使用服务端返回的记录更新界面。异常时不乐观地显示成功，原数据保留。冲突显示服务端当前字段值，失败草稿只保留在当前页面内存，刷新/退出/关闭前需自行复制；不会写入旧本地工作区。
- 查看者的人工编辑、新增、删除按钮禁用或隐藏；数据库也会拒绝其写入。最后一位有效管理员不能被停用或降级，成员变更串行执行。

## 当前尚未开放

1. 云端文件导入、每日订单同步、异常登记及预警确认。入口禁用，避免误存为浏览器数据；原 V2.0 规则保留在本地模式。
2. 订单推品项目页面的云端新增与编辑。目前读取云端数据，只读展示。
3. 同事修改后的实时推送。当前点击“刷新云端数据”获取最新结果，写入仍由版本比较保护。
4. 服务端筛选分页、完整汇总接口、正式数据迁移、备份恢复。

本轮不是全量云端切换。不能仅因本轮完成就把浏览器中旧数据清空。

## 首次使用与邮箱回调

拿到包含本轮代码的仓库后，`npm run dev`，打开 `http://127.0.0.1:4173`。云端功能需要网络；本地演示通过 `http://127.0.0.1:4173/?mode=local` 进入。

首次上线前需要在 [Authentication → URL Configuration](https://supabase.com/dashboard/project/qevuhefnniciwfnnhceo/auth/url-configuration) 配置实际网页地址：

1. Site URL 填正式使用的 HTTPS 网页地址。
2. Redirect URLs 加入实际网页返回地址。开发时按需加入 `http://127.0.0.1:4173` 和 `http://localhost:4173`；上线时加入确切 HTTPS 地址，不使用任意域名通配符。
3. 保存后，在新网页点击“首次使用？注册账号”，使用管理员邮箱并自行设置至少12位密码。
4. 打开验证邮件完成验证，再回到网页登录。Supabase 控制台已有账号不会自动成为本网页 Auth 账号。
5. 第一次成功登录会创建 app_members 管理员记录。其他同事先注册和验证，再由管理员在左侧“成员管理”添加邮箱。

本轮没有权限工具可以直接修改 Auth URL Configuration，尚未改变该设置。当前也没有真实 Auth 网页账号。邮件发送、实际地址回调及真实浏览器登录，需要账号建立后联调；不能把模拟登录测试视作已验证了这些外部环节。

## 迁移、接口与权限

- 基础迁移：`supabase/migrations/20261020024007_order_project_foundation.sql`。
- 本轮迁移：`supabase/migrations/20261020112004_controlled_manual_writes.sql`，已应用远端。
- 公开 RPC：`op_claim_admin`、`op_manual_cam`、`op_set_member`、`op_list_members`。公开函数为 SECURITY INVOKER；需要提升权限的实现放在未暴露的 `order_project_private`，固定 search_path，逐次校验 auth.uid 和成员权限，并撤销匿名执行权限。
- 浏览器没有业务表直接写权限。继续启用 RLS；活动名单额外排除 deleted_at 非空的记录。
- `bootstrap_admin` 私有表启用 RLS，未设置客户端策略且撤销客户端表权限，明确拒绝直接访问。安全顾问的 [RLS 无策略 INFO](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) 在该表属于预期的关闭访问设计；不是公开表缺少成员策略。
- 性能顾问只提示空库中尚未使用的索引。[说明](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index)。

## 验证证据

- `npm run check`：所有页面脚本和本地依赖存在且语法通过。
- `npm test`：原有21项规则测试和3项云端映射/人工字段/区间测试通过。
- `npm run test:cloud-browser`：Chromium + 模拟 Auth/REST 请求，覆盖登录前隐藏、错误密码、登录读取、人工文本/标签保存、冲突、断网、退出清理、新增时区、删除、查看者只读、非成员拒绝、本地模式回归。
- `supabase/tests/foundation.sql` 和 `supabase/tests/manual-writes.sql`：实际远端 SQL 事务内验证 RLS、身份、管理员认领、角色、字段白名单、版本、审计、删除及唯一性等，全部回滚测试数据。
- 实际用户的密码登录、邮箱投递和回调尚未验证。当前执行环境对项目 HTTP 域名的直连被代理策略拒绝（CONNECT 403）；数据库操作通过已授权 Supabase 工具完成。没有绕过网络策略。
- Supabase JS 固定为2.118.0，提交 lockfile 和本地 UMD 组件及许可证，运行网页不依赖 CDN。Playwright 测试依赖固定为1.62.1；页面运行无需 npm install，复现测试执行 npm ci。

## 目录

```text
assets/cloud-config.js       项目URL、公开客户端Key与模式选择
assets/cloud-data.js         英文数据库字段到中文页面的映射
assets/cloud-ui.js           中文认证、成员、读取与人工编辑保存
assets/cloud.css             登录与保存反馈样式
assets/vendor/supabase-*     固定版本本地SDK
supabase/migrations/         与远端版本对齐的数据库迁移
supabase/tests/              回滚式数据库行为测试
scripts/test-cloud-data.mjs  纯映射和业务边界测试
scripts/test-cloud-browser.cjs 模拟网络的浏览器集成测试
```
