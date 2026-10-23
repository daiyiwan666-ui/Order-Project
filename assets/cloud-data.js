/* Mapping between the shared database and the existing Chinese analytics model. */
(function(root) {
  'use strict';
  const FIELDS = Object.freeze({
    '转化CAM':'cam_id',user_id:'business_user_id','用户注册邮箱':'registration_email','国家':'countries',
    '转化日期':'converted_at','广告位':'ad_placements','负责人':'owners','商品标题':'product_title',
    '转化链接':'conversion_url','转化备注':'conversion_notes','最近下单日期':'last_order_at',
    '转化下单量':'order_count','支付订单':'paid_order_count','第三方插件':'fulfillment_apps',
    '是否流失':'is_lost','转化原因':'conversion_reasons','流失原因':'loss_reasons','流失日期':'lost_on',
    '流失备注':'loss_notes','操作':'actions','备选推荐供端':'backup_supplier','是否完成':'completion_tags',
    '转化跟踪':'conversion_status','年':'conversion_year','季度':'conversion_quarter','最后编辑时间':'updated_at'
  });
  const MANUAL = Object.freeze(['转化备注','流失原因','流失备注','操作','备选推荐供端','是否完成']);
  function wallTime(value) {
    if (!value) return '';
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) throw new Error('数据库返回了无效时间');
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone:'Asia/Shanghai',
      year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
    }).formatToParts(d).map(x=>[x.type,x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  }
  function fromCam(record) {
    const row = {...record.source_extras};
    for (const [label,field] of Object.entries(FIELDS)) {
      const v=record[field];
      row[label] = Array.isArray(v) ? v.join('、') : v ?? '';
    }
    for (const label of ['转化日期','最近下单日期','最后编辑时间']) row[label]=wallTime(record[FIELDS[label]]);
    row['是否流失']=record.is_lost?'是':'否';
    row.__rowVersion=record.row_version;
    return row;
  }
  function manualPatch(label,value) {
    if (!MANUAL.includes(label)) throw new Error('本轮云端编辑仅开放人工复盘字段；订单和流失信息由文件更新流程维护。');
    return {[FIELDS[label]]:['流失原因','操作','是否完成'].includes(label) ? root.UserImportCore.tags(value) : String(value??'')};
  }
  function periodsFor(row,periods) {
    const own=periods.filter(p=>p.cam_id===String(row['转化CAM']));
    return {version:2,periods:own.filter(p=>p.ended_at).map(p=>({start:wallTime(p.started_at),end:wallTime(p.ended_at),estimated:p.is_estimated})),
      activeStart:wallTime(own.find(p=>!p.ended_at)?.started_at),estimated:own.some(p=>p.is_estimated),lastStatus:row['转化跟踪']};
  }
  function fromOrder(record) {
    const row={...record.source_extras};
    const fields={'日期':'project_date','项目':'project_name','放量用户数':'distributed_users','转化订单数':'conversion_orders',
      '活跃放量用户数':'active_distributed_users','曝光量':'impressions','CTA点击数':'cta_clicks','转化用户数':'converted_users','转化商品数':'converted_products'};
    for(const [label,field] of Object.entries(fields)) row[label]=record[field]??'';
    return row;
  }
  function importRows(parsed,currentUsers) {
    const C=root.UserImportCore,versions=new Map(currentUsers.map(r=>[String(r['转化CAM']),r.__rowVersion]));
    return parsed.rows.map(entry=>{
      const data={};
      for(const [label,field] of Object.entries(FIELDS)) {
        if(!(label in entry.data))continue;
        const value=entry.data[label];
        if(['countries','ad_placements','owners','fulfillment_apps','conversion_reasons'].includes(field)) data[field]=C.tags(value);
        else if(['converted_at','last_order_at'].includes(field)) {const stamp=C.stamp(value);data[field]=stamp?stamp.replace(' ','T')+'+08:00':value||null;}
        else if(field==='lost_on')data[field]=C.stamp(value,false)||value||null;
        else if(field==='is_lost')data[field]=C.loss(value)==='是'?true:C.loss(value)==='否'?false:value;
        else data[field]=value;
      }
      data.source_extras=entry.sourceExtras||{};data.source_tags=entry.sourceTags??null;
      return {row_number:entry.rowNumber,data,parse_issues:entry.errors||[],expected_version:versions.get(String(entry.data['转化CAM']))??null};
    });
  }
  function fromAlert(record,batches=[]) {
    const batch=batches.find(b=>b.id===record.import_batch_id),data=record.candidate_values||{};
    const before=record.before_values?.cam_id?fromCam(record.before_values):null;
    const candidate={};
    for(const[label,field]of Object.entries(FIELDS)) {
      const value=data[field];candidate[label]=Array.isArray(value)?value.join('、'):value??'';
    }
    for(const label of ['转化日期','最近下单日期']) {
      const value=data[FIELDS[label]];try{candidate[label]=wallTime(value);}catch{candidate[label]=String(value??'');}
    }
    candidate['是否流失']=data.is_lost===true?'是':data.is_lost===false?'否':data.is_lost??'';
    const problems=(record.issues||[]).map(p=>({...p,before:Array.isArray(p.before)?p.before.join('、'):p.before??'',after:Array.isArray(p.after)?p.after.join('、'):p.after??''}));
    return {id:record.id,cam:record.source_cam_id||record.cam_id||'',state:record.alert_state,
      source:batch?.file_name||'云端导入',createdAt:wallTime(record.created_at),__rowVersion:record.row_version,
      entry:{action:record.is_confirmable?'review':'blocked',rowNumber:(record.source_rows||[]).join('、'),candidate,before,problems}};
  }
  function chunks(rows,maxRows=200,maxBytes=900000) {
    const result=[];let chunk=[],size=2;
    for(const row of rows){const n=new TextEncoder().encode(JSON.stringify(row)).length+1;
      if(n>maxBytes)throw new Error('单行数据过大，请减少单元格内容后重新上传。');
      if(chunk.length&&(chunk.length>=maxRows||size+n>maxBytes)){result.push(chunk);chunk=[];size=2;}
      chunk.push(row);size+=n;
    }
    if(chunk.length)result.push(chunk);
    if(result.length>100)throw new Error('文件分块超过100份，请拆分文件后上传。');
    return result;
  }
  root.OrderCloudData=Object.freeze({FIELDS,MANUAL,wallTime,fromCam,manualPatch,periodsFor,fromOrder,importRows,fromAlert,chunks});
})(typeof window==='undefined'?globalThis:window);
