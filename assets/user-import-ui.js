/* File import and persistent warning centre for the users page. */
const ImportCore = UserImportCore;
let importWorkbook = null, importPlan = null, importFileName = '', warningFilter = 'all';
let importReadSequence = 0;
let workspaceSnapshot = null;
try { workspaceSnapshot = localStorage.getItem('tdfx_workspace_v20'); } catch (_) {}
const importInput = document.getElementById('userImportFile');
const importModal = document.getElementById('userImportModal');

function publishUsers(nextUsers, nextContinuous, nextAlerts) {
  if (userStorageWarning) throw new Error(userStorageWarning);
  if (localStorage.getItem('tdfx_workspace_v20') !== workspaceSnapshot)
    throw new Error('数据已在另一个窗口修改，请刷新后再操作，避免覆盖较新的数据。');
  // Write one snapshot first: quota/storage failure must not partly apply an import.
  const snapshot = JSON.stringify({ version: 2, users: nextUsers, continuous: nextContinuous, alerts: nextAlerts });
  localStorage.setItem('tdfx_workspace_v20', snapshot);
  workspaceSnapshot = snapshot;
  users = nextUsers; continuousState = nextContinuous; userAlerts = nextAlerts;
}
function applyCandidates(entries, alerts = userAlerts, acceptedId = null) {
  const nextUsers = ImportCore.clone(users), nextContinuous = ImportCore.clone(continuousState);
  const nextAlerts = ImportCore.clone(alerts), when = nowLabel();
  const indices = new Map(nextUsers.map((r, index) => [String(r['转化CAM']), index])), changedCams = new Set();
  for (const entry of entries) {
    const index = indices.has(entry.cam) ? indices.get(entry.cam) : -1;
    if (entry.before && (index < 0 || ImportCore.signature(nextUsers[index]) !== entry.baseline))
      throw new Error(`CAM ${entry.cam} 已在预览后发生变化，请重新上传文件。`);
    if (!entry.before && index >= 0) throw new Error(`CAM ${entry.cam} 已存在，请重新上传文件。`);
    const old = index >= 0 ? nextUsers[index] : null;
    const row = old ? { ...old, ...Object.fromEntries(ImportCore.DAILY.map(k => [k, entry.candidate[k]])) } : ImportCore.clone(entry.candidate);
    row['转化跟踪'] = ImportCore.status(row); row['最后编辑时间'] = when;
    row.__paymentRise = old ? Math.max(0, num(row['支付订单']) - num(old['支付订单'])) : 0;
    nextContinuous[entry.cam] = old ? ImportCore.continuousChange(old, row, nextContinuous[entry.cam]) : ImportCore.initialContinuous(row, true);
    if (old) nextUsers[index] = row; else { indices.set(entry.cam, nextUsers.length); nextUsers.push(row); }
    changedCams.add(entry.cam);
  }
  // A successfully applied fresh candidate supersedes any older queued candidate.
  nextAlerts.forEach(a => { if (changedCams.has(a.cam) && a.state === 'pending') { a.state = 'superseded'; a.closedAt = when; } });
  if (acceptedId) {
    const accepted = nextAlerts.find(a => a.id === acceptedId);
    if (accepted) { accepted.state = 'accepted'; accepted.closedAt = when; }
  }
  publishUsers(nextUsers, nextContinuous, nextAlerts);
}
function warningIdentity(entry) {
  return JSON.stringify([entry.cam, entry.baseline, entry.candidate, entry.problems]);
}
function queueWarnings(plan) {
  const next = ImportCore.clone(userAlerts);
  for (const entry of plan.filter(e => ['blocked', 'review'].includes(e.action))) {
    const fingerprint = warningIdentity(entry);
    if (next.some(a => a.fingerprint === fingerprint && ['pending', 'ignored', 'accepted'].includes(a.state))) continue;
    next.filter(a => entry.cam && a.cam === entry.cam && a.state === 'pending' && a.entry?.action === 'review')
      .forEach(a => { a.state = 'superseded'; a.closedAt = nowLabel(); });
    next.push({ id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`, fingerprint,
      cam: entry.cam, source: importFileName, createdAt: nowLabel(), state: 'pending', entry: ImportCore.clone(entry) });
  }
  return next;
}
function activeWarnings() {
  return userAlerts.filter(a => a.state === 'pending').map(a => ({ ...a, kind: a.entry.problems.some(p => p.type === '异常订单预警') ? 'orders' : 'data' }));
}
refreshUserLossBell = function () {
  const pending = activeWarnings(), losses = pendingLossItems(), button = $('#userLossBell'), badge = $('#userLossBellCount');
  const keys = new Set([...pending.map(a => a.cam || a.id), ...losses.map(r => String(r['转化CAM']))]);
  const kinds = new Set([...pending.map(a => a.kind), ...(losses.length ? ['loss'] : [])]);
  const label = kinds.size === 1 ? kinds.has('orders') ? '异常订单预警' : kinds.has('loss') ? '流失待分析' : '数据异常预警' : '异常预警中心';
  button.querySelector('.loss-bell-label').textContent = label;
  badge.textContent = keys.size > 99 ? '99+' : String(keys.size);
  button.classList.toggle('no-alert', keys.size === 0);
  button.title = `${label} · ${keys.size} 个待处理CAM/记录`;
  button.setAttribute('aria-label', button.title);
};
function warningCard(a) {
  const entry = a.entry, canLocate = users.some(r => String(r['转化CAM']) === a.cam);
  const changes = entry.problems.map(p => `<tr><td>${esc(p.type)}</td><td>${esc(p.field)}</td><td>${esc(p.before)}</td><td>${esc(p.after)}</td><td>${esc(p.message)}</td></tr>`).join('');
  return `<article class="warning-card"><div class="warning-card-head"><strong>CAM ${esc(a.cam || '缺失')}</strong><span class="mini">${esc(a.source)} · 行 ${esc(entry.rowNumber)} · ${esc(a.createdAt)}</span></div>
    <div class="mini">${entry.action === 'review' ? '该行更新已暂缓，当前仍保留历史值。确认后会同步订单、流失信息、状态和出单时长。' : '该记录未写入，请修正源文件后重新上传。'}</div>
    <div class="warning-table-wrap"><table class="table warning-table"><thead><tr><th>类型</th><th>字段</th><th>历史/对照值</th><th>文件值</th><th>说明</th></tr></thead><tbody>${changes}</tbody></table></div>
    <div class="warning-actions">${canLocate ? `<button class="btn" data-warning-locate="${esc(a.cam)}">查看</button>` : '<span class="mini">尚未入表</span>'}
      ${entry.action === 'review' ? `<button class="btn primary" data-warning-approve="${esc(a.id)}">确认更新</button>` : ''}
      <button class="btn" data-warning-ignore="${esc(a.id)}">忽略本次</button></div></article>`;
}
openLossModal = function () { openWarningCentre(); };
function openWarningCentre() {
  const pending = activeWarnings(), losses = pendingLossItems();
  $('#lossModal .modalhead b').textContent = '异常预警中心';
  const tabs = [['all', '全部'], ['orders', '异常订单'], ['data', '数据异常'], ['loss', '流失待分析']];
  const filtered = pending.filter(a => warningFilter === 'all' || a.kind === warningFilter);
  const lossCards = ['all', 'loss'].includes(warningFilter) ? losses.map(r => `<article class="warning-card"><div class="warning-card-head"><strong>流失待分析 · CAM ${esc(r['转化CAM'])}</strong><span>${fmt(num(r['转化下单量']))} 单</span></div><div class="mini">${esc(r['国家'])} · ${esc(r['商品标题'])} · ${esc(r['转化日期'])}</div><div class="warning-actions"><button class="btn" data-warning-locate="${esc(r['转化CAM'])}">查看</button></div></article>`).join('') : '';
  $('#lossBody').innerHTML = `<div class="warning-tabs">${tabs.map(([k, label]) => `<button class="btn ${k === warningFilter ? 'primary' : ''}" data-warning-filter="${k}">${label}</button>`).join('')}</div>
    <div class="mini">查看只定位记录；异常订单需明确确认后才更新。人工复盘字段保持原值。</div>
    ${filtered.map(warningCard).join('')}${lossCards || ''}${!filtered.length && !lossCards ? '<div class="empty">暂无待处理预警</div>' : ''}`;
  $('#lossModal').classList.add('open');
}
$('#lossBody').addEventListener('click', event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.warningFilter) { warningFilter = button.dataset.warningFilter; openWarningCentre(); return; }
  if (button.dataset.warningLocate) { locateUserByCam(button.dataset.warningLocate); return; }
  const id = button.dataset.warningApprove || button.dataset.warningIgnore;
  const warning = userAlerts.find(a => a.id === id && a.state === 'pending'); if (!warning) return;
  try {
    if (button.dataset.warningApprove) {
      if (!confirm(`确认将 CAM ${warning.cam} 更新为文件中的数值？此操作会同步该行订单和相关状态。`)) return;
      // Revalidate the snapshot against the latest row; stale approvals never overwrite a newer edit.
      const entry = warning.entry;
      if (entry.action !== 'review' || entry.problems.some(p => p.hard)) throw new Error('该异常不能直接确认，请修正文件后重传。');
      applyCandidates([entry], userAlerts, id);
    } else {
      const next = ImportCore.clone(userAlerts), item = next.find(a => a.id === id);
      item.state = 'ignored'; item.closedAt = nowLabel(); publishUsers(users, continuousState, next);
    }
    renderAll(); openWarningCentre();
  } catch (error) { alert(error.message); }
});

function buildImportPreview() {
  const sheet = document.getElementById('userImportSheet').value;
  const matrix = XLSX.utils.sheet_to_json(importWorkbook.Sheets[sheet], { header: 1, defval: '', raw: true });
  const owners = users.flatMap(r => ImportCore.tags(r['负责人']));
  const parsed = ImportCore.readMatrix(matrix, owners, { date1904: !!importWorkbook.Workbook?.WBProps?.date1904 });
  importPlan = ImportCore.planImport(parsed, users, USER_COLS);
  const totals = { new: 0, update: 0, unchanged: 0, review: 0, blocked: 0 };
  importPlan.forEach(e => totals[e.action]++);
  const labels = { new: '新增', update: '更新', unchanged: '无变化', review: '待人工确认', blocked: '需修正' };
  $('#userImportSummary').textContent = Object.entries(totals).map(([k, n]) => `${labels[k]} ${n}`).join(' · ');
  $('#userImportMappings').innerHTML = `<details><summary>查看字段映射</summary><div class="mapping-list">${parsed.mapping.map(m => `<span>${esc(m.source)} → ${esc(m.target)}</span>`).join('')}<span>标签 → 分类提取负责人和转化原因（不填人工备注）</span></div></details>`;
  // Pagination keeps large imports reviewable without rendering an unbounded table.
  let page = 0; const pageSize = 50;
  function paint() {
    $('#userImportPreview').innerHTML = `<table class="table import-preview"><thead><tr><th>源行</th><th>CAM</th><th>处理</th><th>下单量</th><th>支付订单</th><th>状态</th><th>说明</th></tr></thead><tbody>${importPlan.slice(page * pageSize, (page + 1) * pageSize).map(e => `<tr><td>${esc(e.rowNumber)}</td><td>${esc(e.cam || '缺失')}</td><td>${labels[e.action]}</td><td>${esc(e.candidate['转化下单量'])}</td><td>${esc(e.candidate['支付订单'])}</td><td>${esc(e.candidate['转化跟踪'])}</td><td>${esc(e.problems.map(p => p.message).join('；') || (e.duplicateCount ? `合并 ${e.duplicateCount} 条相同重复记录` : ''))}</td></tr>`).join('')}</tbody></table>`;
    $('#userImportPages').innerHTML = `<button class="btn" data-import-page="prev" ${page === 0 ? 'disabled' : ''}>上一页</button><span>${page + 1} / ${Math.max(1, Math.ceil(importPlan.length / pageSize))}</span><button class="btn" data-import-page="next" ${(page + 1) * pageSize >= importPlan.length ? 'disabled' : ''}>下一页</button>`;
  }
  $('#userImportPages').onclick = event => { const b = event.target.closest('[data-import-page]'); if (!b || b.disabled) return; page += b.dataset.importPage === 'next' ? 1 : -1; paint(); };
  paint(); $('#userImportApply').disabled = importPlan.length === 0;
}
function showImportError(error) {
  importPlan = null; $('#userImportApply').disabled = true;
  $('#userImportSummary').textContent = error.message; $('#userImportPreview').innerHTML = ''; $('#userImportPages').innerHTML = ''; $('#userImportMappings').innerHTML = '';
}
async function loadImportFile() {
  const file = importInput.files[0]; if (!file) return;
  const readSequence = ++importReadSequence;
  importFileName = file.name; importWorkbook = null; importPlan = null;
  $('#userImportApply').disabled = true; $('#userImportSummary').textContent = '正在读取文件…';
  $('#userImportPreview').innerHTML = ''; $('#userImportMappings').innerHTML = ''; $('#userImportPages').innerHTML = '';
  $('#userImportFileName').textContent = file.name; importModal.classList.add('open');
  try {
    if (!window.XLSX) throw new Error('表格组件未加载，请检查项目 assets/vendor 文件。');
    if (!/\.(xlsx|xls|xlsm|xlsb|xlt|xltx|xltm|csv|tsv|ods)$/i.test(file.name)) throw new Error('请选择支持的Excel、CSV、TSV或ODS文件。');
    if (file.size > 32 * 1024 * 1024) throw new Error('文件超过32MB，请拆分后上传。');
    const buffer = await file.arrayBuffer();
    if (readSequence !== importReadSequence) return;
    const isText = /\.(csv|tsv)$/i.test(file.name);
    const input = isText ? new TextDecoder($('#userImportEncoding').value).decode(buffer) : buffer;
    importWorkbook = XLSX.read(input, { type: isText ? 'string' : 'array', raw: true, cellDates: false });
    const names = importWorkbook.SheetNames;
    $('#userImportSheet').innerHTML = names.map(n => `<option>${esc(n)}</option>`).join('');
    // Prefer an actual mapped data sheet over a workbook's cover/notes sheet.
    $('#userImportSheet').value = names.find(n => {
      const rows = XLSX.utils.sheet_to_json(importWorkbook.Sheets[n], { header: 1, raw: true });
      return rows.some(r => r.some(v => ['广告id', '转化CAM'].includes(String(v ?? '').trim())));
    }) || names[0];
    buildImportPreview();
  } catch (error) { showImportError(error); }
}
$('#uploadUsers').addEventListener('click', () => {
  closeTagEditor(); closeColumnFilter(); importInput.value = ''; importInput.click();
});
importInput.addEventListener('change', loadImportFile);
$('#userImportSheet').addEventListener('change', () => { try { buildImportPreview(); } catch (error) { showImportError(error); } });
$('#userImportEncoding').addEventListener('change', loadImportFile);
$('#userImportClose').addEventListener('click', () => { importModal.classList.remove('open'); importPlan = null; });
$('#userImportApply').addEventListener('click', () => {
  if (!importPlan) return;
  try {
    // Rebuild at application time, so edits in another UI action are not silently lost.
    buildImportPreview();
    const actionable = importPlan.filter(e => ['new', 'update'].includes(e.action));
    const flagged = importPlan.filter(e => ['review', 'blocked'].includes(e.action));
    const nextWarnings = queueWarnings(importPlan);
    applyCandidates(actionable, nextWarnings);
    const added = actionable.filter(e => e.action === 'new').length, updated = actionable.length - added;
    $('#userImportResult').textContent = `${importFileName}：新增 ${added}，更新 ${updated}，无变化 ${importPlan.filter(e => e.action === 'unchanged').length}，预警 ${flagged.length}。异常记录未更新。`;
    importPlan = null; importModal.classList.remove('open'); renderAll();
    if (added) { activeUserYear = availableUserYears()[0]; renderUsers(); }
    if (flagged.length) { warningFilter = 'all'; openWarningCentre(); }
  } catch (error) { $('#userImportSummary').textContent = `未完成导入：${error.message}`; }
});

function applyUserEdit(cam, col, value) {
  try {
    if (['转化跟踪', '转化后持续出单时长', '最后编辑时间', '年', '季度'].includes(col)) return false;
    const old = users.find(r => String(r['转化CAM']) === String(cam)); if (!old) return false;
    const row = ImportCore.clone(old);
    if (['转化下单量', '支付订单'].includes(col)) {
      const n = ImportCore.count(value); if (n == null) throw new Error(`${col}必须为非负整数。`); value = n;
    }
    if (USER_MULTI_TAG_COLS.includes(col)) value = ImportCore.tags(value).join('、');
    if (col === '是否流失') { value = ImportCore.loss(value); if (!value) throw new Error('是否流失只能选择是或否。'); }
    if (USER_DATE_COLS.includes(col)) {
      if (!ImportCore.empty(value) && !ImportCore.date(value)) throw new Error('请输入有效日期。');
      value = ImportCore.stamp(value, col !== '流失日期');
    }
    if (col === '转化CAM') {
      value = String(value).trim();
      if (!value || users.some(r => r !== old && String(r['转化CAM']) === value)) throw new Error('转化CAM必须填写且保持唯一。');
    }
    if (String(old[col] ?? '') === String(value)) return true;
    row[col] = value; row['转化跟踪'] = ImportCore.status(row);
    if (col === '转化日期') {
      const d = ImportCore.date(value); if (d) { row['年'] = d.getUTCFullYear(); row['季度'] = Math.floor(d.getUTCMonth() / 3) + 1; }
    }
    row['最后编辑时间'] = nowLabel();
    const nextContinuous = ImportCore.clone(continuousState), nextAlerts = ImportCore.clone(userAlerts);
    const newCam = String(row['转化CAM']);
    nextContinuous[newCam] = ImportCore.continuousChange(old, row, nextContinuous[cam]);
    if (newCam !== String(cam)) {
      delete nextContinuous[cam];
      nextAlerts.filter(a => a.cam === String(cam) && a.state === 'pending').forEach(a => { a.state = 'superseded'; a.closedAt = nowLabel(); });
    }
    row.__paymentRise = col === '支付订单' ? Math.max(0, num(value) - num(old['支付订单'])) : row.__paymentRise;
    publishUsers(users.map(r => r === old ? row : r), nextContinuous, nextAlerts);
    if (col === '支付订单' && row.__paymentRise >= 40) alert(`订单快速上涨：CAM ${newCam} 的支付订单本次增加 ${row.__paymentRise}，已达到 +40 提示阈值。`);
    return true;
  } catch (error) { alert(`未保存：${error.message}`); return false; }
}

// Persist migration once; subsequent ordinary renders never edit timestamps.
try { publishUsers(users, continuousState, userAlerts); }
catch (error) { $('#userImportResult').textContent = `本地保存不可用：${error.message}。请启用浏览器存储后再编辑或上传。`; }
renderAll();
setInterval(() => {
  if ($('#users').classList.contains('active') && !document.activeElement?.closest('#userTable') && !tagEditorPop && !columnFilterPop) renderUsers();
}, 60000);
