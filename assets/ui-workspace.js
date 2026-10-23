/* Shared presentation layer. Does not write business data or alter import rules. */
(function () {
  'use strict';
  const paths = {
    chart:'<path d="M4 19h16M6 15v-4M12 15V5M18 15V8"/>',
    dashboard:'<path d="m3 10 9-7 9 7M5 9v11h5v-6h4v6h5V9"/>',
    analysis:'<path d="M4 4v16h16M8 15v-4M12 15V7M16 15v-6"/>',
    users:'<circle cx="10" cy="8" r="3"/><path d="M4 20v-3a5 5 0 0 1 10 0v3M16 5a3 3 0 0 1 0 6M20 20v-3a5 5 0 0 0-3-4"/>',
    orders:'<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6M9 11h6M9 15h3"/>',
    search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
    columns:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>',
    upload:'<path d="M12 16V3m-4 4 4-4 4 4M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
    download:'<path d="M12 3v13m-4-4 4 4 4-4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    refresh:'<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 3M4 16l2 3a7 7 0 0 0 12-2"/>',
    user:'<circle cx="12" cy="8" r="3"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
    menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',
    chevron:'<path d="m9 5 7 7-7 7"/>',
    filter:'<path d="M4 4h16l-6 7v8l-4 2V11z"/>'
  };
  const icon = name => `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.chart}</svg>`;
  function icons(root=document) { root.querySelectorAll('[data-ui-icon]').forEach(el=>{el.innerHTML=icon(el.dataset.uiIcon);}); }
  icons();
  const labels={dashboard:'数据看板',analysis:'数据分析',users:'转化用户名单',orders:'订单推品项目数据'};
  document.querySelectorAll('.nav button').forEach(button=>{
    button.innerHTML=icon(button.dataset.page)+`<span>${labels[button.dataset.page]}</span>`;
    button.addEventListener('click',()=>{
      document.getElementById('uiPageName').textContent=labels[button.dataset.page];
      document.querySelectorAll('.nav button').forEach(b=>b.setAttribute('aria-current',b===button?'page':'false'));
      closeMobileNav();
    });
  });
  document.querySelector('.nav button.active').setAttribute('aria-current','page');
  document.querySelector('.logo').addEventListener('click',event=>{event.preventDefault();document.querySelector('[data-page="dashboard"]').click();});
  document.getElementById('uiWorkspaceMode').textContent=document.documentElement.dataset.storage==='cloud'?'云端协作':'本地演示';
  const backdrop=document.createElement('button');backdrop.className='ui-mobile-backdrop';backdrop.setAttribute('aria-label','收起导航');document.body.append(backdrop);
  function closeMobileNav() {document.body.classList.remove('ui-nav-open');document.getElementById('uiNavToggle').setAttribute('aria-expanded','false');}
  document.getElementById('uiNavToggle').onclick=()=>{const open=document.body.classList.toggle('ui-nav-open');document.getElementById('uiNavToggle').setAttribute('aria-expanded',String(open));};
  backdrop.onclick=closeMobileNav;
  const actionIcons={uploadUsers:'upload',exportUsers:'download',exportOrders:'download',cloudAddCam:'plus',cloudReload:'refresh',clearUserFilters:'filter',dashReset:'refresh'};
  Object.entries(actionIcons).forEach(([id,name])=>{const button=document.getElementById(id);if(button)button.insertAdjacentHTML('afterbegin',icon(name));});

  const defaultCols=['转化CAM','商品标题','国家','负责人','转化跟踪','转化下单量','支付订单','最近下单日期'];
  const columnKey='order_project_ui_columns_v1';
  let visibleCols=[...defaultCols], search='', detailCam=null;
  try {const saved=JSON.parse(localStorage.getItem(columnKey)||'null');if(Array.isArray(saved)&&saved.includes('转化CAM')&&saved.every(c=>USER_COLS.includes(c)))visibleCols=[...new Set(saved)];}catch (_) {}
  const widths={'转化CAM':170,'商品标题':220,'国家':72,'负责人':95,'转化跟踪':95,'转化下单量':100,'支付订单':90,'最近下单日期':170,'转化备注':240,'操作':180,'user_id':170,'用户注册邮箱':230};
  function saveColumns(cols) {visibleCols=['转化CAM',...cols.filter(c=>c!=='转化CAM')];try{localStorage.setItem(columnKey,JSON.stringify(visibleCols));}catch (_) {}renderUsers();}
  const originalFiltered=userFiltered;
  userFiltered=function () {const rows=originalFiltered();if(!search)return rows;return rows.filter(r=>['转化CAM','user_id','用户注册邮箱','商品标题'].some(c=>String(r[c]||'').toLocaleLowerCase().includes(search)));};
  const originalClear=clearUserFilters;
  clearUserFilters=function () {search='';document.getElementById('uiUserSearch').value='';originalClear();};
  const originalLocate=locateUserByCam;
  locateUserByCam=function (cam) {search='';document.getElementById('uiUserSearch').value='';originalLocate(cam);};
  document.getElementById('uiUserSearch').addEventListener('input',event=>{search=event.target.value.trim().toLocaleLowerCase();closeColumnFilter();renderUsers();});
  const quickFilters=[['uiStatusFilter','转化跟踪','全部状态'],['uiCountryFilter','国家','全部国家'],['uiOwnerFilter','负责人','全部负责人']];
  quickFilters.forEach(([id,col])=>{document.getElementById(id).onchange=event=>setUserFilter(col,event.target.value?new Set([event.target.value]):null);});
  function paintQuickFilters() {
    for(const [id,col,label] of quickFilters) {
      const el=document.getElementById(id), values=unique(users.flatMap(r=>splitTags(r[col]))).sort((a,b)=>a.localeCompare(b,'zh-CN'));
      const selected=userFieldFilters[col], single=selected?.size===1?[...selected][0]:'';
      el.replaceChildren(new Option(selected?.size>1?'多项已筛选':label,''),...values.map(v=>new Option(v,v)));
      el.value=single;el.title=col;
    }
  }
  renderUsers=function () {
    initContinuous();renderUserYearTabs();refreshUserLossBell();paintQuickFilters();
    const rows=userFiltered(), total=users.filter(r=>userYearKey(r)===activeUserYear).length, filters=Object.keys(userFieldFilters).length;
    document.getElementById('userCount').textContent=`${userYearLabel(activeUserYear)} · 当前 ${fmt(rows.length)} 条 / 共 ${fmt(total)} 条`;
    document.getElementById('userFilterState').textContent=filters||search?`已筛选${filters?' · '+filters+' 个字段':''}${search?' · 关键词搜索':''}`:'全部记录';
    const head='<thead><tr class="excel-head-row">'+visibleCols.map((c,i)=>`<th class="${i===0?'ui-frozen':''}" style="width:${widths[c]||160}px;min-width:${widths[c]||160}px"><div class="excel-th-title"><span title="${esc(c)}">${esc(c)}</span><button type="button" class="filter-btn${userFieldFilters[c]?' active':''}" data-filter-col="${esc(c)}" aria-label="筛选${esc(c)}" title="筛选${esc(c)}">⌄</button></div></th>`).join('')+'<th class="ui-row-actions">详情</th></tr></thead>';
    const columns=visibleCols.length+1;
    const body=groupUsersByConversionMonth(rows).map(group=>{
      const key=activeUserYear+'|'+group.month,collapsed=collapsedUserMonths.has(key),label=group.month==='未分月'?'未分月':group.month+'月';
      const groupRow=`<tr class="user-month-group-row"><td colspan="${columns}"><button type="button" class="user-month-group-toggle" data-month-group="${esc(key)}" aria-expanded="${!collapsed}"><span class="user-month-chevron">${collapsed?'▸':'▾'}</span><strong>${esc(label)}</strong><span class="user-month-count">${fmt(group.items.length)} 条记录</span></button></td></tr>`;
      return groupRow+(collapsed?'':group.items.map(row=>`<tr class="user-data-row" data-user-cam="${esc(row['转化CAM'])}" tabindex="-1">${visibleCols.map((c,i)=>{
        let cell=userCellEditor(row,c);if(i===0)cell=cell.replace('class="','class="ui-frozen ');
        if(c==='支付订单'&&num(row.__paymentRise)>=40)cell=cell.replace('</td>',`<span class="rise">↑ +${num(row.__paymentRise)}</span></td>`);
        return cell;
      }).join('')}<td class="ui-row-actions"><button type="button" class="ui-detail-button" data-cam-detail="${esc(row['转化CAM'])}" aria-label="查看CAM ${esc(row['转化CAM'])}详情">详情</button></td></tr>`).join(''));
    }).join('');
    const table=document.getElementById('userTable');table.innerHTML=head+'<tbody>'+(body||`<tr><td colspan="${columns}" class="empty">${search||filters?'没有找到匹配记录，请调整搜索或筛选条件。':'当前年份暂无数据，上传文件或新增CAM后即可查看。'}</td></tr>` )+'</tbody>';
    bindGroupedUserTable(table);
    table.querySelectorAll('[data-cam-detail]').forEach(button=>button.onclick=()=>openDetail(button.dataset.camDetail));
    if(detailCam&&document.getElementById('uiDetailModal')?.classList.contains('open'))paintDetail();
    paintDashboardExtra();
  };

  function makeModal(id,title,drawer=false) {
    const el=document.createElement('div');el.id=id;el.className='modal'+(drawer?' ui-detail-drawer':'');
    el.setAttribute('role','dialog');el.setAttribute('aria-modal','true');el.setAttribute('aria-label',title);
    el.innerHTML=`<div class="modalbox" style="${drawer?'':'width:min(620px,96vw)'}"><div class="modalhead"><b>${title}</b><button type="button" class="close" aria-label="关闭${title}">×</button></div><div class="ui-modal-content"></div></div>`;
    el.querySelector('.close').onclick=()=>closeModal(el);el.addEventListener('click',event=>{if(event.target===el)closeModal(el);});document.body.append(el);return el;
  }
  let returnFocus=null;
  function showModal(el) {returnFocus=document.activeElement;el.classList.add('open');el.querySelector('.close')?.focus();}
  function closeModal(el) {el.classList.remove('open');if(returnFocus?.isConnected)returnFocus.focus();}
  const columnModal=makeModal('uiColumnModal','表格列设置');
  document.getElementById('uiColumnSettings').onclick=()=>{
    const content=columnModal.querySelector('.ui-modal-content');
    content.innerHTML='<p class="mini">选择名单中展示的字段。仅影响本浏览器的视图，隐藏列仍保留数据，导出仍包含全部字段。</p><div class="actions"><button class="btn" data-column-preset="default">恢复常用列</button><button class="btn" data-column-preset="all">选择全部字段</button></div><div class="ui-column-list">'+USER_COLS.map(c=>`<label class="ui-column-option"><input type="checkbox" value="${esc(c)}" ${visibleCols.includes(c)?'checked':''} ${c==='转化CAM'?'disabled':''}>${esc(c)}${c==='转化CAM'?'（固定）':''}</label>`).join('')+'</div><div class="ui-dialog-actions"><button class="btn" data-column-cancel>取消</button><button class="btn primary" data-column-apply>应用视图</button></div>';
    content.querySelectorAll('[data-column-preset]').forEach(button=>button.onclick=()=>{const chosen=button.dataset.columnPreset==='all'?USER_COLS:defaultCols;content.querySelectorAll('input').forEach(input=>input.checked=chosen.includes(input.value));});
    content.querySelector('[data-column-cancel]').onclick=()=>closeModal(columnModal);
    content.querySelector('[data-column-apply]').onclick=()=>{
      const selected=[...content.querySelectorAll('input:checked')].map(el=>el.value);
      const ordered=[...defaultCols.filter(c=>selected.includes(c)),...USER_COLS.filter(c=>selected.includes(c)&&!defaultCols.includes(c))];
      saveColumns(ordered);closeModal(columnModal);
    };
    showModal(columnModal);
  };
  const detailModal=makeModal('uiDetailModal','CAM 详情',true);
  function paintDetail() {
    const row=users.find(r=>String(r['转化CAM'])===detailCam),host=detailModal.querySelector('.ui-modal-content');
    if(!row){host.innerHTML='<div class="empty">该记录已删除或暂不可访问，请刷新数据后核对。</div>';return;}
    host.innerHTML=`<div class="ui-detail-meta"><strong>CAM ${esc(detailCam)}</strong><span>${esc(row['商品标题']||'未填写商品标题')}</span></div><dl class="ui-detail-grid">${USER_COLS.map(col=>{
      const value=col==='转化后持续出单时长'?currentContinuousDays(row):row[col];
      const href=col==='转化链接'?safeHttpUrl(value):'';
      return `<div class="ui-detail-field"><dt>${esc(col)}</dt><dd>${href?`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(value)}</a>`:esc(value??'')||'—'}</dd></div>`;
    }).join('')}</dl><div class="ui-dialog-actions"><button type="button" class="btn primary" data-detail-edit>在表格中查看全部字段</button></div>`;
    host.querySelector('[data-detail-edit]').onclick=()=>{saveColumns([...defaultCols,...USER_COLS.filter(c=>!defaultCols.includes(c))]);closeModal(detailModal);locateUserByCam(detailCam);};
  }
  function openDetail(cam) {detailCam=cam;paintDetail();showModal(detailModal);}

  const extra=document.createElement('div');extra.className='ui-dashboard-extra';extra.id='uiDashboardExtra';
  extra.innerHTML='<section class="card"><div class="sectionTitle">转化状态分布</div><div id="uiStatusChart"></div></section><section class="card"><div class="sectionTitle">待处理事项</div><div id="uiPendingTasks"></div><div class="mini" style="margin-top:12px">预警确认后才更新数据；其他成员的修改需刷新云端后查看。</div></section>';
  document.getElementById('dashboard').append(extra);
  const dashboard=document.getElementById('dashboard');
  const efficiencySection=document.getElementById('efficiencyKpis').closest('.section');
  const additional=document.createElement('details');additional.className='ui-additional-metrics';
  additional.innerHTML='<summary>更多经营指标与流量效率<span>展开查看日均订单、去重用户与曝光表现</span></summary><div id="uiSecondaryKpis" class="ui-secondary-kpis"></div>';
  additional.append(efficiencySection);dashboard.append(additional);
  const dashboardUpload=document.createElement('button');dashboardUpload.className='btn primary';dashboardUpload.id='uiDashboardUpload';
  dashboardUpload.innerHTML=icon('upload')+'上传最新文件';
  dashboardUpload.onclick=()=>{document.querySelector('[data-page="users"]').click();document.getElementById('uploadUsers').click();};
  dashboard.querySelector('.actions').append(dashboardUpload);
  const originalKpis=renderKpis;
  renderKpis=function () {
    originalKpis();
    const k=kpis(),pending=activeWarnings().length+pendingLossItems().length;
    const overview=[['转化CAM',k.tertiary[0][1],'当前筛选范围','users'],['转化下单量',k.primary[0][1],'当前累计订单','orders'],['支付订单',k.primary[1][1],'当前累计支付订单','chart'],['待处理预警',pending,'工作区待处理记录','filter']];
    document.getElementById('kpis').innerHTML='<div class="kpi-group primary">'+overview.map(([label,value,hint,name])=>`<div class="kpi primary ui-overview-kpi"><div class="ui-kpi-icon ${name==='filter'?'warning':''}">${icon(name)}</div><div><div class="lab">${label}</div><div class="val">${fmt(value)}</div><div class="hint">${hint}</div></div></div>`).join('')+'</div>';
    document.getElementById('uiSecondaryKpis').innerHTML=[...k.primary.slice(2),k.tertiary[1]].map(([label,value,hint])=>`<div class="kpi"><div class="lab">${esc(label)}</div><div class="val">${Number.isInteger(value)?fmt(value):value.toFixed(2)}</div><div class="hint">${esc(hint)}</div></div>`).join('');
    dashboardUpload.disabled=document.getElementById('uploadUsers').disabled;
  };
  function paintDashboardExtra() {
    const rows=filtered(),statusColors={'下单中':'#206bc4','待下单':'#a5b5c9','已流失':'#64748b','流失又回':'#2b9e88'};
    let angle=0;const slices=[];
    const values=Object.entries(statusColors).map(([label,color])=>{const count=rows.filter(r=>r['转化跟踪']===label).length,start=angle;angle+=rows.length?count/rows.length*360:0;slices.push(`${color} ${start}deg ${angle}deg`);return {label,color,count};});
    document.getElementById('uiStatusChart').innerHTML=rows.length?`<div class="ui-donut-layout"><div class="ui-donut" role="img" aria-label="转化状态分布，共${rows.length}条CAM" style="background:conic-gradient(${slices.join(',')})"><div class="ui-donut-center"><small>转化CAM</small><b>${fmt(rows.length)}</b></div></div><div class="ui-status-legend">${values.map(v=>`<div class="ui-legend-row"><i style="background:${v.color}"></i><span>${v.label}</span><b>${fmt(v.count)}</b></div>`).join('')}</div></div>`:'<div class="empty">导入转化记录后显示状态分布</div>';
    const pending=activeWarnings(),losses=pendingLossItems(),groups=[['orders','异常订单',pending.filter(a=>a.kind==='orders').length],['data','数据异常',pending.filter(a=>a.kind==='data').length],['loss','流失待分析',losses.length]];
    document.getElementById('uiPendingTasks').innerHTML=groups.map(([kind,label,count])=>`<button class="ui-task" data-task-kind="${kind}"><b>${label}</b><span class="ui-task-count">${count}</span><span>查看 ›</span></button>`).join('');
    document.querySelectorAll('[data-task-kind]').forEach(button=>button.onclick=()=>{warningFilter=button.dataset.taskKind;openWarningCentre();});
  }
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape') {closeMobileNav();const open=[...document.querySelectorAll('.modal.open')].at(-1);if(open?.id==='uiColumnModal'||open?.id==='uiDetailModal'||open?.id==='lossModal')closeModal(open);}
    if(event.key==='Tab') {
      const open=[...document.querySelectorAll('.modal.open')].at(-1);if(!open||!['uiColumnModal','uiDetailModal','lossModal'].includes(open.id))return;
      const focusable=[...open.querySelectorAll('button:not(:disabled),input:not(:disabled),a[href],select,[tabindex="0"]')].filter(el=>el.getClientRects().length);
      const first=focusable[0],last=focusable.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }
  });
  document.getElementById('lossModal').addEventListener('click',event=>{if(event.target.id==='lossModal')closeModal(event.currentTarget);});
  renderKpis();renderUsers();
})();
