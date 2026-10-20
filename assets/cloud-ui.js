/* Login and version-checked manual CAM persistence. No privileged key is used. */
(function() {
  'use strict';
  const cloudMode=document.documentElement.dataset.storage==='cloud';
  const gate=document.getElementById('cloudGate');
  if(!cloudMode) {
    gate.hidden=true;
    const note=document.createElement('div');note.className='local-mode-note';
    note.innerHTML='本地演示模式：修改只保存在本浏览器。 <a href="?mode=cloud">进入云端协作</a>';
    document.querySelector('.main').prepend(note);return;
  }
  const D=OrderCloudData;
  let client,member=null,currentUser=null,authMode='login',busy=false,ready=false,authSequence=0,authLoading=false;
  const pendingDrafts=new Map();
  const banner=document.createElement('div');banner.className='cloud-status';banner.setAttribute('role','status');banner.setAttribute('aria-live','polite');
  banner.innerHTML='<span id="cloudSaveStatus">正在连接云端…</span><button class="btn" id="cloudReload">刷新云端数据</button>';
  document.querySelector('.main').prepend(banner);
  const draftBox=document.createElement('details');draftBox.className='cloud-drafts';draftBox.hidden=true;banner.append(draftBox);
  const account=document.createElement('div');account.className='cloud-account';document.querySelector('.side').append(account);
  function message(text,state='saved') {banner.dataset.state=state;document.getElementById('cloudSaveStatus').textContent=text;}
  function explain(error) {
    const text=error?.message||String(error);
    if(/Invalid login credentials/i.test(text)) return '邮箱或密码不正确，请重新输入。';
    if(/Email not confirmed/i.test(text)) return '请先到邮箱完成验证，再返回登录。';
    if(/rate limit|too many requests/i.test(text)) return '请求较频繁，请稍后再试。';
    if(/Failed to fetch|NetworkError|fetch failed|timeout|timed out/i.test(text)) return '网络连接失败，请检查网络后重试。本次结果尚未确认，可刷新云端核对；不要重复新增记录。';
    if(error?.code==='23505') return '该 CAM 编号已存在或保留在删除历史中，不能重复新增。';
    return text;
  }
  function clearWorkspace() {
    ready=false;member=null;currentUser=null;users=[];orders=[];continuousState={};userAlerts=[];userFieldFilters={};
    closeColumnFilter();closeTagEditor(false);document.querySelectorAll('.modal').forEach(el=>el.classList.remove('open'));
    document.querySelectorAll('.cloud-dialog').forEach(el=>el.remove());
    delete document.documentElement.dataset.cloudReady;account.replaceChildren();pendingDrafts.clear();paintDrafts();renderAll();
  }
  function paintDrafts() {
    draftBox.hidden=pendingDrafts.size===0;draftBox.replaceChildren();
    const summary=document.createElement('summary');summary.textContent=`有 ${pendingDrafts.size} 项未保存草稿（仅保留在当前页面，退出或关闭页面会清除）`;draftBox.append(summary);
    for(const [key,draft] of pendingDrafts) {
      const wrap=document.createElement('div'),label=document.createElement('p'),text=document.createElement('textarea'),discard=document.createElement('button');
      label.textContent=`CAM ${draft.cam} · ${draft.label}${draft.current!==undefined?' · 最新云端值：'+(Array.isArray(draft.current)?draft.current.join('、'):draft.current??'') : ''}`;
      text.readOnly=true;text.value=String(draft.value??'');text.setAttribute('aria-label','未保存草稿');
      discard.className='btn';discard.textContent='放弃此草稿';discard.onclick=()=>{pendingDrafts.delete(key);paintDrafts();};
      wrap.append(label,text,discard);draftBox.append(wrap);
    }
  }
  function authForm(notice='') {
    gate.hidden=false;
    const register=authMode==='register',recovery=authMode==='recovery',reset=authMode==='reset';
    gate.innerHTML=`<div class="cloud-card"><h1>转化数据分析</h1><p>${register?'注册网页账号，完成邮箱验证后登录。成员权限由管理员授予。':recovery?'设置新的网页登录密码。':reset?'输入账号邮箱，接收重设密码邮件。':'登录云端协作，和同事查看同一份数据。'}</p>
      <form class="cloud-form" id="cloudAuthForm">${recovery?'':'<label>邮箱<input id="cloudEmail" name="email" type="email" autocomplete="username" required></label>'}
      ${reset?'':`<label>${recovery?'新密码':'密码'}<input id="cloudPassword" name="password" type="password" autocomplete="${register||recovery?'new-password':'current-password'}" ${register||recovery?'minlength="12"':''} required></label>`}
      <button class="btn primary" type="submit">${register?'注册账号':recovery?'保存新密码':reset?'发送重设邮件':'登录'}</button></form>
      <div class="cloud-message" id="cloudAuthMessage" role="status" aria-live="polite"></div><div class="cloud-links">
      <button type="button" id="cloudSwitchAuth">${authMode==='login'?'首次使用？注册账号':'返回登录'}</button>${authMode==='login'?'<button type="button" id="cloudForgot">忘记密码</button>':''}</div>
      <p>Supabase 后台账号与本网页账号分别管理。<br>密码由你自行设置，请勿发给他人。</p><a class="mini" href="?mode=local">查看本地演示</a></div>`;
    document.getElementById('cloudAuthMessage').textContent=notice;
    document.getElementById('cloudSwitchAuth').onclick=()=>{authMode=authMode==='login'?'register':'login';authForm();};
    const forgot=document.getElementById('cloudForgot');if(forgot)forgot.onclick=()=>{authMode='reset';authForm();};
    document.getElementById('cloudAuthForm').onsubmit=async event=>{
      event.preventDefault();const form=event.currentTarget,button=form.querySelector('[type=submit]');button.disabled=true;
      const output=document.getElementById('cloudAuthMessage');output.textContent='正在处理…';
      try {
        const email=document.getElementById('cloudEmail')?.value.trim(),password=document.getElementById('cloudPassword')?.value;
        let result;
        if(register) result=await client.auth.signUp({email,password,options:{emailRedirectTo:location.origin+location.pathname}});
        else if(recovery) result=await client.auth.updateUser({password});
        else if(reset) result=await client.auth.resetPasswordForEmail(email,{redirectTo:location.origin+location.pathname});
        else result=await client.auth.signInWithPassword({email,password});
        if(result.error)throw result.error;
        if(register&&!result.data.session) {output.textContent='注册请求已提交。请到邮箱打开验证邮件，验证后返回本页登录。';return;}
        if(reset) {output.textContent='如果该邮箱可接收重设邮件，请按邮件中的说明设置密码。';return;}
        authMode='login';await connect();
      } catch(error) {output.textContent=explain(error);} finally {button.disabled=false;}
    };
  }
  async function rpc(name,params={}) {
    const {data,error}=await client.rpc(name,params);if(error)throw error;return data;
  }
  async function allRows(table,key) {
    const rows=[];const pageSize=500;
    for(let offset=0;offset<=100000;offset+=pageSize) {
      const {data,error}=await client.from(table).select('*').order(key,{ascending:true}).range(offset,offset+pageSize-1);
      if(error)throw error;rows.push(...data);
      if(data.length<pageSize)return rows;
    }
    throw new Error('数据超过当前加载范围，未使用部分记录计算统计，请联系管理员。');
  }
  async function readWorkspace() {
    // Existing analytics needs complete data. Fetch every page, then publish once.
    // Server-side filtered display/aggregations are the next pagination phase.
    const [cams,periods,projects]=await Promise.all([allRows('cams','cam_id'),allRows('cam_order_periods','id'),allRows('order_projects','id')]);
    return {rows:cams.map(D.fromCam),periods,projects:projects.map(D.fromOrder)};
  }
  function publishWorkspace(snapshot) {
    users=snapshot.rows;orders=snapshot.projects;continuousState={};userAlerts=[];
    users.forEach(row=>{continuousState[String(row['转化CAM'])]=D.periodsFor(row,snapshot.periods);});
    renderAll();
  }
  async function connect() {
    if(authLoading||busy||authMode==='recovery')return;
    authLoading=true;const sequence=++authSequence;
    try {
      const {data,error}=await client.auth.getUser();if(sequence!==authSequence)return;
      if(error||!data.user) {clearWorkspace();authForm(error&&error.name!=='AuthSessionMissingError'?explain(error):'');return;}
      const claim=await rpc('op_claim_admin');if(sequence!==authSequence)return;
      if(!claim.member) {
        clearWorkspace();gate.hidden=false;gate.innerHTML='<div class="cloud-card"><h1>等待成员授权</h1><p>邮箱已登录，但尚未获准访问项目。请让管理员在成员管理中添加你的邮箱。</p><p id="cloudPendingEmail"></p><button class="btn primary" id="cloudRetryMember">重新检查权限</button> <button class="btn" id="cloudPendingLogout">退出登录</button><div class="cloud-message" id="cloudPendingMessage" role="status"></div></div>';
        document.getElementById('cloudPendingEmail').textContent=data.user.email;
        document.getElementById('cloudRetryMember').onclick=()=>connect();
        document.getElementById('cloudPendingLogout').onclick=()=>logout();return;
      }
      const snapshot=await readWorkspace();if(sequence!==authSequence)return;
      member=claim.member;currentUser=data.user;publishWorkspace(snapshot);ready=true;
      renderAccount();gate.hidden=true;document.documentElement.dataset.cloudReady='true';
      message(`云端已连接 · ${users.length} 条CAM · ${member.member_role==='viewer'?'当前账号只读':'人工复盘字段可自动保存'}`);
    } catch(error) {
      if(sequence!==authSequence)return;
      if(ready) message(`云端读取失败：${explain(error)}`,'error');
      else {clearWorkspace();authForm(explain(error));}
    } finally {authLoading=false;}
  }
  async function logout() {
    if(busy)return;authSequence++;clearWorkspace();authMode='login';authForm('正在退出…');
    const {error}=await client.auth.signOut({scope:'local'});authForm(error?explain(error):'已退出登录。');
  }
  function renderAccount() {
    const roles={admin:'管理员',editor:'编辑者',viewer:'查看者'};
    account.innerHTML=`<strong>云端协作 · ${roles[member.member_role]}</strong><span id="cloudAccountEmail"></span>${member.member_role==='admin'?'<button class="btn" id="cloudManageMembers">成员管理</button>':''}<button class="btn" id="cloudLogout">退出登录</button>`;
    document.getElementById('cloudAccountEmail').textContent=currentUser.email;
    document.getElementById('cloudLogout').onclick=()=>logout();
    const manage=document.getElementById('cloudManageMembers');if(manage)manage.onclick=()=>membersDialog();
    document.getElementById('cloudAddCam').disabled=member.member_role==='viewer';
    document.getElementById('cloudDeleteCam').hidden=member.member_role!=='admin';
    renderAll();
  }
  function setBusy(value) {
    busy=value;document.getElementById('cloudReload').disabled=value;
    const logoutButton=document.getElementById('cloudLogout');if(logoutButton)logoutButton.disabled=value;
  }
  async function mutate(params) {
    if(!ready)throw new Error('请先登录并完成云端加载。');
    if(authLoading)throw new Error('正在读取云端数据，请加载完成后再修改。');
    if(busy)throw new Error('上一项修改正在保存，请稍后再操作。');
    const sequence=authSequence;
    setBusy(true);message('正在保存到云端…','saving');
    try {
      const result=await rpc('op_manual_cam',params);
      if(sequence!==authSequence||!ready)throw new Error('登录状态已变化，请重新登录后核对云端结果。');
      if(!result.ok) {
        if(result.code==='conflict') {
          const error=new Error('这条 CAM 已被其他操作更新。本次修改没有覆盖新数据，请刷新云端后核对并重新编辑。');
          error.current=result.current;throw error;
        }
        throw new Error('这条 CAM 已不存在或已被删除，请刷新云端数据。');
      }
      const row=D.fromCam(result.record),cam=String(row['转化CAM']),index=users.findIndex(r=>String(r['转化CAM'])===cam);
      if(params.p_action==='delete') {users=users.filter(r=>String(r['转化CAM'])!==cam);delete continuousState[cam];}
      else if(index>=0)users[index]=row;
      else {users.push(row);continuousState[cam]=D.periodsFor(row,[]);}
      message('✓ 已保存到云端');renderAll();return true;
    } catch(error) {message(`未完成保存：${explain(error)}`,'error');throw error;}
    finally {setBusy(false);}
  }
  window.OrderCloud={
    async edit(cam,label,value) {
      try {
        const row=users.find(r=>String(r['转化CAM'])===String(cam));if(!row)throw new Error('记录不存在。');
        await mutate({p_action:'update',p_cam_id:String(cam),p_expected_version:row.__rowVersion,p_changes:D.manualPatch(label,value)});
        pendingDrafts.delete(String(cam)+'|'+label);paintDrafts();
        return true;
      } catch(error) {
        if(ready){pendingDrafts.set(String(cam)+'|'+label,{cam,label,value,current:error.current?.[D.FIELDS[label]]});paintDrafts();draftBox.open=true;}
        message(`未完成保存：${explain(error)}`,'error');renderAll();return false;
      }
    }
  };
  // Preserve filters/analytics, but source fields and readonly accounts cannot edit.
  const originalCellEditor=userCellEditor;
  userCellEditor=function(row,label) {
    if(member?.member_role!=='viewer'&&D.MANUAL.includes(label))return originalCellEditor(row,label);
    if(label==='用户注册邮箱'||label==='转化链接')return originalCellEditor(row,label).replace(/<button\b[^>]*>[\s\S]*?<\/button>/,'');
    const value=label==='转化后持续出单时长'?currentContinuousDays(row):row[label];
    return `<td class="cloud-readonly" title="${esc(label)}：${D.MANUAL.includes(label)?'当前账号只读':'源数据或系统字段'}">${USER_MULTI_TAG_COLS.includes(label)||label==='转化跟踪'||label==='是否流失'?renderTagValue(label,value):esc(value??'')}</td>`;
  };
  const originalRenderOrders=renderOrders;
  renderOrders=function() {originalRenderOrders();document.querySelectorAll('#orderTable [contenteditable]').forEach(el=>el.setAttribute('contenteditable','false'));document.getElementById('saveState').textContent='云端读取 · 本轮订单推品页面只读';};
  for(const id of ['uploadUsers','addOrder','saveOrders']) {
    const button=document.getElementById(id);button.disabled=true;
    button.title=id==='uploadUsers'?'云端批量导入与预警确认将在下一阶段接入':'本轮订单推品页面只读';
  }
  // Capture legacy save handlers too: programmatic clicks must not write local caches.
  document.addEventListener('click',event=>{
    if(event.target.closest('#uploadUsers,#userImportApply,#addOrder,#saveOrders,[data-warning-approve],[data-warning-ignore]')) {
      event.preventDefault();event.stopImmediatePropagation();message('此项云端业务流程尚未开放，数据没有写入本地或云端。','error');
    }
  },true);
  const actions=document.querySelector('#users .actions');
  const add=document.createElement('button');add.className='btn primary';add.id='cloudAddCam';add.textContent='＋新增CAM';add.onclick=()=>newCamDialog();actions.prepend(add);
  const remove=document.createElement('button');remove.className='btn';remove.id='cloudDeleteCam';remove.textContent='删除CAM';remove.onclick=()=>deleteCam();actions.append(remove);
  document.querySelector('#users .footerline span:last-child').textContent='人工复盘字段自动保存到云端；源数据和系统字段只读';
  function dialog(title,body) {
    const el=document.createElement('div');el.className='cloud-dialog';el.setAttribute('role','dialog');el.setAttribute('aria-modal','true');
    el.innerHTML=`<div class="cloud-card"><div class="cloud-dialog-head"><h2>${title}</h2><button class="btn" data-close type="button">关闭</button></div>${body}<div class="cloud-message" data-error role="status"></div></div>`;
    el.querySelector('[data-close]').onclick=()=>{if(!busy)el.remove();};document.body.append(el);el.querySelector('input')?.focus();return el;
  }
  function newCamDialog() {
    const el=dialog('新增待下单CAM',`<p>新建待下单记录，下单量和支付订单均为 0。已有订单的历史 CAM 请在后续正式导入时迁入。</p><form class="cloud-form">
      <label>CAM编号<input name="cam" required maxlength="200"></label><label>业务用户ID<input name="user" required></label>
      <label>转化日期（北京时间）<input name="converted" type="datetime-local" required></label>
      <label>商品标题<input name="title"></label><label>用户邮箱<input name="email" type="email"></label>
      <button class="btn primary" type="submit">新增并保存到云端</button></form>`);
    el.querySelector('form').onsubmit=async event=>{
      event.preventDefault();const form=event.currentTarget,button=form.querySelector('[type=submit]');button.disabled=true;
      const values=new FormData(form);
      try {await mutate({p_action:'create',p_cam_id:values.get('cam').trim(),p_expected_version:null,p_changes:{
        business_user_id:values.get('user').trim(),converted_at:values.get('converted')+':00+08:00',product_title:values.get('title').trim(),registration_email:values.get('email').trim()
      }});el.remove();} catch(error) {el.querySelector('[data-error]').textContent=explain(error);}finally {button.disabled=false;}
    };
  }
  async function deleteCam() {
    const cam=prompt('请输入需要删除的 CAM 编号：');if(cam===null)return;
    const row=users.find(r=>String(r['转化CAM'])===cam.trim());if(!row){message('没有找到该 CAM。','error');return;}
    if(!confirm(`确认删除 CAM ${row['转化CAM']}？该行将从名单移除，数据库保留删除历史。`))return;
    try {await mutate({p_action:'delete',p_cam_id:String(row['转化CAM']),p_expected_version:row.__rowVersion,p_changes:{}});}catch(_){/* banner retains error */}
  }
  async function membersDialog() {
    const el=dialog('成员管理',`<p>同事先注册并完成邮箱验证，再按邮箱添加。查看者只能读取；编辑者可复盘；管理员可维护成员及删除CAM。</p><div class="cloud-members" data-members>正在读取…</div>
      <form class="cloud-form"><label>添加成员邮箱<input name="email" type="email" required></label><label>角色<select name="role"><option value="editor">编辑者</option><option value="viewer">查看者</option><option value="admin">管理员</option></select></label><button class="btn primary" type="submit">添加成员</button></form>`);
    let membershipBusy=false;
    async function paint() {
      const list=await rpc('op_list_members');const host=el.querySelector('[data-members]');host.replaceChildren();
      for(const item of list) {
        const line=document.createElement('div');line.className='cloud-member';
        const label=document.createElement('strong');label.textContent=item.email;line.append(label);
        const role=document.createElement('select');for(const [v,t]of [['admin','管理员'],['editor','编辑者'],['viewer','查看者']])role.add(new Option(t,v));role.value=item.member_role;line.append(role);
        const active=document.createElement('button');active.className='btn';active.textContent=item.is_active?'停用':'启用';line.append(active);
        async function save(enabled) {
          if(membershipBusy)return;membershipBusy=true;role.disabled=true;active.disabled=true;
          try {const result=await rpc('op_set_member',{p_email:item.email,p_role:role.value,p_active:enabled,p_expected_version:item.row_version});
            if(!result.ok)throw new Error('成员资料已变化，请关闭后重新打开成员管理。');await paint();
          }catch(error){el.querySelector('[data-error]').textContent=explain(error);role.value=item.member_role;role.disabled=false;active.disabled=false;}
          finally{membershipBusy=false;}
        }
        role.onchange=()=>save(item.is_active);active.onclick=()=>save(!item.is_active);
      }
    }
    el.querySelector('form').onsubmit=async event=>{
      event.preventDefault();if(membershipBusy)return;membershipBusy=true;
      const form=event.currentTarget,values=new FormData(form),button=form.querySelector('[type=submit]');button.disabled=true;
      try {const result=await rpc('op_set_member',{p_email:values.get('email').trim(),p_role:values.get('role'),p_active:true,p_expected_version:null});
        if(!result.ok)throw new Error('该成员已存在，请在上方列表中修改。');form.reset();await paint();el.querySelector('[data-error]').textContent='成员已添加。';
      }catch(error){el.querySelector('[data-error]').textContent=explain(error);}finally{membershipBusy=false;button.disabled=false;}
    };
    try{await paint();}catch(error){el.querySelector('[data-error]').textContent=explain(error);}
  }
  document.getElementById('cloudReload').onclick=()=>{if(!busy)connect();};
  window.addEventListener('offline',()=>message('网络已断开，修改暂时无法确认保存；联网后请刷新云端核对。','error'));
  window.addEventListener('online',()=>message('网络已恢复，请刷新云端数据后继续操作。'));
  window.addEventListener('beforeunload',event=>{if(busy||pendingDrafts.size){event.preventDefault();event.returnValue='';}});
  try {
    if(!window.supabase?.createClient)throw new Error('登录组件加载失败，请刷新页面。');
    client=supabase.createClient(ORDER_PROJECT_CLOUD.url,ORDER_PROJECT_CLOUD.publishableKey,{
      auth:{storageKey:'order_project_cloud_auth_v1',persistSession:true,autoRefreshToken:true,detectSessionInUrl:true},
      global:{fetch:(input,init={})=>fetch(input,{...init,signal:init.signal||AbortSignal.timeout(20000)})}
    });
    client.auth.onAuthStateChange((event,session)=>{
      if(event==='SIGNED_OUT'){authSequence++;clearWorkspace();authMode='login';authForm();}
      else if(event==='PASSWORD_RECOVERY'){authSequence++;clearWorkspace();authMode='recovery';authForm();}
      else if(event==='SIGNED_IN'&&session&&(!ready||session.user.id!==currentUser?.id))setTimeout(()=>connect(),0);
    });
    authForm();connect();
  }catch(error){authForm(explain(error));}
})();
