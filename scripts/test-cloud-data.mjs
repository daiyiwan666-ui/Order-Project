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
