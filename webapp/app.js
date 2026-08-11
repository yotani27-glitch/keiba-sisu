// 指数ビューア: TARGET frontier 外部指数取込形式のCSV（ZIP同梱可）をフォルダから読み込み、
// 場コード付きID（YYYYMMDD+場所2桁+開催回2桁+開催日2桁+R2桁+馬番2桁）を分解して一覧表にする。

const PLACE_NAMES = {
  '01': '札幌', '02': '函館', '03': '福島', '04': '新潟', '05': '東京',
  '06': '中山', '07': '中京', '08': '京都', '09': '阪神', '10': '小倉',
};

// ラベル(ファイル名の指数種別プレフィックス) -> 表示名
const LABEL_NAMES = {
  '00tua': 'LVL2',
  // 2024年の一部(36開催日)にのみ存在する出所不明の指数。00tua(LVL2)とは値が異なる別物。
  '0tua': '未確認指数(0tua)',
  '1tua': '坂路調教指数',
  '2tua': '坂路血統指数',
  '3tua': '持ち時計血統指数',
  '4tua': 'コース連動指数',
  '5tua': '血統連動指数',
  '6tua': 'Ｓ指数',
  '7tua': 'Ｆ指数',
  '8tua': 'TUA指数',
  '9tua': 'arms指数',
  '10tua': 'バランス指数',
  '11tua': 'arms指数２',
  'gallop': 'gallop指数',
  'GYN': '予想人気順',
};

// 値が小さいほど良いラベル。記載のないラベルは「値が大きいほど良い」として順位を計算する。
const ASCENDING_LABELS = new Set([]);

// 値自体がすでに順位（予想人気順など）のため、別途の順位計算・順位列表示が不要なラベル
const NO_RANK_LABELS = new Set(['GYN']);

function labelDisplayName(label) {
  return LABEL_NAMES[label] || label;
}

const state = {
  records: new Map(),   // key: date|placeCode|race|uma -> record
  labels: new Set(),    // 指数ラベル一覧 (例: '00','1',...,'11','gallop','GYN')
  hiddenLabels: new Set(),
  loadedAt: null,
  rootName: '',
  filters: { date: '', place: '', race: '' },
  mode: 'both',
  search: '',
  sort: null, // { key, dir }
};

const $ = (sel) => document.querySelector(sel);
const els = {
  loadButton: $('#loadButton'),
  loadStatus: $('#loadStatus'),
  empty: $('#empty'),
  dashboard: $('#dashboard'),
  dateSelect: $('#dateSelect'),
  placeSelect: $('#placeSelect'),
  raceSelect: $('#raceSelect'),
  modeSelect: $('#modeSelect'),
  searchInput: $('#searchInput'),
  columnButton: $('#columnButton'),
  columnMenu: $('#columnMenu'),
  columnCount: $('#columnCount'),
  exportButton: $('#exportButton'),
  yearExportSelect: $('#yearExportSelect'),
  yearExportButton: $('#yearExportButton'),
  stats: $('#stats'),
  table: $('#dataTable'),
  tableEmpty: $('#tableEmpty'),
  toast: $('#toast'),
};

function notify(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => els.toast.classList.remove('show'), 2400);
}

function labelSortKey(label) {
  const m = label.match(/^(\d+)/);
  return m ? [0, parseInt(m[1], 10), label] : [1, 0, label];
}

function compareLabels(a, b) {
  const ka = labelSortKey(a), kb = labelSortKey(b);
  if (ka[0] !== kb[0]) return ka[0] - kb[0];
  if (ka[1] !== kb[1]) return ka[1] - kb[1];
  return ka[2].localeCompare(kb[2]);
}

// ---------- IndexedDB: フォルダハンドルの永続化 ----------
const DB_NAME = 'shisu-viewer';
const STORE = 'handles';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, val) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------- ZIP読み込み（依存ライブラリなし、DecompressionStreamを利用） ----------
async function readZipEntries(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // End Of Central Directory を末尾から探索
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65536); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) throw new Error('ZIPの終端レコードが見つかりません');

  const entryCount = view.getUint16(eocdOffset + 10, true);
  let cdOffset = view.getUint32(eocdOffset + 16, true);

  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(cdOffset, true) !== 0x02014b50) break;
    const compressionMethod = view.getUint16(cdOffset + 10, true);
    const compressedSize = view.getUint32(cdOffset + 20, true);
    const nameLen = view.getUint16(cdOffset + 28, true);
    const extraLen = view.getUint16(cdOffset + 30, true);
    const commentLen = view.getUint16(cdOffset + 32, true);
    const localHeaderOffset = view.getUint32(cdOffset + 42, true);
    const nameBytes = bytes.subarray(cdOffset + 46, cdOffset + 46 + nameLen);
    const name = new TextDecoder('utf-8').decode(nameBytes);

    entries.push({ name, compressionMethod, compressedSize, localHeaderOffset });
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }

  const results = [];
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue; // ディレクトリ
    const lh = entry.localHeaderOffset;
    if (view.getUint32(lh, true) !== 0x04034b50) continue;
    const lNameLen = view.getUint16(lh + 26, true);
    const lExtraLen = view.getUint16(lh + 28, true);
    const dataStart = lh + 30 + lNameLen + lExtraLen;
    const compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize);

    let outBytes;
    if (entry.compressionMethod === 0) {
      outBytes = compressed;
    } else if (entry.compressionMethod === 8) {
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([compressed]).stream().pipeThrough(ds);
      outBytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } else {
      continue; // 未対応の圧縮方式はスキップ
    }
    results.push({ name: entry.name, text: decodeCsv(outBytes.buffer) });
  }
  return results;
}

function decodeCsv(buffer) {
  const utf8 = new TextDecoder('utf-8').decode(buffer);
  const bad = (utf8.match(/�/g) || []).length;
  return bad ? new TextDecoder('shift_jis').decode(buffer) : utf8;
}

// ---------- CSVパース＆ID分解 ----------
// ラベル+日付.csv（例: 1tua20260808.csv）か、日付のみ.csv（例: 厩舎Finish-Up/20260808.csv、
// この場合は親フォルダ名をラベルとして使う）のどちらにも対応する。
const FILE_NAME_RE = /^([A-Za-z0-9]*)(\d{8})\.csv$/i;

// 馬名対応ファイル(例: name20260808.csv)のラベル名。中身は "18桁ID,馬名" で、指数と違い数値ではなく文字列。
const NAME_LABEL = 'name';

function decodeKey(id18) {
  return {
    date: id18.slice(0, 8),
    placeCode: id18.slice(8, 10),
    kai: id18.slice(10, 12),
    day: id18.slice(12, 14),
    race: parseInt(id18.slice(14, 16), 10),
    uma: parseInt(id18.slice(16, 18), 10),
  };
}

function processCsvEntry(filename, text, folderLabel) {
  const base = filename.split('/').pop();
  const m = base.match(FILE_NAME_RE);
  if (!m) return 0;
  const label = m[1] || folderLabel;
  if (!label) return 0;
  const isNameFile = label.toLowerCase() === NAME_LABEL;
  let count = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.includes('\t') ? line.split('\t') : line.split(',');
    if (parts.length < 2) continue;
    const id = parts[0].trim();
    if (id.length !== 18 || !/^\d{18}$/.test(id)) continue;

    const { date, placeCode, kai, day, race, uma } = decodeKey(id);
    const key = `${date}|${placeCode}|${race}|${uma}`;
    let rec = state.records.get(key);
    if (!rec) {
      rec = { date, placeCode, kai, day, race, uma, scores: {}, ranks: {} };
      state.records.set(key, rec);
    }

    if (isNameFile) {
      rec.name = parts.slice(1).join(',').trim();
      count++;
      continue;
    }

    const score = Number(parts[1].trim());
    if (Number.isNaN(score)) continue;
    rec.scores[label] = score;
    state.labels.add(label);
    count++;
  }
  return count;
}

function finalizeRecords() {
  const groups = new Map();
  for (const rec of state.records.values()) {
    const gKey = `${rec.date}|${rec.placeCode}|${rec.race}`;
    if (!groups.has(gKey)) groups.set(gKey, []);
    groups.get(gKey).push(rec);
  }
  for (const group of groups.values()) {
    for (const label of state.labels) {
      if (NO_RANK_LABELS.has(label)) continue;
      const ascending = ASCENDING_LABELS.has(label);
      const withScore = group.filter((r) => r.scores[label] !== undefined);
      withScore.sort((a, b) => ascending
        ? a.scores[label] - b.scores[label]
        : b.scores[label] - a.scores[label]);
      let rank = 0, prevScore = null, seen = 0;
      for (const r of withScore) {
        seen++;
        if (r.scores[label] !== prevScore) { rank = seen; prevScore = r.scores[label]; }
        r.ranks[label] = rank;
      }
    }
  }
}

// ---------- フォルダ走査 ----------
async function collectFilesFromHandle(dirHandle, out, depth = 0, folderLabel = '') {
  if (depth > 5) return;
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'file') {
      if (/\.zip$/i.test(name)) out.push({ name, kind: 'zip', handle, folderLabel });
      else if (/\.csv$/i.test(name)) out.push({ name, kind: 'csv', handle, folderLabel });
    } else if (handle.kind === 'directory') {
      await collectFilesFromHandle(handle, out, depth + 1, name);
    }
  }
}

async function processFileList(files) {
  let csvCount = 0, fileCount = 0;
  for (const f of files) {
    const arrayBuffer = await f.arrayBuffer();
    const folderLabel = f.folderLabel || (f.webkitRelativePath || '').split('/').slice(-2, -1)[0] || '';
    if (/\.zip$/i.test(f.name)) {
      const entries = await readZipEntries(arrayBuffer);
      for (const entry of entries) {
        if (processCsvEntry(entry.name, entry.text, folderLabel) > 0) fileCount++;
      }
    } else if (/\.csv$/i.test(f.name)) {
      const text = decodeCsv(arrayBuffer);
      if (processCsvEntry(f.name, text, folderLabel) > 0) fileCount++;
    }
    csvCount++;
  }
  return { csvCount, fileCount };
}

async function loadFromDirectoryHandle(dirHandle) {
  const collected = [];
  await collectFilesFromHandle(dirHandle, collected);
  const files = [];
  for (const item of collected) {
    const file = await item.handle.getFile();
    file.folderLabel = item.folderLabel;
    files.push(file);
  }
  return processFileList(files);
}

// ---------- 読み込みボタン ----------
async function handleLoadClick() {
  const supportsFsAccess = typeof window.showDirectoryPicker === 'function';
  try {
    state.records.clear();
    state.labels.clear();

    if (supportsFsAccess) {
      let dirHandle = await idbGet('rootDir').catch(() => null);
      if (dirHandle) {
        const perm = await dirHandle.queryPermission({ mode: 'read' });
        if (perm !== 'granted') {
          const req = await dirHandle.requestPermission({ mode: 'read' });
          if (req !== 'granted') dirHandle = null;
        }
      }
      if (!dirHandle) {
        dirHandle = await window.showDirectoryPicker();
        await idbSet('rootDir', dirHandle);
      }
      state.rootName = dirHandle.name;
      const result = await loadFromDirectoryHandle(dirHandle);
      afterLoad(result);
    } else {
      els.fallbackInput = els.fallbackInput || createFallbackInput();
      els.fallbackInput.click();
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    notify(err.message || '読み込みに失敗しました');
  }
}

function createFallbackInput() {
  const input = document.createElement('input');
  input.type = 'file';
  input.webkitdirectory = true;
  input.multiple = true;
  input.style.display = 'none';
  input.addEventListener('change', async () => {
    state.records.clear();
    state.labels.clear();
    state.rootName = 'フォルダ選択';
    const result = await processFileList(Array.from(input.files));
    afterLoad(result);
    input.value = '';
  });
  document.body.appendChild(input);
  return input;
}

function afterLoad({ fileCount }) {
  finalizeRecords();
  state.loadedAt = new Date();
  els.loadStatus.textContent = `${state.rootName} / ${fileCount}ファイル読込 / ${new Date().toLocaleTimeString('ja-JP')}`;
  if (state.records.size === 0) {
    notify('指数CSVが見つかりませんでした（ファイル名の形式をご確認ください）');
    return;
  }
  els.empty.hidden = true;
  els.dashboard.hidden = false;
  // 指数の種類が多いため、既定では何も表示せず「指数を選択」から選んでもらう
  state.hiddenLabels = new Set(state.labels);
  populateFilterOptions();
  renderColumnMenu();
  renderTable();
  notify(`${fileCount}件のファイルを読み込みました`);
}

// ---------- フィルタUI ----------
function formatDate(d) {
  return `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}`;
}

function populateFilterOptions() {
  const dates = [...new Set([...state.records.values()].map((r) => r.date))].sort();
  els.dateSelect.innerHTML = dates.map((d) => `<option value="${d}">${formatDate(d)}</option>`).join('');
  state.filters.date = dates[dates.length - 1] || '';
  els.dateSelect.value = state.filters.date;
  updatePlaceOptions();

  const years = [...new Set(dates.map((d) => d.slice(0, 4)))].sort().reverse();
  els.yearExportSelect.innerHTML = years.map((y) => `<option value="${y}">${y}年</option>`).join('');
}

function updatePlaceOptions() {
  const places = [...new Set([...state.records.values()]
    .filter((r) => r.date === state.filters.date)
    .map((r) => r.placeCode))].sort();
  els.placeSelect.innerHTML = places
    .map((p) => `<option value="${p}">${PLACE_NAMES[p] || p}</option>`)
    .join('');
  state.filters.place = places[0] || '';
  els.placeSelect.value = state.filters.place;
  updateRaceOptions();
}

function updateRaceOptions() {
  const races = [...new Set([...state.records.values()]
    .filter((r) => r.date === state.filters.date && r.placeCode === state.filters.place)
    .map((r) => r.race))].sort((a, b) => a - b);
  els.raceSelect.innerHTML = '<option value="">すべて</option>' +
    races.map((r) => `<option value="${r}">${r}R</option>`).join('');
  state.filters.race = '';
  els.raceSelect.value = '';
}

function renderColumnMenu() {
  const labels = [...state.labels].sort(compareLabels);
  els.columnMenu.innerHTML = `
    <div class="menu-actions">
      <button data-action="all">すべて選択</button>
      <button data-action="none">選択解除</button>
    </div>
    ${labels.map((l) => `
      <label><input type="checkbox" data-label="${l}" ${state.hiddenLabels.has(l) ? '' : 'checked'} /> ${labelDisplayName(l)}</label>
    `).join('')}
  `;
  updateColumnCount();
}

function updateColumnCount() {
  const total = state.labels.size;
  const shown = total - state.hiddenLabels.size;
  els.columnCount.textContent = `${shown}/${total}`;
}

// ---------- テーブル描画 ----------
function getVisibleRows() {
  let rows = [...state.records.values()].filter((r) => r.date === state.filters.date && r.placeCode === state.filters.place);
  if (state.filters.race) rows = rows.filter((r) => r.race === Number(state.filters.race));
  if (state.search.trim()) {
    const q = state.search.trim().toLowerCase();
    rows = rows.filter((r) => {
      if (String(r.uma).includes(q) || String(r.race).includes(q)) return true;
      if (r.name && r.name.toLowerCase().includes(q)) return true;
      for (const label of state.labels) {
        if (state.hiddenLabels.has(label)) continue;
        const v = r.scores[label];
        if (v !== undefined && String(v).includes(q)) return true;
      }
      return false;
    });
  }
  const sort = state.sort;
  rows.sort((a, b) => {
    if (sort) {
      const va = sortValue(a, sort.key), vb = sortValue(b, sort.key);
      if (va !== vb) return sort.dir * (va < vb ? -1 : 1);
    }
    if (a.race !== b.race) return a.race - b.race;
    return a.uma - b.uma;
  });
  return rows;
}

function sortValue(rec, key) {
  if (key === 'race') return rec.race;
  if (key === 'uma') return rec.uma;
  if (key === 'name') return rec.name || '';
  const [label, kind] = key.split('::');
  const src = kind === 'rank' ? rec.ranks : rec.scores;
  const v = src[label];
  return v === undefined ? -Infinity : v;
}

function visibleLabels() {
  return [...state.labels].sort(compareLabels).filter((l) => !state.hiddenLabels.has(l));
}

function rankClass(rank) {
  return rank === 1 ? 'rank-1' : rank === 2 ? 'rank-2' : rank === 3 ? 'rank-3' : '';
}

function renderTable() {
  const rows = getVisibleRows();
  const labels = visibleLabels();
  const mode = state.mode;

  const hasNames = rows.some((r) => r.name !== undefined);

  const columns = [
    { key: 'race', title: 'R', cls: 'col-num' },
    { key: 'uma', title: '馬番', cls: 'col-num' },
  ];
  if (hasNames) columns.push({ key: 'name', title: '馬名', cls: 'col-label' });
  for (const label of labels) {
    const name = labelDisplayName(label);
    if (NO_RANK_LABELS.has(label)) {
      columns.push({ key: `${label}::value`, title: name, cls: 'col-num col-rank' });
      continue;
    }
    if (mode !== 'rank') columns.push({ key: `${label}::value`, title: `${name} 値`, cls: 'col-num' });
    if (mode !== 'value') columns.push({ key: `${label}::rank`, title: '順', titleAttr: `${name} 順位`, cls: 'col-num col-rank' });
  }

  const thead = `<thead><tr>${columns.map((c) => {
    const active = state.sort && state.sort.key === c.key;
    const arrow = active ? (state.sort.dir === 1 ? '▲' : '▼') : '';
    const titleAttr = c.titleAttr ? ` title="${c.titleAttr}"` : '';
    return `<th data-key="${c.key}" class="${c.cls}"${titleAttr}>${c.title}<span class="sort-indicator">${arrow}</span></th>`;
  }).join('')}</tr></thead>`;

  const tbody = `<tbody>${rows.map((r) => {
    const cells = [
      `<td class="col-num">${r.race}</td>`,
      `<td class="col-num">${r.uma}</td>`,
    ];
    if (hasNames) cells.push(`<td class="col-label">${r.name || ''}</td>`);
    for (const label of labels) {
      const value = r.scores[label];
      if (NO_RANK_LABELS.has(label)) {
        const rankCls = rankClass(value);
        cells.push(`<td class="col-num col-rank ${rankCls}">${value !== undefined ? value : ''}</td>`);
        continue;
      }
      const rank = r.ranks[label];
      const rankCls = rankClass(rank);
      if (mode !== 'rank') cells.push(`<td class="col-num ${rankCls}">${value !== undefined ? value : ''}</td>`);
      if (mode !== 'value') cells.push(`<td class="col-num col-rank ${rankCls}">${rank !== undefined ? rank : ''}</td>`);
    }
    return `<tr>${cells.join('')}</tr>`;
  }).join('')}</tbody>`;

  els.table.innerHTML = thead + tbody;
  els.tableEmpty.hidden = rows.length > 0;

  const placeLabel = PLACE_NAMES[state.filters.place] || state.filters.place;
  const raceCount = new Set(rows.map((r) => r.race)).size;
  const nameCount = rows.filter((r) => r.name).length;
  els.stats.innerHTML = `
    <span>対象日: <b>${state.filters.date ? formatDate(state.filters.date) : '-'}</b></span>
    <span>場所: <b>${placeLabel || '-'}</b></span>
    <span>レース数: <b>${raceCount}</b></span>
    <span>頭数: <b>${rows.length}</b></span>
    <span>指数種別: <b>${labels.length}</b></span>
    ${hasNames ? `<span>馬名: <b>${nameCount}/${rows.length}</b></span>` : ''}
  `;
}

function buildCsvLines(rows, labels, mode, { includeDate } = {}) {
  const hasNames = rows.some((r) => r.name !== undefined);
  const header = [];
  if (includeDate) header.push('日付');
  header.push('場所', 'R', '馬番');
  if (hasNames) header.push('馬名');
  for (const label of labels) {
    const name = labelDisplayName(label);
    if (NO_RANK_LABELS.has(label)) { header.push(name); continue; }
    if (mode !== 'rank') header.push(`${name}_値`);
    if (mode !== 'value') header.push(`${name}_順位`);
  }
  const lines = [header.join(',')];
  for (const r of rows) {
    const cols = [];
    if (includeDate) cols.push(formatDate(r.date));
    cols.push(PLACE_NAMES[r.placeCode] || r.placeCode, r.race, r.uma);
    if (hasNames) cols.push(r.name || '');
    for (const label of labels) {
      if (NO_RANK_LABELS.has(label)) { cols.push(r.scores[label] !== undefined ? r.scores[label] : ''); continue; }
      if (mode !== 'rank') cols.push(r.scores[label] !== undefined ? r.scores[label] : '');
      if (mode !== 'value') cols.push(r.ranks[label] !== undefined ? r.ranks[label] : '');
    }
    lines.push(cols.join(','));
  }
  return lines;
}

function downloadCsv(lines, filename) {
  const csv = '﻿' + lines.join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

// 書き出し用の指数一覧。画面で1つも選んでいないときは全指数を出す
// （既定が未選択のため、そのままだと指数の入っていないCSVになってしまうため）
function exportLabels() {
  const selected = visibleLabels();
  return selected.length ? selected : [...state.labels].sort(compareLabels);
}

function exportCsv() {
  const rows = getVisibleRows();
  const lines = buildCsvLines(rows, exportLabels(), state.mode);
  const placeLabel = PLACE_NAMES[state.filters.place] || state.filters.place;
  downloadCsv(lines, `指数_${state.filters.date}_${placeLabel}.csv`);
}

function exportYearCsv() {
  const year = els.yearExportSelect.value;
  if (!year) { notify('出力できる年がありません'); return; }
  const rows = [...state.records.values()].filter((r) => r.date.startsWith(year));
  rows.sort((a, b) => (a.date !== b.date ? a.date.localeCompare(b.date)
    : a.placeCode !== b.placeCode ? a.placeCode.localeCompare(b.placeCode)
    : a.race !== b.race ? a.race - b.race : a.uma - b.uma));
  const labels = exportLabels();
  const lines = buildCsvLines(rows, labels, state.mode, { includeDate: true });
  downloadCsv(lines, `指数_${year}年.csv`);
  notify(`${year}年分（${rows.length}頭 / 指数${labels.length}種）を書き出しました`);
}

// ---------- イベント ----------
els.loadButton.addEventListener('click', handleLoadClick);

els.dateSelect.addEventListener('change', () => {
  state.filters.date = els.dateSelect.value;
  updatePlaceOptions();
  renderTable();
});
els.placeSelect.addEventListener('change', () => {
  state.filters.place = els.placeSelect.value;
  updateRaceOptions();
  renderTable();
});
els.raceSelect.addEventListener('change', () => {
  state.filters.race = els.raceSelect.value;
  renderTable();
});
els.modeSelect.addEventListener('change', () => {
  state.mode = els.modeSelect.value;
  renderTable();
});
els.searchInput.addEventListener('input', () => {
  state.search = els.searchInput.value;
  renderTable();
});
els.exportButton.addEventListener('click', exportCsv);
els.yearExportButton.addEventListener('click', exportYearCsv);

els.columnButton.addEventListener('click', () => {
  els.columnMenu.hidden = !els.columnMenu.hidden;
});
document.addEventListener('click', (e) => {
  if (!els.columnMenu.hidden && !els.columnMenu.contains(e.target) && e.target !== els.columnButton) {
    els.columnMenu.hidden = true;
  }
});
els.columnMenu.addEventListener('click', (e) => {
  const action = e.target.dataset.action;
  if (action === 'all') { state.hiddenLabels.clear(); renderColumnMenu(); renderTable(); }
  if (action === 'none') { state.hiddenLabels = new Set(state.labels); renderColumnMenu(); renderTable(); }
});
els.columnMenu.addEventListener('change', (e) => {
  const label = e.target.dataset.label;
  if (!label) return;
  if (e.target.checked) state.hiddenLabels.delete(label);
  else state.hiddenLabels.add(label);
  updateColumnCount();
  renderTable();
});

els.table.addEventListener('click', (e) => {
  const th = e.target.closest('th');
  if (!th) return;
  const key = th.dataset.key;
  if (state.sort && state.sort.key === key) {
    state.sort.dir *= -1;
  } else {
    state.sort = { key, dir: 1 };
  }
  renderTable();
});
