import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import '../assets/user-import-core.js';

const C = globalThis.UserImportCore;
const XLSX = createRequire(import.meta.url)('../assets/vendor/xlsx.full.min.js');
const columns = Object.keys(C.MAP).concat(['负责人', '转化原因', '转化备注', '流失原因', '是否完成', '年', '季度']);
const row = (overrides = {}) => ({
  '转化CAM': '2097270937834487808', user_id: '1701129629270605824',
  '转化日期': '2026-09-01 10:00:00', '最近下单日期': '2026-09-02 12:00:00',
  '转化下单量': 20, '支付订单': 18, '是否流失': '否', '流失日期': '', '转化跟踪': '下单中',
  '转化原因': '价格优势', '转化备注': '人工记录，不覆盖', ...overrides
});
function matrix(records) {
  const headers = [...Object.values(C.MAP), '标签'];
  return [headers, ...records.map(r => [...Object.keys(C.MAP).map(k => r[k] ?? ''), r.tags ?? '[唐华, 价格优势]'])];
}
const plan = (records, current = []) => C.planImport(C.readMatrix(matrix(records)), current, columns);

test('一对一映射、长编号、负责人和原因分类，忽略运营标签', () => {
  const parsed = C.readMatrix(matrix([row({ tags: '[中用户, 唐华, unmapped商品, 推荐供端部分SKU缺货, 推荐供端缺少SKU, 新品, 9.14运营商品, 未通过DSers下单, 价格优势]' })]));
  const data = parsed.rows[0].data;
  assert.equal(data['转化CAM'], '2097270937834487808');
  assert.equal(data['负责人'], '唐华');
  assert.equal(data['转化原因'], '未通过DSers下单行为、价格优势、Unmmapped商品');
  assert.equal(data['转化备注'], undefined);
});
test('相同含义标签归一并去重，有DSers和未通过DSers不合并', () => {
  assert.deepEqual(C.tags('[unmapped商品, unmmapped商品, 未通过DSers下单, 有DSers下单行为]'), ['Unmmapped商品', '未通过DSers下单行为', '有DSers下单行为']);
});
test('字段缺失或重复映射拒绝整份文件，不猜测CAM来源', () => {
  assert.throws(() => C.readMatrix([['目标商品档案ID'], ['x']]), /没有找到/);
  const m = matrix([row()]); m[0].push('转化CAM'); m[1].push('other');
  assert.throws(() => C.readMatrix(m), /同时存在/);
  assert.throws(() => C.readMatrix([['广告id', '用户ID'], ['x', 'y']]), /缺少必需列/);
});
test('新CAM新增，已有CAM累计值替换，人工字段保持不变', () => {
  assert.equal(plan([row()])[0].action, 'new');
  const old = row(); const entry = plan([row({ '转化下单量': 25, '支付订单': 22, '最近下单日期': '2026-09-03 12:00:00', '转化备注': '覆盖' })], [old])[0];
  assert.equal(entry.action, 'update'); assert.equal(entry.candidate['转化下单量'], 25);
  assert.equal(entry.candidate['转化备注'], '人工记录，不覆盖');
  assert.equal(old['转化下单量'], 20);
});
test('订单时间不变也可以更新支付订单；仅流失信息变化也更新', () => {
  assert.equal(plan([row({ '支付订单': 19 })], [row()])[0].action, 'update');
  const e = plan([row({ '是否流失': '是', '流失日期': '2026-09-04' })], [row()])[0];
  assert.equal(e.action, 'update'); assert.equal(e.candidate['转化跟踪'], '已流失');
});
test('重复上传无变化，重复记录合并，冲突CAM全部暂缓', () => {
  assert.equal(plan([row()], [row()])[0].action, 'unchanged');
  const duplicate = plan([row(), row()]); assert.equal(duplicate.length, 1); assert.equal(duplicate[0].duplicateCount, 1);
  const conflict = plan([row(), row({ '支付订单': 17 })]); assert.equal(conflict[0].action, 'blocked');
});
test('任何一列订单回退进入人工复核；旧值在计划生成中不变', () => {
  const old = row(); const entry = plan([row({ '转化下单量': 17, '支付订单': 15 })], [old])[0];
  assert.equal(entry.action, 'review'); assert.equal(entry.problems.filter(p => p.type === '异常订单预警').length, 2);
  assert.equal(old['支付订单'], 18); assert.equal(entry.before['支付订单'], 18);
});
test('订单数缺失、负数、小数、无效文本都不转换成0', () => {
  for (const v of ['', '-', -1, 2.5, 'abc', '1e3']) {
    const entry = plan([row({ '转化下单量': v })], [row()])[0]; assert.equal(entry.action, 'blocked', String(v));
  }
  assert.equal(C.count('0'), 0); assert.equal(C.count('1,000'), 1000);
});
test('不安全的Excel数值长编号拒绝，文本长编号保留', () => {
  assert.equal(plan([row({ '转化CAM': Number('2097270937834487808') })])[0].action, 'blocked');
  assert.equal(plan([row({ '转化CAM': '2097270937834487808' })])[0].action, 'new');
});
test('同CAM归属不同用户拒绝，空CAM报错', () => {
  assert.equal(plan([row({ user_id: 'another' })], [row()])[0].action, 'blocked');
  assert.equal(plan([row({ '转化CAM': '' })])[0].action, 'blocked');
});
test('最近日期回退、支付大于下单需复核，缺失日期和无效时间线需修正', () => {
  assert.equal(plan([row({ '最近下单日期': '2026-09-01 12:00:00' })], [row()])[0].action, 'review');
  assert.equal(plan([row({ '支付订单': 21 })], [row()])[0].action, 'review');
  for (const overrides of [ { '是否流失': '是' }, { '最近下单日期': '' }, { '转化日期': '2026-02-30' }, { '流失日期': '2026-08-01', '是否流失': '是' } ])
    assert.equal(plan([row(overrides)])[0].action, 'blocked');
});
test('日期解析不使用宿主时区，保留秒，验证日历有效性及Excel日期', () => {
  assert.equal(C.stamp('2026年10月10日 15:01:02'), '2026-10-10 15:01:02');
  assert.equal(C.stamp('2026-10-10T15:01'), '2026-10-10 15:01:00');
  assert.equal(C.date('2026-02-30'), null); assert.equal(C.date('2026-10-10 25:00'), null);
  assert.equal(C.stamp(1, false), '1900-01-01'); assert.equal(C.stamp(61, false), '1900-03-01');
});

test('1904日期系统的工作簿正确换算日期', () => {
  const r = row({ '转化日期': 1, '最近下单日期': 2 });
  const parsed = C.readMatrix(matrix([r]), [], { date1904: true });
  assert.equal(parsed.rows[0].data['转化日期'], '1904-01-02 00:00:00');
  assert.equal(parsed.rows[0].data['最近下单日期'], '1904-01-03 00:00:00');
});
test('下单状态使用当前订单量，流失同日不算回流，次日才回流', () => {
  assert.equal(C.status(row({ '转化下单量': 0 })), '待下单');
  assert.equal(C.status(row({ '支付订单': 0 })), '下单中');
  assert.equal(C.status(row({ '是否流失': 'yes', '流失日期': '2026-09-02' })), '已流失');
  assert.equal(C.status(row({ '是否流失': 'yes', '流失日期': '2026-09-01' })), '流失又回');
});
test('互斥原因标签不能进入正常导入，库存少与缺SKU不混淆', () => {
  assert.equal(plan([row({ tags: '[高价值用户, 有DSers下单行为]' })])[0].action, 'blocked');
  assert.equal(plan([row({ tags: '[唐华, 推荐供端缺少SKU]' })])[0].candidate['转化原因'], '');
});
test('历史起点回退到转化，待下单不计时，未支付仍计时', () => {
  const r = row({ '支付订单': 0 });
  assert.equal(C.continuousDays(r, C.initialContinuous(r), '2026-09-03 10:00:00'), 2);
  const waiting = row({ '转化下单量': 0, '支付订单': 0, '最近下单日期': '' });
  assert.equal(C.continuousDays(waiting, C.initialContinuous(waiting), '2026-09-03 10:00:00'), 0);
});
test('首次出单固定起点，停止按流失日期，回流恢复，排除流失期间', () => {
  const waiting = row({ '转化下单量': 0, '支付订单': 0, '最近下单日期': '' });
  const first = row({ '转化下单量': 1, '支付订单': 0 });
  let state = C.continuousChange(waiting, first, C.initialContinuous(waiting));
  assert.equal(state.activeStart, '2026-09-02 12:00:00');
  const later = row({ '最近下单日期': '2026-09-03 16:00:00' });
  state = C.continuousChange(first, later, state); assert.equal(state.activeStart, '2026-09-02 12:00:00');
  const lost = { ...later, '是否流失': '是', '流失日期': '2026-09-05' };
  state = C.continuousChange(later, lost, state); assert.equal(state.activeStart, null);
  assert.equal(C.continuousDays(lost, state, '2026-09-10 12:00:00'), 2);
  const returned = { ...lost, '最近下单日期': '2026-09-08 12:00:00' };
  state = C.continuousChange(lost, returned, state); assert.equal(state.activeStart, '2026-09-08 12:00:00');
  assert.equal(C.continuousDays(returned, state, '2026-09-10 12:00:00'), 4);
  const newer = { ...returned, '最近下单日期': '2026-09-09 12:00:00' };
  state = C.continuousChange(returned, newer, state); assert.equal(state.activeStart, '2026-09-08 12:00:00');
});
test('导入快照直接跨过流失及回流，也关闭原区间再恢复', () => {
  const original = row(), returned = row({ '是否流失': '是', '流失日期': '2026-09-05', '最近下单日期': '2026-09-08 12:00:00' });
  const state = C.continuousChange(original, returned, C.initialContinuous(original));
  assert.equal(state.periods[0].end, '2026-09-05'); assert.equal(state.activeStart, '2026-09-08 12:00:00');
});

test('人工先标记流失再补日期时，不丢失此前计时起点', () => {
  const original = row(), missingDate = row({ '是否流失': '是' });
  let state = C.continuousChange(original, missingDate, C.initialContinuous(original));
  assert.equal(state.activeStart, '2026-09-01 10:00:00');
  const completed = { ...missingDate, '流失日期': '2026-09-05' };
  state = C.continuousChange(missingDate, completed, state);
  assert.equal(state.activeStart, null); assert.equal(state.periods.length, 1);
  assert.equal(state.periods[0].end, '2026-09-05');
});

test('Excel多格式解析保持长CAM编号、中文标签和日期映射', () => {
  for (const bookType of ['xlsx', 'xls', 'xlsb', 'xlsm', 'ods']) {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix([row({ tags: '[唐华, unmapped商品]' })])), '数据');
    const bytes = XLSX.write(workbook, { bookType, type: 'buffer' });
    const read = XLSX.read(bytes, { type: 'buffer', raw: true, cellDates: false });
    const parsed = C.readMatrix(XLSX.utils.sheet_to_json(read.Sheets[read.SheetNames[0]], { header: 1, raw: true, defval: '' }));
    assert.equal(parsed.rows[0].data['转化CAM'], '2097270937834487808', bookType);
    assert.equal(parsed.rows[0].data['转化原因'], 'Unmmapped商品', bookType);
  }
});

test('CSV及TSV的引号、中文、长ID和换行不损坏字段', () => {
  for (const FS of [',', '\t']) {
    const values = matrix([row({ '商品标题': '名称,含"引号"\n第二行' })]);
    const encoded = XLSX.utils.sheet_to_csv(XLSX.utils.aoa_to_sheet(values), { FS });
    const book = XLSX.read(encoded, { type: 'string', raw: true });
    const parsed = C.readMatrix(XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, raw: true, defval: '' }));
    assert.equal(parsed.rows[0].data['转化CAM'], '2097270937834487808');
    assert.equal(parsed.rows[0].data['商品标题'], '名称,含"引号"\n第二行');
  }
});
