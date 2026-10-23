/* CAM import rules. Pure functions shared by the browser and Node checks. */
(function (root) {
  'use strict';
  const DAY = 86400000;
  const MAP = Object.freeze({
    '转化CAM': '广告id', 'user_id': '用户ID', '用户注册邮箱': '用户邮箱',
    '国家': '主营国家', '转化日期': '广告转化时间', '广告位': '转化素材',
    '商品标题': '销端商品标题', '转化链接': '推荐供端URL',
    '最近下单日期': '最近下单时间', '转化下单量': '下单总数',
    '支付订单': '完成支付总数', '第三方插件': '第三方履约app名',
    '是否流失': '是否流失', '流失日期': '流失日期'
  });
  const DAILY = ['最近下单日期', '转化下单量', '支付订单', '是否流失', '流失日期'];
  const TRIGGERS = ['高价值用户', '有DSers下单行为', '未通过DSers下单行为',
    '原供库存不足', '原供物流不可用', '价格优势', '部分价优', '推荐供端库存充足',
    '推荐供端部分SKU库存较少', '库存较少', 'AE断联', 'Unmmapped商品', '1688商品'];
  const MUTEX = [TRIGGERS.slice(0, 3), TRIGGERS.slice(3, 5), TRIGGERS.slice(5, 7), TRIGGERS.slice(7, 10)];
  const OWNER_DEFAULTS = ['唐华', '庞遵毅'];
  const clone = value => JSON.parse(JSON.stringify(value));
  const empty = value => value == null || ['', '-', '—'].includes(String(value).trim());
  const text = value => empty(value) ? '' : String(value).trim();
  function canonical(tag) {
    const raw = String(tag || '').trim(), compact = raw.replace(/\s+/g, '').toLowerCase();
    if (['unmapped商品', 'unmmapped商品'].includes(compact)) return 'Unmmapped商品';
    if (['未通过dsers下单', '未通过dsers下单行为'].includes(compact)) return '未通过DSers下单行为';
    if (compact.replace(/[-‐‑–—]+/g, '-') === '流失-待分析原因') return '流失--待分析原因';
    return raw;
  }
  function tags(value) {
    return [...new Set(text(value).replace(/^\s*\[/, '').replace(/\]\s*$/, '')
      .split(/[,，、;；|\n]/).map(canonical).filter(Boolean))];
  }
  // Dates represent business wall-clock time in UTC slots, independent of host timezone.
  function date(value) {
    if (empty(value)) return null;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value < 1 || value > 2958465 || Math.floor(value) === 60) return null;
      return new Date(Date.UTC(1899, 11, value < 60 ? 31 : 30) + Math.round(value * DAY));
    }
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? new Date(value) : null;
    const match = String(value).trim().match(/^(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!match) return null;
    const [, y, m, d, h = '0', min = '0', sec = '0'] = match;
    const out = new Date(Date.UTC(+y, +m - 1, +d, +h, +min, +sec));
    return out.getUTCFullYear() === +y && out.getUTCMonth() === +m - 1 && out.getUTCDate() === +d &&
      +h < 24 && +min < 60 && +sec < 60 ? out : null;
  }
  function stamp(value, withTime = true) {
    const d = date(value);
    if (!d) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
      (withTime ? ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` : '');
  }
  function now() {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  }
  function loss(value) {
    if (['yes', '是'].includes(text(value).toLowerCase())) return '是';
    if (['no', '否'].includes(text(value).toLowerCase())) return '否';
    return null;
  }
  function count(value) {
    if (empty(value)) return null;
    const s = String(value).trim();
    if (typeof value !== 'number' && !/^\d+$/.test(s) && !/^\d{1,3}(,\d{3})+$/.test(s)) return null;
    const n = Number(s.replace(/,/g, ''));
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  function status(row) {
    if (loss(row['是否流失']) === '是') {
      const recent = stamp(row['最近下单日期'], false), stop = stamp(row['流失日期'], false);
      return recent && stop && recent > stop ? '流失又回' : '已流失';
    }
    if (loss(row['是否流失']) === '否' && count(row['转化下单量']) != null)
      return count(row['转化下单量']) === 0 ? '待下单' : '下单中';
    return row['转化跟踪'] || '';
  }
  const days = (a, b) => date(a) && date(b) ? Math.max(0, Math.floor((date(b) - date(a)) / DAY)) : 0;
  function initialContinuous(row, historical = true) {
    const s = { version: 2, periods: [], activeStart: null, estimated: historical, lastStatus: status(row) };
    if (count(row['转化下单量']) == null || count(row['转化下单量']) === 0) return s;
    const start = stamp(historical ? row['转化日期'] : row['最近下单日期']) || stamp(row['转化日期']);
    const stop = stamp(row['流失日期'], false);
    if (!start) return s;
    if (s.lastStatus === '已流失' || s.lastStatus === '流失又回') {
      if (stop && date(stop) >= date(start)) s.periods.push({ start, end: stop, estimated: historical });
      if (s.lastStatus === '流失又回') s.activeStart = stamp(row['最近下单日期']);
      else if (!stop) s.activeStart = start;
    } else if (s.lastStatus === '下单中') s.activeStart = start;
    return s;
  }
  function continuousChange(oldRow, row, previous) {
    const s = clone(previous?.version === 2 ? previous : initialContinuous(oldRow));
    const nextStatus = status(row), oldStatus = s.lastStatus;
    const stop = stamp(row['流失日期'], false), oldStop = stamp(oldRow['流失日期'], false);
    if (['已流失', '流失又回'].includes(nextStatus)) {
      // A first observed snapshot may already include both loss and a later return.
      if (s.activeStart && (!['已流失', '流失又回'].includes(oldStatus) || (stop && stop !== oldStop))) {
        if (stop && date(stop) >= date(s.activeStart)) s.periods.push({ start: s.activeStart, end: stop, estimated: s.estimated });
        if (stop) s.activeStart = null;
      } else if (stop && oldStop && stop !== oldStop && s.periods.length && s.periods.at(-1).end === oldStop) {
        s.periods.at(-1).end = stop;
      }
      if (nextStatus === '已流失') { if (stop) s.activeStart = null; }
      else if (!s.activeStart) s.activeStart = stamp(row['最近下单日期']);
    } else if (nextStatus === '待下单') {
      s.activeStart = null;
    } else if (!s.activeStart && nextStatus === '下单中') {
      s.activeStart = stamp(row['最近下单日期']);
      s.estimated = false;
    }
    s.lastStatus = nextStatus;
    return s;
  }
  function continuousDays(row, state, at = now()) {
    const s = state?.version === 2 ? state : initialContinuous(row);
    const elapsed = s.periods.reduce((total, p) => total + Math.max(0, date(p.end) - date(p.start)), 0) +
      (s.activeStart && status(row) !== '已流失' && status(row) !== '待下单' ? Math.max(0, date(at) - date(s.activeStart)) : 0);
    return Math.max(0, Math.floor(elapsed / DAY));
  }
  function signature(row) {
    return JSON.stringify(['转化CAM', 'user_id', ...DAILY].map(k => [k, ['最近下单日期', '流失日期'].includes(k)
      ? stamp(row[k], k !== '流失日期') : ['转化下单量', '支付订单'].includes(k) ? count(row[k]) : text(row[k])]));
  }
  function issuesFor(row, old) {
    const problems = [];
    const add = (type, field, before, after, message, hard = false) => problems.push({ type, field, before: before ?? '', after: after ?? '', message, hard });
    for (const k of ['转化下单量', '支付订单']) {
      if (count(row[k]) == null) add('订单值无效', k, old?.[k], row[k], `${k}必须为非负整数，不能缺失`, true);
      else if (old && count(old[k]) != null && count(row[k]) < count(old[k]))
        add('异常订单预警', k, old[k], row[k], `${k}减少 ${count(old[k]) - count(row[k])}`);
    }
    if (!text(row['转化CAM'])) add('CAM匹配异常', '转化CAM', '', '', '缺少CAMid，无法匹配', true);
    if (!text(row.user_id)) add('CAM归属冲突', 'user_id', old?.user_id, row.user_id, '缺少用户ID', true);
    if (old && text(old.user_id) !== text(row.user_id))
      add('CAM归属冲突', 'user_id', old.user_id, row.user_id, '同一CAM对应不同用户ID，请修正文件', true);
    if (!loss(row['是否流失'])) add('流失信息缺失', '是否流失', old?.['是否流失'], row['是否流失'], '是否流失只能为yes/no或是/否', true);
    for (const k of ['转化日期', '最近下单日期', '流失日期']) {
      if (!empty(row[k]) && !date(row[k])) add('日期逻辑异常', k, old?.[k], row[k], '无法解析日期', true);
    }
    if (!date(row['转化日期'])) add('关键更新字段缺失', '转化日期', '', row['转化日期'], '缺少有效转化日期', true);
    if (loss(row['是否流失']) === '是' && !date(row['流失日期']))
      add('流失信息缺失', '流失日期', old?.['流失日期'], row['流失日期'], '已流失但缺少有效流失日期', true);
    if (old && date(old['最近下单日期']) && empty(row['最近下单日期']))
      add('关键更新字段缺失', '最近下单日期', old['最近下单日期'], '', '文件缺少最近下单时间，不自动清空历史值', true);
    if (count(row['转化下单量']) > 0 && !date(row['最近下单日期']))
      add('关键更新字段缺失', '最近下单日期', old?.['最近下单日期'], row['最近下单日期'], '有订单但缺少有效最近下单时间', true);
    if (old && date(row['最近下单日期']) && date(old['最近下单日期']) && date(row['最近下单日期']) < date(old['最近下单日期']))
      add('最近下单时间回退', '最近下单日期', old['最近下单日期'], row['最近下单日期'], '最近下单时间早于历史记录');
    for (const k of ['最近下单日期', '流失日期']) {
      const current = date(row[k]), start = date(row['转化日期']);
      if (current && start && (k === '流失日期' ? stamp(current, false) < stamp(start, false) : current < start))
        add('日期逻辑异常', k, row['转化日期'], row[k], `${k}早于转化日期`, true);
    }
    if (count(row['支付订单']) != null && count(row['转化下单量']) != null && count(row['支付订单']) > count(row['转化下单量']))
      add('支付量大于下单量', '支付订单', row['转化下单量'], row['支付订单'], '支付订单大于转化下单量，请复核统计口径');
    const reasons = tags(row['转化原因']);
    MUTEX.forEach(group => { const hit = group.filter(t => reasons.includes(t)); if (hit.length > 1)
      add('标签冲突', '转化原因', '', row['转化原因'], `互斥标签同时出现：${hit.join('、')}`, true); });
    return problems;
  }
  function readMatrix(matrix, owners = [], options = {}) {
    const headerIndex = matrix.findIndex(r => r.some(v => ['广告id', '转化CAM'].includes(String(v ?? '').trim())));
    if (headerIndex < 0) throw new Error('没有找到“广告id”或“转化CAM”表头，请检查工作表。');
    const headers = matrix[headerIndex].map(v => String(v ?? '').replace(/^\uFEFF/, '').trim());
    const seen = new Set();
    for (const h of headers.filter(Boolean)) { if (seen.has(h)) throw new Error(`表头“${h}”重复，无法确定映射。`); seen.add(h); }
    const mapping = {};
    for (const [target, source] of Object.entries(MAP)) {
      const hits = [source, ...(source !== target ? [target] : [])].filter(h => headers.includes(h));
      if (hits.length > 1) throw new Error(`“${target}”同时存在源字段和标准字段，请只保留一列。`);
      if (hits.length) mapping[target] = headers.indexOf(hits[0]);
    }
    for (const k of ['转化CAM', 'user_id', ...DAILY]) if (!(k in mapping)) throw new Error(`缺少必需列：${MAP[k]}（${k}）。`);
    const people = new Set([...OWNER_DEFAULTS, ...owners]);
    const rows = [];
    matrix.slice(headerIndex + 1).forEach((values, i) => {
      if (values.every(empty)) return;
      const data = {}, errors = [];
      Object.entries(mapping).forEach(([k, index]) => {
        let value = values[index];
        if (options.date1904 && typeof value === 'number' && ['转化日期', '最近下单日期', '流失日期'].includes(k)) value += 1462;
        if (['转化CAM', 'user_id'].includes(k) && typeof value === 'number' && !Number.isSafeInteger(value))
          errors.push({ type: 'CAM匹配异常', field: k, before: '', after: String(value), message: '长编号以数字存储可能已丢失精度，请在源文件改为文本', hard: true });
        if (['转化日期', '最近下单日期', '流失日期'].includes(k)) data[k] = empty(value) ? '' : stamp(value, k !== '流失日期') || text(value);
        else if (['转化下单量', '支付订单'].includes(k)) data[k] = count(value) ?? text(value);
        else if (k === '是否流失') data[k] = loss(value) ?? text(value);
        else data[k] = text(value);
      });
      if (headers.includes('标签')) {
        const extracted = tags(values[headers.indexOf('标签')]);
        data['负责人'] = extracted.filter(t => people.has(t)).join('、');
        data['转化原因'] = TRIGGERS.filter(t => extracted.includes(t)).join('、');
      } else {
        for (const k of ['负责人', '转化原因']) if (headers.includes(k)) data[k] = tags(values[headers.indexOf(k)]).join('、');
      }
      const mapped = new Set(Object.values(mapping));
      const ignoredExtras = new Set(['标签','负责人','转化原因','转化备注','流失原因','流失备注','操作','备选推荐供端','是否完成','最近下单周','流失监控系统']);
      const sourceExtras = Object.fromEntries(headers.map((h,index)=>[h,index])
        .filter(([h,index])=>h && !mapped.has(index) && !ignoredExtras.has(h))
        .map(([h,index])=>[h,values[index]??'']));
      rows.push({ rowNumber: headerIndex + i + 2, data, errors, sourceExtras,
        sourceTags: headers.includes('标签') ? tags(values[headers.indexOf('标签')]) : null });
    });
    return { mapping: Object.entries(mapping).map(([target, index]) => ({ target, source: headers[index] })), rows };
  }
  function planImport(parsed, users, columns) {
    const byCam = new Map(users.map(r => [text(r['转化CAM']), r]));
    const grouped = new Map();
    parsed.rows.forEach(entry => { const cam = text(entry.data['转化CAM']); if (!grouped.has(cam)) grouped.set(cam, []); grouped.get(cam).push(entry); });
    return [...grouped.values()].flatMap(entries => {
      const cam = text(entries[0].data['转化CAM']);
      if (!cam) return entries.map(e => ({ ...e, cam: '', action: 'blocked', problems: issuesFor(e.data).concat(e.errors), candidate: e.data }));
      const distinct = new Set(entries.map(e => JSON.stringify([e.data, e.errors])));
      if (distinct.size > 1) return [{ cam, rowNumber: entries.map(e => e.rowNumber).join('、'), action: 'blocked', candidate: entries[0].data,
        problems: [{ type: 'CAM匹配异常', field: '转化CAM', before: cam, after: cam, message: '文件内同一CAM存在冲突记录，未更新', hard: true }] }];
      const entry = entries[0], old = byCam.get(cam);
      const candidate = old ? { ...clone(old) } : Object.fromEntries(columns.map(c => [c, '']));
      if (old) {
        DAILY.forEach(k => { candidate[k] = entry.data[k]; });
      } else Object.assign(candidate, entry.data);
      const inputForCheck = { ...candidate, user_id: entry.data.user_id };
      const problems = [...entry.errors, ...issuesFor(inputForCheck, old)];
      candidate['转化跟踪'] = status(candidate);
      const d = date(candidate['转化日期']);
      if (d) { candidate['年'] = d.getUTCFullYear(); candidate['季度'] = Math.floor(d.getUTCMonth() / 3) + 1; }
      const changed = !old || signature(old) !== signature(candidate) || old['转化跟踪'] !== candidate['转化跟踪'];
      return [{ ...entry, cam, candidate, before: old ? clone(old) : null, baseline: old ? signature(old) : null, problems,
        duplicateCount: entries.length - 1,
        action: problems.some(p => p.hard) ? 'blocked' : problems.length ? 'review' : !old ? 'new' : changed ? 'update' : 'unchanged' }];
    });
  }
  root.UserImportCore = { MAP, DAILY, TRIGGERS, clone, empty, text, canonical, tags, date, stamp, now, loss, count,
    status, days, initialContinuous, continuousChange, continuousDays, signature, issuesFor, readMatrix, planImport };
})(typeof window === 'undefined' ? globalThis : window);
