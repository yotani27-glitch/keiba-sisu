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

// ---------- 優先指数 ----------
// 2022-2026年の15,414レース・211,848頭を条件付きロジットで学習して決めた重み。
// 効かないと確認できた指数（坂路血統・持ち時計血統・コース連動・血統連動・
// バランス・坂路調教）は、5年間ずっと1位馬の勝率がランダム基準7.3%と
// 区別できなかったため入れていない。混ぜるとむしろ精度が落ちる。
const PRIORITY_WEIGHTS = {
  '7tua': 4,    // Ｆ指数 — 能力の本線。単独1位馬の勝率24.1%
  '6tua': 3,    // Ｓ指数 — 先行力の代理。3位内の49.5%が最終角3番手以内
  '11tua': 2,   // arms指数２
  '00tua': 2,   // LVL2
  '厩舎Finish-Up': 2,
};
const PRIORITY_LABEL = '優先指数';
// Ｆ指数とＳ指数だけは欠かせない（重みの6割強を占めるため）
const PRIORITY_REQUIRED = ['7tua', '6tua'];

// レース内で 1位=1.0 / 最下位=0.0 になるよう順位を正規化する
function normalizedRankScore(rank, fieldSize) {
  if (!rank || fieldSize < 2) return null;
  return 1 - (rank - 1) / (fieldSize - 1);
}

function labelDisplayName(label) {
  return LABEL_NAMES[label] || label;
}

const state = {
  records: new Map(),   // key: date|placeCode|race|uma -> record
  labels: new Set(),    // 指数ラベル一覧 (例: '00','1',...,'11','gallop','GYN')
  hiddenLabels: new Set(),
  knownLabels: new Set(), // 前回の読み込み時点で存在したラベル
  loadedAt: null,
  rootName: '',
  filters: { date: '', place: '', race: '' },
  mode: 'both',
  search: '',
  sort: null, // { key, dir }
  races: [],  // レース単位のサマリ（優先指数・堅さ判定）
  raceFilters: { date: '', place: '', firmness: '' },
  view: 'races',
  popular: new Map(), // レースキー -> [人気1位の馬番, 人気2位の馬番]
};

const $ = (sel) => document.querySelector(sel);
const els = {
  loadButton: $('#loadButton'),
  fileButton: $('#fileButton'),
  kyushaButton: $('#kyushaButton'),
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
  tabRaces: $('#tabRaces'),
  tabTable: $('#tabTable'),
  raceView: $('#raceView'),
  tableView: $('#tableView'),
  raceDateSelect: $('#raceDateSelect'),
  racePlaceSelect: $('#racePlaceSelect'),
  firmnessSelect: $('#firmnessSelect'),
  raceSummary: $('#raceSummary'),
  raceList: $('#raceList'),
  raceEmpty: $('#raceEmpty'),
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

// ラベルが決められなかったCSVの本数。iPhoneでファイルを個別に選ぶと
// フォルダ名が取れず、厩舎Finish-Upのような「日付だけのファイル名」は
// 指数名が分からなくなる。読み飛ばした件数を伝えるために数えておく。
let skippedUnlabeled = 0;

function processCsvEntry(filename, text, folderLabel) {
  const base = filename.split('/').pop();
  const m = base.match(FILE_NAME_RE);
  if (!m) return 0;
  const label = m[1] || folderLabel;
  if (!label) { skippedUnlabeled++; return 0; }
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
    computePriorityForRace(group);
  }
}

// レース1つ分の優先指数を計算する。
// そのレースの全馬に順位が揃っている指数だけを使い、重みをその分だけ再正規化する
// （レース内で比較さえできれば順位付けは成立するため）。これにより厩舎Finish-Upや
// LVL2が無い期間でも、残りの指数だけで計算できる。
function computePriorityForRace(group) {
  const fieldSize = group.length;
  const usable = [];
  for (const [label, weight] of Object.entries(PRIORITY_WEIGHTS)) {
    const allHaveRank = group.every((r) => r.ranks[label] !== undefined);
    if (allHaveRank) usable.push([label, weight]);
  }
  const hasRequired = PRIORITY_REQUIRED.every((l) => usable.some(([lb]) => lb === l));
  if (!hasRequired || fieldSize < 2) {
    for (const r of group) { delete r.priority; delete r.priorityRank; delete r.priorityBasis; }
    return;
  }

  const totalWeight = usable.reduce((s, [, w]) => s + w, 0);
  for (const rec of group) {
    let sum = 0;
    for (const [label, weight] of usable) {
      sum += weight * normalizedRankScore(rec.ranks[label], fieldSize);
    }
    rec.priority = sum / totalWeight;
    rec.priorityBasis = usable.length;
  }

  const sorted = [...group].sort((a, b) => b.priority - a.priority);
  sorted.forEach((r, i) => { r.priorityRank = i + 1; });
}

// ---------- 1位と2位のスコア差 ----------
// 優先指数は順位だけでなく数値の大きさにも情報がある。1位が2位をどれだけ
// 離しているかで、1位馬の勝率が2022-2026年の15,367レースで以下のように動く。
//   差0.042未満 20.8% / 0.042〜0.115 26.5% / 0.115以上 32.7%
const GAP_BANDS = [
  { min: 0.115, key: 'clear', label: '抜けている', winRate: 32.7 },
  { min: 0.042, key: 'mid', label: '標準', winRate: 26.5 },
  { min: -Infinity, key: 'close', label: '横並び', winRate: 20.8 },
];

function gapBand(gap) {
  return GAP_BANDS.find((b) => gap >= b.min);
}

// ---------- カードに並べる内訳指数 ----------
// 表示順。ラベルは短くしないと横に収まらない
const BREAKDOWN = [
  ['7tua', 'F'],
  ['6tua', 'S'],
  ['11tua', 'ar'],
  ['厩舎Finish-Up', '厩'],
];

const BREAKDOWN_TITLES = Object.fromEntries(
  BREAKDOWN.map(([label]) => [label, LABEL_NAMES[label] || label]));

// 値と、そのレース内での順位を並べて出す。1〜3位は既存の表と同じ色を付ける
function breakdownHtml(rec) {
  const chips = [];
  for (const [label, short] of BREAKDOWN) {
    const val = rec.scores[label];
    if (val === undefined) continue;
    const rank = rec.ranks[label];
    const cls = rank >= 1 && rank <= 3 ? ` r${rank}` : '';
    // 値と順位が数字として続くと読めないので、順位はカッコで包む
    chips.push(
      `<span class="ix${cls}" title="${BREAKDOWN_TITLES[label]} 値${val}${rank ? ` / ${rank}位` : ''}">`
      + `<i>${short}</i>${val}` + (rank ? `<b>(${rank})</b>` : '') + '</span>');
  }
  return chips.length ? `<div class="breakdown">${chips.join('')}</div>` : '';
}

// ---------- 堅さ判定 ----------
// 優先指数の上位2頭と、予想人気(GYN)の上位2頭が何頭重なるかで3段階に分ける。
// 2026年1,973レースでの実測（優先1位馬の勝率）:
//   一致2頭 30.1% / 一致1頭 24.6% / 一致0頭 17.1%
// 確定オッズを使えば分離はもっと鋭くなる（33.7% / 23.5% / 11.1%）が、
// GYNはレース前に分かるという利点がある。
const FIRMNESS = {
  2: { key: 'solid', label: '堅そう', winRate: 30.1, place: 66.0 },
  1: { key: 'normal', label: '標準', winRate: 24.6, place: 54.6 },
  0: { key: 'rough', label: '荒れそう', winRate: 17.1, place: 45.2 },
};

// 当日の確定人気を入れた場合の実測値。2022-2026年の15,367レースで、
// GYN基準(上)より分離が鋭い。レース当日はこちらを使う。
const FIRMNESS_ODDS = {
  2: { key: 'solid', label: '堅そう', winRate: 31.9, place: 64.9 },
  1: { key: 'normal', label: '標準', winRate: 24.8, place: 55.0 },
  0: { key: 'rough', label: '荒れそう', winRate: 11.0, place: 35.1 },
};

// 当日入力した人気上位2頭。レース単位で localStorage に残す
const POPULAR_STORE = 'keiba-popular-v1';

function loadPopular() {
  try {
    return new Map(Object.entries(JSON.parse(localStorage.getItem(POPULAR_STORE) || '{}')));
  } catch { return new Map(); }
}

function savePopular() {
  try {
    localStorage.setItem(POPULAR_STORE, JSON.stringify(Object.fromEntries(state.popular)));
  } catch { /* 保存できなくても表示は続行する */ }
}

// 読み込み済みレコードから、レース単位のサマリを作る
function buildRaceSummaries() {
  const groups = new Map();
  for (const rec of state.records.values()) {
    if (rec.priorityRank === undefined) continue;
    const gKey = `${rec.date}|${rec.placeCode}|${rec.race}`;
    if (!groups.has(gKey)) groups.set(gKey, []);
    groups.get(gKey).push(rec);
  }

  const races = [];
  for (const [gKey, group] of groups) {
    const [date, placeCode, race] = gKey.split('|');
    const byPriority = [...group].sort((a, b) => a.priorityRank - b.priorityRank);
    const hasGyn = group.every((r) => r.scores['GYN'] !== undefined);

    let agree = null;
    if (hasGyn) {
      const topPriority = new Set(byPriority.slice(0, 2).map((r) => r.uma));
      const topGyn = [...group]
        .sort((a, b) => a.scores['GYN'] - b.scores['GYN'])
        .slice(0, 2)
        .map((r) => r.uma);
      agree = topGyn.filter((u) => topPriority.has(u)).length;
    }

    // 当日の確定人気を入れてあれば、そちらを優先して判定し直す
    const topPriority = new Set(byPriority.slice(0, 2).map((r) => r.uma));
    const entered = state.popular.get(gKey);
    let agreeOdds = null;
    if (Array.isArray(entered) && entered.length === 2) {
      agreeOdds = entered.filter((u) => topPriority.has(u)).length;
    }

    races.push({
      key: gKey,
      date,
      placeCode,
      place: PLACE_NAMES[placeCode] || placeCode,
      race: Number(race),
      fieldSize: group.length,
      top: byPriority.slice(0, 5),
      // カードには全頭を馬番順で並べる（出馬表やオッズ画面と突き合わせやすい）
      byUma: [...group].sort((a, b) => a.uma - b.uma),
      all: byPriority,
      gap: byPriority.length >= 2 ? byPriority[0].priority - byPriority[1].priority : null,
      gapBand: byPriority.length >= 2
        ? gapBand(byPriority[0].priority - byPriority[1].priority) : null,
      agree,
      agreeOdds,
      popular: entered || null,
      firmness: agreeOdds !== null ? FIRMNESS_ODDS[agreeOdds]
        : (agree === null ? null : FIRMNESS[agree]),
      byOdds: agreeOdds !== null,
      basis: byPriority[0].priorityBasis,
    });
  }

  races.sort((a, b) => a.date.localeCompare(b.date)
    || a.placeCode.localeCompare(b.placeCode)
    || a.race - b.race);
  return races;
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

async function processFileList(files, forcedLabel = '') {
  let csvCount = 0, fileCount = 0;
  for (const f of files) {
    const arrayBuffer = await f.arrayBuffer();
    const folderLabel = forcedLabel || f.folderLabel
      || (f.webkitRelativePath || '').split('/').slice(-2, -1)[0] || '';
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

// ---------- ファイル単体選択（iPhone/iPad用） ----------
// iOSはフォルダ選択に対応していない（showDirectoryPickerが無く、
// webkitdirectoryも効かない）ので、週次ZIPを1つ選ぶ経路を用意する。
// 追加読み込みできるよう、既存の記録は消さずに重ねる。
function createFilePicker(id, accept, forcedLabel, rootName) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.multiple = true;
  input.style.display = 'none';
  input.addEventListener('change', async () => {
    const files = Array.from(input.files);
    input.value = '';
    if (!files.length) return;
    try {
      skippedUnlabeled = 0;
      state.rootName = rootName;
      const result = await processFileList(files, forcedLabel);
      afterLoad(result);
      if (skippedUnlabeled > 0) {
        notify(`${skippedUnlabeled}件は指数名が判別できず読み飛ばしました（厩舎Finish-Upは専用ボタンから追加してください）`);
      }
    } catch (err) {
      notify(err.message || '読み込みに失敗しました');
    }
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
  const firstLoad = els.dashboard.hidden;
  els.empty.hidden = true;
  els.dashboard.hidden = false;
  if (firstLoad) {
    // 指数の種類が多いため、既定では何も表示せず「指数を選択」から選んでもらう
    state.hiddenLabels = new Set(state.labels);
  } else {
    // 追加読み込み（厩舎Finish-Upなど）では、それまでの表示設定を残す。
    // 新しく増えたラベルだけ非表示側に足す
    for (const l of state.labels) {
      if (!state.knownLabels.has(l)) state.hiddenLabels.add(l);
    }
  }
  state.knownLabels = new Set(state.labels);
  populateFilterOptions();
  renderColumnMenu();
  renderTable();
  state.races = buildRaceSummaries();
  populateRaceFilters();
  renderRaceList();

  // 馬名ファイル(name<日付>.csv)は別フォルダにあるため選び忘れやすい。
  // 馬番だけの表示になっていることに気づけるよう伝える
  const named = [...state.records.values()].filter((r) => r.name).length;
  if (named === 0) {
    notify(`${fileCount}件を読み込みました（馬名なし。name${firstLoadedDate()}.csv も一緒に選ぶと馬名が出ます）`);
  } else {
    notify(`${fileCount}件のファイルを読み込みました`);
  }
}

// 読み込んだ中でいちばん新しい日付。馬名ファイルの案内に使う
function firstLoadedDate() {
  let latest = '';
  for (const r of state.records.values()) {
    if (r.date > latest) latest = r.date;
  }
  return latest || 'YYYYMMDD';
}

// ---------- レース一覧（優先指数・堅さ判定） ----------
function populateRaceFilters() {
  const races = state.races || [];
  const dates = [...new Set(races.map((r) => r.date))].sort();
  els.raceDateSelect.innerHTML = '<option value="">すべての日付</option>'
    + dates.map((d) => `<option value="${d}">${formatDate(d)}</option>`).join('');
  if (dates.length) {
    // 既定は最新の日付だけ表示する（週次運用で使うため）
    els.raceDateSelect.value = dates[dates.length - 1];
    state.raceFilters.date = dates[dates.length - 1];
  }
  updateRacePlaceOptions();
}

function updateRacePlaceOptions() {
  const races = (state.races || []).filter((r) =>
    !state.raceFilters.date || r.date === state.raceFilters.date);
  const places = [...new Set(races.map((r) => r.place))];
  els.racePlaceSelect.innerHTML = '<option value="">すべての場所</option>'
    + places.map((p) => `<option value="${p}">${p}</option>`).join('');
  els.racePlaceSelect.value = places.includes(state.raceFilters.place)
    ? state.raceFilters.place : '';
  state.raceFilters.place = els.racePlaceSelect.value;
}

function getFilteredRaces() {
  const f = state.raceFilters;
  return (state.races || []).filter((r) => {
    if (f.date && r.date !== f.date) return false;
    if (f.place && r.place !== f.place) return false;
    if (f.firmness && (!r.firmness || r.firmness.key !== f.firmness)) return false;
    return true;
  });
}

function renderRaceList() {
  const races = getFilteredRaces();
  els.raceEmpty.hidden = races.length > 0;

  const counts = { solid: 0, normal: 0, rough: 0, unknown: 0 };
  for (const r of races) {
    if (r.firmness) counts[r.firmness.key]++; else counts.unknown++;
  }
  const noGyn = counts.unknown > 0
    ? `<span class="chip chip-unknown">判定不可 ${counts.unknown}</span>` : '';
  els.raceSummary.innerHTML = races.length === 0 ? '' : `
    <span class="chip chip-solid">堅そう ${counts.solid}</span>
    <span class="chip chip-normal">標準 ${counts.normal}</span>
    <span class="chip chip-rough">荒れそう ${counts.rough}</span>
    ${noGyn}
    <span class="chip-note">全${races.length}レース</span>
    <span class="chip-note legend">内訳: ${
      BREAKDOWN.map(([l, s]) => `<b>${s}</b>=${LABEL_NAMES[l] || l}`).join(' · ')
    }（値と順位）</span>`;

  els.raceList.innerHTML = races.map((r) => {
    const f = r.firmness;
    const src = r.byOdds ? '当日人気' : '予想人気';
    const badge = f
      ? `<span class="firmness ${f.key}">${f.label}<em>${src}基準 · 優先1位の勝率 ${f.winRate.toFixed(1)}%</em></span>`
      : `<span class="firmness unknown">判定不可<em>予想人気(GYN)なし</em></span>`;
    const pop = r.popular || [];
    // 馬番順に並べるので、優先順位はクラスで示す（先頭行＝1位ではなくなる）
    const horses = r.byUma.map((h) => `
      <li class="${h.priorityRank <= 2 ? `p${h.priorityRank}` : ''}${pop.includes(h.uma) ? ' is-popular' : ''}">
        <div class="hrow">
          <span class="prank">${h.priorityRank}</span>
          <span class="uma">${h.uma}番</span>
          <span class="hname">${h.name ? escapeHtml(h.name) : ''}</span>
          <span class="pscore" title="優先スコア">${h.priority.toFixed(3)}</span>
          ${h.scores['GYN'] !== undefined ? `<span class="gyn">予想${h.scores['GYN']}人気</span>` : ''}
        </div>
        ${breakdownHtml(h)}
      </li>`).join('');
    return `
      <article class="race-card ${f ? f.key : 'unknown'}${r.byOdds ? ' confirmed' : ''}">
        <header>
          <div class="rtitle">
            <strong>${formatDate(r.date)} ${r.place} ${r.race}R</strong>
            <span class="rmeta">${r.fieldSize}頭 / ${r.basis}指数${
              r.gapBand ? ` / <span class="gap ${r.gapBand.key}" title="1位と2位のスコア差 ${r.gap.toFixed(3)}。この帯の1位馬の勝率は${r.gapBand.winRate}%">1-2位差 ${r.gap.toFixed(3)}・${r.gapBand.label}</span>` : ''
            }</span>
          </div>
          ${badge}
        </header>
        <ol class="horses">${horses}</ol>
        <div class="popular-input" data-race="${r.key}">
          <label>当日の人気</label>
          <input type="number" inputmode="numeric" min="1" max="${r.fieldSize}"
                 data-slot="0" value="${pop[0] ?? ''}" placeholder="1番人気" aria-label="1番人気の馬番" />
          <input type="number" inputmode="numeric" min="1" max="${r.fieldSize}"
                 data-slot="1" value="${pop[1] ?? ''}" placeholder="2番人気" aria-label="2番人気の馬番" />
          <span class="unit">番</span>
          ${pop.length === 2 ? '<button type="button" class="clear-pop" aria-label="当日人気をクリア">×</button>' : ''}
        </div>
      </article>`;
  }).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

// iPhoneなどフォルダ選択が使えない環境向け。ファイルを直接選ぶ
els.fileButton.addEventListener('click', () => {
  els.filePicker = els.filePicker
    || createFilePicker('filePicker', '.zip,.csv', '', 'ファイル選択');
  els.filePicker.click();
});

// 厩舎Finish-Upは日付だけのファイル名なので、指数名を指定して読み込む
els.kyushaButton.addEventListener('click', () => {
  els.kyushaPicker = els.kyushaPicker
    || createFilePicker('kyushaPicker', '.csv,.zip', '厩舎Finish-Up', '厩舎Finish-Up追加');
  els.kyushaPicker.click();
});

// フォルダ選択が使えない環境では、そちらのボタンを目立たせない
if (typeof window.showDirectoryPicker !== 'function') {
  els.loadButton.classList.remove('primary');
  els.fileButton.classList.add('primary');
}

function switchView(view) {
  state.view = view;
  const isRaces = view === 'races';
  els.raceView.hidden = !isRaces;
  els.tableView.hidden = isRaces;
  els.tabRaces.classList.toggle('active', isRaces);
  els.tabTable.classList.toggle('active', !isRaces);
  els.tabRaces.setAttribute('aria-selected', String(isRaces));
  els.tabTable.setAttribute('aria-selected', String(!isRaces));
}
els.tabRaces.addEventListener('click', () => switchView('races'));
els.tabTable.addEventListener('click', () => switchView('table'));

els.raceDateSelect.addEventListener('change', () => {
  state.raceFilters.date = els.raceDateSelect.value;
  updateRacePlaceOptions();
  renderRaceList();
});
els.racePlaceSelect.addEventListener('change', () => {
  state.raceFilters.place = els.racePlaceSelect.value;
  renderRaceList();
});
els.firmnessSelect.addEventListener('change', () => {
  state.raceFilters.firmness = els.firmnessSelect.value;
  renderRaceList();
});

// 当日の人気1位・2位の馬番を入れると、確定オッズ基準で判定し直す
els.raceList.addEventListener('change', (ev) => {
  const input = ev.target.closest('input[data-slot]');
  if (!input) return;
  const box = input.closest('.popular-input');
  const key = box.dataset.race;
  const nums = [...box.querySelectorAll('input[data-slot]')]
    .map((i) => Number(i.value))
    .filter((n) => Number.isInteger(n) && n > 0);

  // 2頭そろって、かつ別の馬のときだけ判定に使う
  const ready = nums.length === 2 && nums[0] !== nums[1];
  const had = state.popular.has(key);
  if (ready) {
    state.popular.set(key, nums);
  } else {
    state.popular.delete(key);
  }
  savePopular();

  // 1頭目を入れただけの段階で描画し直すと入力欄が作り直されて
  // フォーカスと入力中の値が飛ぶ。判定が変わるときだけ再描画する。
  if (!ready && !had) return;
  state.races = buildRaceSummaries();
  renderRaceList();
});

els.raceList.addEventListener('click', (ev) => {
  if (!ev.target.classList.contains('clear-pop')) return;
  state.popular.delete(ev.target.closest('.popular-input').dataset.race);
  savePopular();
  state.races = buildRaceSummaries();
  renderRaceList();
});

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

// 当日入力した人気は再読み込みしても残す
state.popular = loadPopular();
