const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

// Browser tests use an HTTP mock, never real accounts, passwords or business data.
// Database authorization is tested separately by supabase/tests/manual-writes.sql.
const port=Number(process.env.CLOUD_TEST_PORT||4186),origin=`http://127.0.0.1:${port}`;
const uid='11111111-1111-4111-8111-111111111111';
const user={id:uid,aud:'authenticated',role:'authenticated',email:'test@example.invalid',email_confirmed_at:'2026-10-20T01:00:00Z',app_metadata:{},user_metadata:{}};
const jwtPayload={sub:uid,role:'authenticated',aud:'authenticated',exp:Math.floor(Date.now()/1000)+3600};
const token=Buffer.from('{"alg":"HS256"}').toString('base64url')+'.'+Buffer.from(JSON.stringify(jwtPayload)).toString('base64url')+'.test';
const session={access_token:token,refresh_token:'test-only-refresh-token',token_type:'bearer',expires_in:3600,expires_at:jwtPayload.exp,user};
const fixture=()=>({cam_id:'20928156567025090001',business_user_id:'20928156567025090002',registration_email:'buyer@example.invalid',
  converted_at:'2026-10-20T01:00:00Z',last_order_at:null,order_count:0,paid_order_count:0,is_lost:false,lost_on:null,
  countries:['US'],ad_placements:[],owners:[],fulfillment_apps:[],conversion_reasons:[],loss_reasons:[],actions:[],completion_tags:[],
  product_title:'Test CAM',conversion_url:'',conversion_notes:'old note',loss_notes:'',backup_supplier:'',source_extras:{'套餐':'Basic'},
  conversion_status:'待下单',conversion_year:2026,conversion_quarter:4,row_version:1,updated_at:'2026-10-20T01:00:00Z',deleted_at:null});
const server=spawn(process.execPath,['scripts/dev-server.mjs'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(port)},stdio:'pipe'});
let browser;
async function mockContext({loggedIn=true,role='admin',member=true,totalRows=1}={}) {
  const context=await browser.newContext(),errors=[];
  const state={row:fixture(),mode:'ok',requests:[],writes:0,loginFails:false,readingFails:false};
  await context.addInitScript(({session,loggedIn})=>{
    localStorage.setItem('tdfx_workspace_v20','DO NOT OVERWRITE LOCAL WORKSPACE');
    if(loggedIn)localStorage.setItem('order_project_cloud_auth_v1',JSON.stringify(session));
  },{session,loggedIn});
  await context.route('https://qevuhefnniciwfnnhceo.supabase.co/**',async route=>{
    const req=route.request(),url=new URL(req.url());state.requests.push(url.pathname);
    const headers={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*','content-type':'application/json'};
    const reply=(data,status=200)=>route.fulfill({status,headers,body:JSON.stringify(data)});
    if(req.method()==='OPTIONS')return route.fulfill({status:204,headers,body:''});
    if(url.pathname==='/auth/v1/user')return reply(user);
    if(url.pathname==='/auth/v1/token')return state.loginFails?reply({code:'invalid_credentials',msg:'Invalid login credentials'},400):reply(session);
    if(url.pathname==='/auth/v1/signup')return reply({user,session:null});
    if(url.pathname==='/auth/v1/logout')return reply({});
    if(url.pathname==='/rest/v1/rpc/op_claim_admin')return reply({member:member?{user_id:uid,member_role:role,is_active:true,row_version:1}:null});
    if(url.pathname==='/rest/v1/rpc/op_list_members')return reply([{user_id:uid,email:user.email,member_role:role,is_active:true,row_version:1}]);
    if(url.pathname==='/rest/v1/rpc/op_manual_cam') {
      const body=req.postDataJSON();state.writes++;
      if(state.mode==='network')return route.abort('failed');
      if(state.mode==='conflict')return reply({ok:false,code:'conflict',current:{...state.row,row_version:8,conversion_notes:'colleague note'}});
      if(body.p_action==='update') {assert.equal(body.p_expected_version,state.row.row_version);Object.assign(state.row,body.p_changes,{row_version:state.row.row_version+1,updated_at:'2026-10-20T02:00:00Z'});}
      else if(body.p_action==='create')state.row={...fixture(),cam_id:body.p_cam_id,...body.p_changes};
      else if(body.p_action==='delete')state.row.deleted_at='2026-10-20T03:00:00Z';
      return reply({ok:true,record:state.row});
    }
    if(url.pathname.startsWith('/rest/v1/')) {
      if(state.readingFails)return reply({message:'read failed'},500);
      const table=url.pathname.split('/').at(-1);
      const rows=table==='cams'&&!state.row.deleted_at?(totalRows===1?[state.row]:Array.from({length:totalRows},(_,i)=>({...fixture(),cam_id:'pagination-'+String(i).padStart(6,'0')}))):[];
      return reply(rows.slice(Number(url.searchParams.get('offset')||0),Number(url.searchParams.get('offset')||0)+Number(url.searchParams.get('limit')||500)));
    }
    throw new Error('Unexpected external request '+url.pathname);
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin);return {context,page,state,errors};
}
async function ready(page) {await page.waitForFunction(()=>document.documentElement.dataset.cloudReady==='true');await page.locator('[data-page="users"]').click();}
async function edit(page,text) {
  const cell=page.locator('#userTable td[data-col="转化备注"]');await cell.fill(text);await cell.press('Enter');
}
(async()=>{
  await new Promise((resolve,reject)=>{server.stdout.on('data',resolve);server.once('error',reject);server.once('exit',code=>reject(new Error('Test server exited '+code)));});
  const executablePath=process.env.CHROMIUM_PATH||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined);
  browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
  {
    const {page,state,context,errors}=await mockContext({loggedIn:false});
    await page.locator('#cloudEmail').waitFor();assert.equal(await page.locator('.app').isVisible(),false);
    state.loginFails=true;await page.locator('#cloudEmail').fill(user.email);await page.locator('#cloudPassword').fill('test-password-not-real');
    await page.locator('#cloudAuthForm [type="submit"]').click();await page.getByText('邮箱或密码不正确，请重新输入。').waitFor();
    state.loginFails=false;await page.locator('#cloudAuthForm [type="submit"]').click();await ready(page);
    assert.equal(await page.locator('#cloudAccountEmail').textContent(),user.email);
    assert.deepEqual(errors,[]);await context.close();console.log('✓ 登录前隐藏业务界面、错误密码反馈和登录后读取');
  }
  {
    const {page,state,context,errors}=await mockContext();await ready(page);
    assert.equal(await page.evaluate(()=>localStorage.getItem('tdfx_workspace_v20')),'DO NOT OVERWRITE LOCAL WORKSPACE');
    assert.equal(await page.locator('#userTable .user-data-row').count(),1);assert.equal(await page.locator('#uploadUsers').isDisabled(),true);
    await edit(page,'new cloud note');await page.getByText('✓ 已保存到云端',{exact:true}).waitFor();
    assert.equal(state.row.conversion_notes,'new cloud note');assert.equal(state.row.row_version,2);
    assert.equal(await page.locator('#userTable td[data-col="转化备注"]').textContent(),'new cloud note');
    assert.equal(await page.locator('#userTable td[data-col="转化下单量"][contenteditable]').count(),0);
    // A tag change must await the same server write path.
    await page.locator('#userTable [data-col="操作"].tag-value-editor').click();
    await page.locator('.tag-editor-search').fill('复盘完成');await page.locator('.tag-editor-search').press('Enter');
    await page.waitForFunction(()=>document.querySelector('#cloudSaveStatus').textContent==='✓ 已保存到云端');
    assert.deepEqual(state.row.actions,['复盘完成']);await page.locator('.tag-editor-foot [data-done]').click();
    state.mode='conflict';await edit(page,'conflicting draft');await page.getByText(/这条 CAM 已被其他操作更新/).waitFor();
    assert.equal(state.row.conversion_notes,'new cloud note');
    assert.equal(await page.locator('.cloud-drafts textarea').inputValue(),'conflicting draft');
    assert.match(await page.locator('.cloud-drafts').textContent(),/colleague note/);
    state.mode='network';await edit(page,'network draft');await page.getByText(/未完成保存：网络连接失败/).waitFor();
    assert.equal(state.row.conversion_notes,'new cloud note');
    state.mode='ok';await page.locator('#cloudLogout').click();await page.locator('#cloudEmail').waitFor();
    assert.equal(await page.locator('.app').isVisible(),false);
    assert.equal(await page.evaluate(()=>users.length),0);
    assert.equal(await page.evaluate(()=>localStorage.getItem('tdfx_workspace_v20')),'DO NOT OVERWRITE LOCAL WORKSPACE');
    assert.deepEqual(errors,[]);await context.close();console.log('✓ 云端修改、标签、版本冲突、网络失败、退出及本地数据隔离');
  }
  {
    const {page,state,context,errors}=await mockContext();await ready(page);
    await page.locator('#cloudAddCam').click();const form=page.locator('.cloud-dialog form');
    await form.locator('[name="cam"]').fill('new-text-cam');await form.locator('[name="user"]').fill('20928156567025090005');
    await form.locator('[name="converted"]').fill('2026-10-20T09:00');await form.locator('[type="submit"]').click();
    await page.waitForFunction(()=>!document.querySelector('.cloud-dialog'));
    assert.equal(state.row.converted_at,'2026-10-20T09:00:00+08:00');
    page.on('dialog',dialog=>dialog.accept(dialog.type()==='prompt'?'new-text-cam':undefined));
    await page.locator('#cloudDeleteCam').click();await page.getByText('✓ 已保存到云端',{exact:true}).waitFor();
    await page.waitForFunction(()=>users.every(r=>r['转化CAM']!=='new-text-cam'));
    assert.ok(state.row.deleted_at);assert.deepEqual(errors,[]);await context.close();console.log('✓ 新增CAM时区与删除反馈');
  }
  {
    const {page,context,errors}=await mockContext({role:'viewer'});await ready(page);
    assert.equal(await page.locator('#userTable [contenteditable="true"],#userTable .tag-value-editor').count(),0);
    assert.equal(await page.locator('#cloudAddCam').isDisabled(),true);assert.equal(await page.locator('#cloudDeleteCam').isVisible(),false);
    assert.deepEqual(errors,[]);await context.close();console.log('✓ 查看者界面只读');
  }
  {
    const {page,context,errors}=await mockContext({member:false});await page.getByText('等待成员授权').waitFor();
    assert.equal(await page.locator('.app').isVisible(),false);assert.deepEqual(errors,[]);await context.close();console.log('✓ 非成员等待授权，业务界面保持隐藏');
  }
  {
    const {page,context,errors}=await mockContext({totalRows:501});await ready(page);
    assert.equal(await page.locator('#userTable .user-data-row').count(),501);
    assert.equal(await page.evaluate(()=>users.length),501);assert.deepEqual(errors,[]);await context.close();console.log('✓ 超过单页数据完整读取，不把第一页用于完整统计');
  }
  {
    const context=await browser.newContext(),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin+'/?mode=local');assert.equal(await page.locator('#userTable .user-data-row').count(),15);
    assert.match(await page.locator('.local-mode-note').textContent(),/本地演示模式/);
    assert.deepEqual(errors,[]);await context.close();console.log('✓ 本地演示仍保留15条样例');
  }
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.kill();});
