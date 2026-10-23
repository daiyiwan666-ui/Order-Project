import test from 'node:test';
import assert from 'node:assert/strict';
import '../assets/user-import-core.js';
import '../assets/cloud-data.js';
const D=globalThis.OrderCloudData;

test('数据库映射保留长编号、隐藏源字段、数组和服务器版本',()=>{
  const row=D.fromCam({cam_id:'20928156567025090001',business_user_id:'20928156567025090002',
    source_extras:{'套餐':'Advanced','转化下单量':999},countries:['US','CA'],is_lost:false,
    converted_at:'2026-10-19T16:01:00Z',order_count:0,paid_order_count:0,row_version:3});
  assert.equal(row['转化CAM'],'20928156567025090001');assert.equal(row.user_id,'20928156567025090002');
  assert.equal(row['转化下单量'],0);assert.equal(row['套餐'],'Advanced');assert.equal(row['国家'],'US、CA');
  assert.equal(row['是否流失'],'否');assert.equal(row['转化日期'],'2026-10-20 00:01:00');assert.equal(row.__rowVersion,3);
});
test('人工接口只提交复盘字段，不能提交系统和订单字段',()=>{
  assert.deepEqual(D.manualPatch('转化备注','人工说明'),{conversion_notes:'人工说明'});
  assert.deepEqual(D.manualPatch('操作','复盘、复盘、联系用户'),{actions:['复盘','联系用户']});
  for(const field of ['转化下单量','支付订单','转化跟踪','转化原因','最后编辑时间','转化CAM'])assert.throws(()=>D.manualPatch(field,'x'),/仅开放人工复盘字段/);
});
test('持续出单完全使用云端区间，按北京时间映射，不能回退为浏览器猜测',()=>{
  const row={'转化CAM':'cam','转化跟踪':'流失又回'};
  const state=D.periodsFor(row,[{cam_id:'cam',started_at:'2026-10-01T00:00:00Z',ended_at:'2026-10-03T00:00:00Z',is_estimated:true},
    {cam_id:'cam',started_at:'2026-10-05T00:00:00Z',ended_at:null,is_estimated:false},
    {cam_id:'another',started_at:'2026-01-01T00:00:00Z',ended_at:null}]);
  assert.equal(state.activeStart,'2026-10-05 08:00:00');assert.equal(state.periods.length,1);assert.equal(state.estimated,true);
  assert.equal(globalThis.UserImportCore.continuousDays(row,state,'2026-10-06 08:00:00'),3);
  assert.equal(D.periodsFor(row,[]).activeStart,'');
});
test('文件行发送原始归属、版本和解析问题，日期转换显式北京时间，人工字段不进导入',()=>{
  const C=globalThis.UserImportCore,headers=[...Object.values(C.MAP),'标签','套餐','转化备注'];
  const values={'转化CAM':'20928156567025090001',user_id:'20928156567025090002','转化日期':'2026-10-01 09:00:00',
    '最近下单日期':'2026-10-02 10:00:00','转化下单量':5,'支付订单':3,'是否流失':'no','流失日期':''};
  const parsed=C.readMatrix([headers,[...Object.keys(C.MAP).map(k=>values[k]??''),'[唐华,unmapped商品,新品]','Advanced','不能覆盖人工备注']]);
  const [row]=D.importRows(parsed,[{'转化CAM':'20928156567025090001',__rowVersion:7}]);
  assert.equal(row.expected_version,7);assert.equal(row.data.converted_at,'2026-10-01T09:00:00+08:00');
  assert.equal(row.data.is_lost,false);assert.equal(row.data.source_extras['套餐'],'Advanced');
  assert.equal(row.data.conversion_notes,undefined);assert.equal(row.data.source_extras['转化备注'],undefined);
  assert.deepEqual(row.data.conversion_reasons,['Unmmapped商品']);assert.ok(row.data.source_tags.includes('新品'));
});
test('分块按行数和实际字节上限，保留所有行，超大单行明确报错',()=>{
  const rows=Array.from({length:401},(_,i)=>({row_number:i+1,data:{cam_id:String(i)}}));
  assert.deepEqual(D.chunks(rows).map(c=>c.length),[200,200,1]);
  assert.equal(D.chunks(rows).flat().length,401);
  assert.throws(()=>D.chunks([{data:{x:'中'.repeat(400000)}}]),/单行数据过大/);
});
test('共享预警映射保留服务端确认权限、行版本和原文件名',()=>{
  const warning=D.fromAlert({id:'alert',source_cam_id:'cam',alert_state:'pending',row_version:4,import_batch_id:'batch',
    created_at:'2026-10-23T02:00:00Z',source_rows:[2],is_confirmable:true,before_values:{},
    candidate_values:{cam_id:'cam',order_count:1},issues:[{type:'异常订单预警',field:'转化下单量',before:5,after:1,hard:false}]},[{id:'batch',file_name:'daily.xlsx'}]);
  assert.equal(warning.source,'daily.xlsx');assert.equal(warning.__rowVersion,4);assert.equal(warning.entry.action,'review');assert.equal(warning.entry.problems[0].after,1);
});
