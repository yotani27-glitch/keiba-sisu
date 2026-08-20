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

// ---------- 複勝優先指数 ----------
// 「3着以内」を目的変数にして2022-2026年の15,414レースを再分析した重み。
// 2025年で学習して2026年で未使用データ検証し、現行式より上位3頭の
// 3着内馬捕捉率が改善する方向だった。現行指数は置き換えず、比較用に併記する。
const PLACE_PRIORITY_WEIGHTS = {
  '7tua': 8,    // Ｆ指数
  '6tua': 5,    // Ｓ指数
  '11tua': 3,   // arms指数２
  '00tua': 3,   // LVL2
  '厩舎Finish-Up': 3,
};
const PLACE_PRIORITY_LABEL = '複勝優先指数';

// ダート1801m以上だけは通常と傾向が逆転する(2026-08-19分析)。
// 距離帯×芝ダで複勝相関を見ると、芝は距離が延びるほどＦ指数が優位になる一方、
// ダート1801m以上だけはＳ指数がＦ指数を上回る唯一の区分(前後半とも符号一致、
// F-S差の前後半相関0.955で高い再現性)。この区分に限りOLSで重みを再学習すると
// (2022-2024年学習→2025-2026年検証)、1位馬の複勝率が53.1%→58.1%(+5.0pt, n=358)
// に改善した。arms指数２はこの区分だけ回帰係数がマイナス(逆効き)だったため除外。
const PLACE_PRIORITY_WEIGHTS_DIRT_LONG = {
  '7tua': 6,    // Ｆ指数
  '6tua': 7,    // Ｓ指数 — この区分だけＦ指数を上回る
  '00tua': 3,   // LVL2
  '厩舎Finish-Up': 3,
  // arms指数２('11tua')はこの区分では回帰係数が負のため使わない
};
const DIRT_LONG_MIN_DISTANCE = 1801;

function isDirtLongDistance(surface, distance) {
  return surface === 'ダ' && Number.isFinite(distance) && distance >= DIRT_LONG_MIN_DISTANCE;
}

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
  postTimes: new Map(), // date|placeCode|race -> { time: "9:40", minutes: 580 }（発走時刻Excelから）
};

const $ = (sel) => document.querySelector(sel);
const els = {
  loadButton: $('#loadButton'),
  zipButton: $('#zipButton'),
  csvButton: $('#csvButton'),
  scheduleButton: $('#scheduleButton'),
  shareWriteButton: $('#shareWriteButton'),
  shareReadButton: $('#shareReadButton'),
  clearButton: $('#clearButton'),
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
  sharePopButton: $('#sharePopButton'),
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
// .xlsxもZIPコンテナなので、生バイトを返すこの関数を指数ZIP・出馬表xlsxの両方で使う。
async function readZipEntriesRaw(buffer) {
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
    results.push({ name: entry.name, bytes: outBytes });
  }
  return results;
}

async function readZipEntries(buffer) {
  const raw = await readZipEntriesRaw(buffer);
  return raw.map(({ name, bytes }) => ({ name, text: decodeCsv(bytes.buffer) }));
}

function decodeCsv(buffer) {
  const utf8 = new TextDecoder('utf-8').decode(buffer);
  const bad = (utf8.match(/�/g) || []).length;
  return bad ? new TextDecoder('shift_jis').decode(buffer) : utf8;
}

// ---------- 発走時刻Excel読み込み(「検討事項およびメモ」形式) ----------
// シート名が"YY.MM.DD"(例: 26.08.15)の日別シートだけを対象に、
// B列(競馬場)・C列(R)・D列(レース名)・E列(時間、1日を1とした小数のシリアル値)・
// F列(芝/ダ/障害)・G列(距離)を読み取る。レース単位のデータ(馬番を持たない)なので、
// 指数レコードとは別にstate.postTimesへ date|placeCode|race をキーとして保存し、
// buildRaceSummaries()で突き合わせる。
//
// 「該当」シート(A競馬場/B芝ダ/C距離/E狙い目コメント)も合わせて読み、
// 場+芝ダ+距離が一致する行があれば狙い目テキストを引く。I列の「狙い目」自体は
// VLOOKUP数式で、openpyxl書き出しのためキャッシュ値が空(<v></v>)になっており
// 直接は読めない。そのため該当シートを自前で読んで同じ突き合わせをする。
const PLACE_CODE_BY_NAME = Object.fromEntries(
  Object.entries(PLACE_NAMES).map(([code, name]) => [name, code])
);
const XLSX_RELS_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function xmlText(el) {
  const t = el && el.getElementsByTagName('t')[0];
  return t ? t.textContent : '';
}

function xmlValue(el) {
  const v = el && el.getElementsByTagName('v')[0];
  return v ? v.textContent : '';
}

function xlsxColOf(cell) {
  const ref = cell.getAttribute('r') || '';
  return (ref.match(/^[A-Z]+/) || [''])[0];
}

// 「該当」シートを読み、場+芝ダ+距離 -> 狙い目コメント のMapを作る
function readAimSheet(sheetDoc) {
  const map = new Map();
  for (const row of sheetDoc.getElementsByTagName('row')) {
    let place = '', surface = '', distance = '', aim = '';
    for (const cell of row.getElementsByTagName('c')) {
      const col = xlsxColOf(cell);
      if (col === 'A') place = xmlText(cell);
      else if (col === 'B') surface = xmlText(cell);
      else if (col === 'C') distance = xmlText(cell);
      else if (col === 'E') aim = xmlText(cell);
    }
    if (place && surface && distance && aim) {
      map.set(`${place}${surface}${distance}`, aim);
    }
  }
  return map;
}

async function processScheduleXlsx(buffer) {
  const raw = await readZipEntriesRaw(buffer);
  const byName = new Map(raw.map((e) => [e.name.replace(/^\/+/, ''), e.bytes]));
  const parser = new DOMParser();
  const parseXml = (bytes) => parser.parseFromString(new TextDecoder('utf-8').decode(bytes), 'application/xml');

  const workbookBytes = byName.get('xl/workbook.xml');
  const relsBytes = byName.get('xl/_rels/workbook.xml.rels');
  if (!workbookBytes || !relsBytes) throw new Error('xlsxの構造を読み取れませんでした（Excelファイルではない可能性があります）');

  const wbDoc = parseXml(workbookBytes);
  const relsDoc = parseXml(relsBytes);

  const targetById = new Map();
  for (const rel of relsDoc.getElementsByTagName('Relationship')) {
    targetById.set(rel.getAttribute('Id'), rel.getAttribute('Target').replace(/^\/+/, ''));
  }

  const sheetBytesByName = (sheetName) => {
    for (const sheet of wbDoc.getElementsByTagName('sheet')) {
      if (sheet.getAttribute('name') !== sheetName) continue;
      const rId = sheet.getAttribute('r:id') || sheet.getAttributeNS(XLSX_RELS_NS, 'id');
      const target = rId && targetById.get(rId);
      return target && byName.get(target);
    }
    return null;
  };

  const aimSheetBytes = sheetBytesByName('該当');
  const aimMap = aimSheetBytes ? readAimSheet(parseXml(aimSheetBytes)) : new Map();

  let count = 0;
  for (const sheet of wbDoc.getElementsByTagName('sheet')) {
    const name = sheet.getAttribute('name') || '';
    const m = name.match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
    if (!m) continue; // 日別シート(YY.MM.DD)以外(該当・期待度など)は無視
    const date8 = `20${m[1]}${m[2]}${m[3]}`;

    const rId = sheet.getAttribute('r:id') || sheet.getAttributeNS(XLSX_RELS_NS, 'id');
    const target = rId && targetById.get(rId);
    const sheetBytes = target && byName.get(target);
    if (!sheetBytes) continue;

    const sheetDoc = parseXml(sheetBytes);
    for (const row of sheetDoc.getElementsByTagName('row')) {
      let place = '', race = null, raceName = '', timeVal = null, courseType = '', distance = '';
      for (const cell of row.getElementsByTagName('c')) {
        const col = xlsxColOf(cell);
        if (col === 'B') place = xmlText(cell);
        else if (col === 'C') race = Number(xmlValue(cell));
        else if (col === 'D') raceName = xmlText(cell);
        else if (col === 'E') timeVal = Number(xmlValue(cell));
        else if (col === 'F') courseType = xmlText(cell);
        else if (col === 'G') distance = xmlText(cell);
      }
      const placeCode = PLACE_CODE_BY_NAME[place];
      if (!placeCode || !race || timeVal === null || Number.isNaN(timeVal) || Number.isNaN(race)) continue;
      const minutes = Math.round(timeVal * 1440);
      const hh = Math.floor(minutes / 60);
      const mm = minutes % 60;
      const time = `${hh}:${String(mm).padStart(2, '0')}`;
      const aim = (courseType && distance) ? aimMap.get(`${place}${courseType}${distance}`) || null : null;
      state.postTimes.set(`${date8}|${placeCode}|${race}`, {
        time, minutes, raceName, courseType, distance, aim,
      });
      count++;
    }
  }
  return count;
}

// ---------- CSVパース＆ID分解 ----------
// ラベル+日付.csv（例: 1tua20260808.csv）か、日付のみ.csv（例: 厩舎Finish-Up/20260808.csv、
// この場合は親フォルダ名をラベルとして使う）のどちらにも対応する。
const FILE_NAME_RE = /^([A-Za-z0-9]*)(\d{8})\.csv$/i;

// 馬名対応ファイル(例: name20260808.csv)のラベル名。中身は "18桁ID,馬名" で、指数と違い数値ではなく文字列。
const NAME_LABEL = 'name';

// TARGETの出馬表CSVで使われる場名1文字。新しい馬名ファイル形式
// 「札1,未勝利,...,1,...,馬名,...」を指数データの場コードへ結合するために使う。
const PLACE_SHORT_CODES = {
  '札': '01', '函': '02', '福': '03', '新': '04', '東': '05',
  '中': '06', '名': '07', '京': '08', '阪': '09', '小': '10',
};

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
  const fileDate = m[2];
  let count = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.includes('\t') ? line.split('\t') : line.split(',');
    if (parts.length < 2) continue;
    const id = parts[0].trim();

    // 新形式: 場名1文字+R、馬番は6列目、馬名は10列目。
    // 例: 札1,未勝利,ダ,1700,,1,,,,ジャストグレース,...
    if (isNameFile && !/^\d{18}$/.test(id)) {
      if (parts.length < 10) continue;
      const raceMatch = id.match(/^(.)(\d{1,2})$/);
      if (!raceMatch) continue;
      const placeCode = PLACE_SHORT_CODES[raceMatch[1]];
      const race = Number(raceMatch[2]);
      const uma = Number(parts[5].trim());
      const name = parts[9].trim();
      if (!placeCode || !race || !uma || !name) continue;
      const key = `${fileDate}|${placeCode}|${race}|${uma}`;
      let rec = state.records.get(key);
      if (!rec) {
        rec = { date: fileDate, placeCode, kai: '', day: '', race, uma, scores: {}, ranks: {} };
        state.records.set(key, rec);
      }
      rec.name = name;
      // 同じ行に芝/ダ(3列目)・距離(4列目)も入っているので、区分別重み調整に使う。
      const surface = parts[2].trim();
      const distance = Number(parts[3].trim());
      if (surface) rec.surface = surface;
      if (Number.isFinite(distance) && distance > 0) rec.distance = distance;
      count++;
      continue;
    }

    // 従来形式: 18桁ID,馬名
    if (id.length !== 18 || !/^\d{18}$/.test(id)) continue;

    const { date, placeCode, kai, day, race, uma } = decodeKey(id);
    const key = `${date}|${placeCode}|${race}|${uma}`;
    let rec = state.records.get(key);
    if (!rec) {
      rec = { date, placeCode, kai, day, race, uma, scores: {}, ranks: {} };
      state.records.set(key, rec);
    } else {
      // 新形式の馬名ファイルが指数ZIPより先に読まれた場合に開催情報を補完する。
      if (!rec.kai) rec.kai = kai;
      if (!rec.day) rec.day = day;
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
  computeWeightedIndexForRace(group, PRIORITY_WEIGHTS, {
    score: 'priority', rank: 'priorityRank', basis: 'priorityBasis',
  });

  // 芝/ダ・距離が分かっている(name<日付>.csvを読み込み済み)場合だけ、
  // ダート1801m以上に限りＳ指数優位の重みに切り替える。分からない時は従来通り。
  const withCourse = group.find((r) => r.surface && r.distance);
  const dirtLong = withCourse && isDirtLongDistance(withCourse.surface, withCourse.distance);
  const placeWeights = dirtLong ? PLACE_PRIORITY_WEIGHTS_DIRT_LONG : PLACE_PRIORITY_WEIGHTS;

  computeWeightedIndexForRace(group, placeWeights, {
    score: 'placePriority', rank: 'placePriorityRank', basis: 'placePriorityBasis',
  });
  for (const r of group) r.placePriorityDirtLong = !!dirtLong;
}

// 同じ計算規則で複数の合成指数を作れるようにした共通処理。
function computeWeightedIndexForRace(group, weights, fields) {
  const fieldSize = group.length;
  const usable = [];
  for (const [label, weight] of Object.entries(weights)) {
    const allHaveRank = group.every((r) => r.ranks[label] !== undefined);
    if (allHaveRank) usable.push([label, weight]);
  }
  const hasRequired = PRIORITY_REQUIRED.every((l) => usable.some(([lb]) => lb === l));
  if (!hasRequired || fieldSize < 2) {
    for (const r of group) {
      delete r[fields.score];
      delete r[fields.rank];
      delete r[fields.basis];
    }
    return;
  }

  const totalWeight = usable.reduce((s, [, w]) => s + w, 0);
  for (const rec of group) {
    let sum = 0;
    for (const [label, weight] of usable) {
      sum += weight * normalizedRankScore(rec.ranks[label], fieldSize);
    }
    rec[fields.score] = sum / totalWeight;
    rec[fields.basis] = usable.length;
  }

  const sorted = [...group].sort((a, b) => b[fields.score] - a[fields.score] || a.uma - b.uma);
  sorted.forEach((r, i) => { r[fields.rank] = i + 1; });
}

// ---------- 上位3頭の並び方（独走・半独走・2強・団子） ----------
// 1-2位差と2-3位差を組み合わせると、1-2位差だけより分離が良い。
// 2022-2026年・15,517レースの中央値（1-2位差0.056 / 2-3位差0.043）を境に
// 4通りに分けたときの優先1位馬の成績（2026-08-21再集計）:
//   独走(1-2位差も2-3位差も中央値以上) … 1頭が頭ひとつ抜けている 勝率30.5%/複勝60.9%
//   半独走(1-2位差は中央値以上・2-3位差は未満) … 1位だけ抜けているが2-3位は団子 勝率28.0%/複勝58.8%
//   2強(1-2位差は中央値未満・2-3位差は以上) … 上位2頭が拮抗し、3位以下から浮いている 勝率23.2%/複勝53.7%
//   団子(1-2位差も2-3位差も中央値未満) … 3頭以上が拮抗 勝率19.5%/複勝48.9%
// 半独走は独走に次ぐ好成績だが、2位馬自身の勝率は全パターン中最低(14.8%、
// 全体平均17.7%）で、2位以下は誰が来てもおかしくない混戦であることが分かる。
const GAP12_MEDIAN = 0.056;
const GAP23_MEDIAN = 0.043;

// rank2/rank3は「その馬自身」の勝率・複勝率(2026-08-21集計、n=3,583〜4,176)
const SHAPE_PATTERNS = {
  dokusou:    { label: '独走', winRate: 30.5, place: 60.9, rank2Win: 17.3, rank2Place: 48.0, rank3Win: 12.3, rank3Place: 37.9,
                hint: '1位が2位から抜け、その2位も3位以下から抜けている' },
  hanDokusou: { label: '半独走', winRate: 28.0, place: 58.8, rank2Win: 14.8, rank2Place: 43.3, rank3Win: 14.3, rank3Place: 40.1,
                hint: '1位だけが抜けているが、2位・3位は僅差で並んでいる（2位自身の勝率は全パターン中最低）' },
  nikyo:      { label: '2強', winRate: 23.2, place: 53.7, rank2Win: 21.3, rank2Place: 51.4, rank3Win: 13.5, rank3Place: 39.4,
                hint: '1位と2位は僅差だが、2頭とも3位以下から抜けている' },
  dango:      { label: '団子', winRate: 19.5, place: 48.9, rank2Win: 17.5, rank2Place: 46.9, rank3Win: 15.6, rank3Place: 40.8,
                hint: '1位・2位・3位が僅差で並んでいる' },
};

function shapeChipHtml(r) {
  if (!r.shape) return '';
  const p = SHAPE_PATTERNS[r.shape];
  const gap12 = r.gap12.toFixed(3), gap23 = r.gap23.toFixed(3);
  return ` / <span class="shape ${r.shape}" `
    + `title="${p.hint}。この型の優先1位馬は勝率${p.winRate}%・複勝率${p.place}%（1-2位差${gap12} / 2-3位差${gap23}）">`
    + `${p.label}<small>勝${p.winRate.toFixed(1)}% / 複${p.place.toFixed(1)}%</small></span>`;
}

// 優先1〜3位、それぞれの馬自身の勝率・複勝率をカードに常時表示する
function shapeDetailHtml(r) {
  if (!r.shape) return '';
  const p = SHAPE_PATTERNS[r.shape];
  return `<span class="shape-detail">`
    + `優1 勝${p.winRate.toFixed(1)}%･複${p.place.toFixed(1)}% ／ `
    + `優2 勝${p.rank2Win.toFixed(1)}%･複${p.rank2Place.toFixed(1)}% ／ `
    + `優3 勝${p.rank3Win.toFixed(1)}%･複${p.rank3Place.toFixed(1)}%`
    + `</span>`;
}

function raceShape(gap12, gap23) {
  const wide12 = gap12 >= GAP12_MEDIAN;
  const wide23 = gap23 >= GAP23_MEDIAN;
  if (wide12 && wide23) return 'dokusou';
  if (!wide12 && wide23) return 'nikyo';
  if (!wide12 && !wide23) return 'dango';
  return 'hanDokusou';
}

// ---------- 優先値の強さ目印 ----------
// 2022-2026年・芝ダート15,367レースの指数1位馬を、各値以上で累積集計。
// 2位以下に同じ率は適用できないため、目印はそれぞれの指数1位馬だけに付ける。
const SCORE_STRENGTH = {
  priority: [
    { min: 0.94, label: '最上位', cls: 'top', win: 33.9, place: 63.7 },
    { min: 0.92, label: '強', cls: 'strong', win: 31.5, place: 62.7 },
    { min: 0.90, label: '有力', cls: 'likely', win: 29.4, place: 60.6 },
  ],
  placePriority: [
    { min: 0.94, label: '最上位', cls: 'top', win: 33.2, place: 63.7 },
    { min: 0.92, label: '強', cls: 'strong', win: 31.0, place: 62.3 },
    { min: 0.90, label: '有力', cls: 'likely', win: 29.7, place: 60.5 },
  ],
};

function scoreStrengthHtml(score, rank, type) {
  if (rank !== 1) return '';
  const band = SCORE_STRENGTH[type].find((b) => score >= b.min);
  if (!band) return '';
  const tip = `${band.min.toFixed(2)}以上の指数1位馬：勝率${band.win.toFixed(1)}%・複勝率${band.place.toFixed(1)}%`;
  return `<button type="button" class="score-strength ${band.cls}" title="${tip}" data-tip="${tip}" aria-label="${band.label}。${tip}" aria-expanded="false">${band.label}</button>`;
}

// 全出走馬を指数値だけで集計した低指数帯の目印。
// 複数条件に該当するときは、最も厳しい1段階だけを表示する。
const SCORE_CAUTION = {
  priority: [
    { max: 0.30, label: '消し候補', cls: 'discard', win: 0.9, place: 4.5 },
    { max: 0.40, label: '軽視', cls: 'light-strong', win: 1.3, place: 6.2 },
    { max: 0.50, label: '軽視', cls: 'light', win: 1.7, place: 8.0 },
    { max: 0.60, label: '割引', cls: 'discount', win: 2.5, place: 10.3 },
  ],
  placePriority: [
    { max: 0.30, label: '消し候補', cls: 'discard', win: 1.0, place: 4.7 },
    { max: 0.40, label: '軽視', cls: 'light-strong', win: 1.3, place: 6.3 },
    { max: 0.50, label: '軽視', cls: 'light', win: 1.8, place: 8.1 },
    { max: 0.60, label: '割引', cls: 'discount', win: 2.5, place: 10.3 },
  ],
};

function scoreCautionHtml(score, type) {
  const band = SCORE_CAUTION[type].find((b) => score < b.max);
  if (!band) return '';
  const tip = `${band.max.toFixed(2)}未満の全出走馬：勝率${band.win.toFixed(1)}%・複勝率${band.place.toFixed(1)}%`;
  return `<button type="button" class="score-strength score-caution ${band.cls}" title="${tip}" data-tip="${tip}" aria-label="${band.label}。${tip}" aria-expanded="false">${band.label}</button>`;
}

// ---------- カードに並べる内訳指数 ----------
// 表示順。ラベルは短くしないと横に収まらない
const BREAKDOWN = [
  ['厩舎Finish-Up', '厩'],
  ['6tua', 'S'],
  ['7tua', 'F'],
  ['11tua', 'ar'],
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

// ---------- 当日人気の受け渡し ----------
// 入力した人気は数字だけなので、URLに載せて別の端末へ渡せる。
// 日付ごとに "日付:場コード-R.1位馬番.2位馬番,..." の形にまとめる。
// サーバーを使わずに済み、#以降なのでアクセス先にも残らない。
function encodePopular() {
  const byDate = new Map();
  for (const [key, nums] of state.popular) {
    const [date, placeCode, race] = key.split('|');
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(`${placeCode}-${race}.${nums[0]}.${nums[1]}`);
  }
  return [...byDate].map(([date, list]) => `${date}:${list.join(',')}`).join(';');
}

function decodePopular(text) {
  const out = new Map();
  for (const chunk of text.split(';')) {
    const [date, list] = chunk.split(':');
    if (!date || !list) continue;
    for (const item of list.split(',')) {
      const m = item.match(/^(\d+)-(\d+)\.(\d+)\.(\d+)$/);
      if (!m) continue;
      out.set(`${date}|${m[1]}|${m[2]}`, [Number(m[3]), Number(m[4])]);
    }
  }
  return out;
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
      gap12: byPriority.length >= 2 ? byPriority[0].priority - byPriority[1].priority : null,
      gap23: byPriority.length >= 3 ? byPriority[1].priority - byPriority[2].priority : null,
      shape: byPriority.length >= 3
        ? raceShape(byPriority[0].priority - byPriority[1].priority,
                    byPriority[1].priority - byPriority[2].priority)
        : null,
      agree,
      agreeOdds,
      popular: entered || null,
      firmness: agreeOdds !== null ? FIRMNESS_ODDS[agreeOdds]
        : (agree === null ? null : FIRMNESS[agree]),
      byOdds: agreeOdds !== null,
      basis: byPriority[0].priorityBasis,
      dirtLong: group.some((r) => r.placePriorityDirtLong),
      postTime: state.postTimes.get(gKey)?.time || null,
      postMinutes: state.postTimes.get(gKey)?.minutes,
      raceName: state.postTimes.get(gKey)?.raceName || null,
      courseType: state.postTimes.get(gKey)?.courseType || null,
      raceDistance: state.postTimes.get(gKey)?.distance || null,
      aim: state.postTimes.get(gKey)?.aim || null,
    });
  }

  // 発走時刻が分かるレースはその順、分からないレースは末尾へ（場・R順で安定させる）
  races.sort((a, b) => a.date.localeCompare(b.date)
    || (a.postMinutes ?? Infinity) - (b.postMinutes ?? Infinity)
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
        notify(`${skippedUnlabeled}件は指数名が判別できず読み飛ばしました（厩舎Finish-Upは「厩舎・馬名CSVを追加」から選んでください）`);
      }
    } catch (err) {
      notify(err.message || '読み込みに失敗しました');
    }
  });
  document.body.appendChild(input);
  return input;
}

// 発走時刻Excel（「検討事項およびメモ」形式）専用の選択ボタン。
// 指数レコードとは別のstate.postTimesに入るだけなので、processFileList/afterLoadは使わない。
function createSchedulePicker() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.xlsx';
  input.multiple = true;
  input.style.display = 'none';
  input.addEventListener('change', async () => {
    const files = Array.from(input.files);
    input.value = '';
    if (!files.length) return;
    try {
      let count = 0;
      for (const f of files) {
        count += await processScheduleXlsx(await f.arrayBuffer());
      }
      if (count === 0) {
        notify('発走時刻を読み取れませんでした（「検討事項およびメモ」形式のExcelを選んでください）');
        return;
      }
      if (state.records.size > 0) {
        state.races = buildRaceSummaries();
        renderRaceList();
      }
      saveCache();
      notify(`${count}レース分の発走時刻を読み込みました`);
    } catch (err) {
      notify(err.message || '読み込みに失敗しました');
    }
  });
  document.body.appendChild(input);
  return input;
}

// ---------- OneDriveなど同期フォルダ経由の端末間共有 ----------
// Gitを使わずローカルの同期フォルダ(OneDrive等)へ直接JSONを書き出す/読み込む方式。
// 指数データが公開リポジトリを経由しないので、書き出したファイルは非公開のまま同期される。
// （2026-08-20 GitHub Pages経由の公開データ方式(publish_data.py)から全面移行した）
// 書き出しはFile System Access APIを使うためChromium系デスクトップ限定だが、
// 読み込みは普通のファイル選択（<input type=file>）なのでiPhoneでも同じボタンで使える。
const SHARE_HANDLE_KEY = 'shareFileHandle';

function buildSharePayload() {
  return {
    version: 1,
    savedAt: Date.now(),
    rootName: state.rootName,
    hiddenLabels: [...state.hiddenLabels],
    records: [...state.records.values()].map((r) => ({
      date: r.date, placeCode: r.placeCode, kai: r.kai, day: r.day,
      race: r.race, uma: r.uma, name: r.name, scores: r.scores,
      surface: r.surface, distance: r.distance,
    })),
    postTimes: [...state.postTimes],
  };
}

function applySharePayload(payload) {
  state.records.clear();
  state.labels.clear();
  for (const r of payload.records || []) {
    const key = `${r.date}|${r.placeCode}|${r.race}|${r.uma}`;
    state.records.set(key, { ...r, scores: r.scores || {}, ranks: {} });
    for (const label of Object.keys(r.scores || {})) state.labels.add(label);
  }
  state.postTimes = new Map(payload.postTimes || []);
  state.rootName = payload.rootName || '共有ファイル';
  state.hiddenLabels = new Set(payload.hiddenLabels || state.labels);
  state.knownLabels = new Set(state.labels);
}

// OneDrive等の同期フォルダにJSONを書き出す。一度選んだファイルはIndexedDBに
// ハンドルを保存しておき、次回以降はダイアログなしで同じファイルに上書きする。
async function writeShareFile() {
  if (typeof window.showSaveFilePicker !== 'function') {
    throw new Error('このブラウザでは書き出しに対応していません（PCのChrome/Edgeをお使いください）');
  }
  let handle = els.shareFileHandle || await idbGet(SHARE_HANDLE_KEY).catch(() => null);
  if (handle) {
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      const req = await handle.requestPermission({ mode: 'readwrite' });
      if (req !== 'granted') handle = null;
    }
  }
  if (!handle) {
    // 「フォルダを選択して読み込み」で選んだフォルダを覚えていれば、
    // 保存ダイアログをそこから開始する（指数フォルダ内に保存しやすくする）
    const rootDir = await idbGet('rootDir').catch(() => null);
    const opts = {
      suggestedName: 'keiba-shisu-share.json',
      types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
    };
    if (rootDir) opts.startIn = rootDir;
    handle = await window.showSaveFilePicker(opts);
    await idbSet(SHARE_HANDLE_KEY, handle);
  }
  els.shareFileHandle = handle;

  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(buildSharePayload()));
  await writable.close();
  return handle.name;
}

// 共有JSONを読み込む。ファイル選択なのでOS標準のダイアログ経由でOneDrive内の
// ファイルも選べ、iPhoneのFilesアプリからでも同じ操作で読み込める。
function createShareReadPicker() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.style.display = 'none';
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      applySharePayload(payload);
      finalizeRecords();
      state.loadedAt = new Date();
      els.empty.hidden = true;
      els.dashboard.hidden = false;
      populateFilterOptions();
      renderColumnMenu();
      renderTable();
      state.races = buildRaceSummaries();
      populateRaceFilters();
      renderRaceList();
      saveCache();
      const when = payload.savedAt
        ? new Date(payload.savedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '不明';
      notify(`共有ファイルを読み込みました（${when}時点 / ${state.records.size}頭）`);
    } catch (err) {
      notify(err.message || '読み込みに失敗しました（正しい共有JSONファイルか確認してください）');
    }
  });
  document.body.appendChild(input);
  return input;
}

// ---------- 読み込んだデータの保存・復元 ----------
// 毎回ファイルを選び直すのは手間なので、読み込んだ指数をブラウザに残す。
// 順位や優先スコアは保存せず、生の値だけを残して復元時に計算し直す。
// そうしておけば、あとで重みや対象指数を変えても古い結果が残らない。
const CACHE_KEY = 'records';

async function saveCache() {
  try {
    await idbSet(CACHE_KEY, {
      savedAt: Date.now(),
      rootName: state.rootName,
      hiddenLabels: [...state.hiddenLabels],
      records: [...state.records.values()].map((r) => ({
        date: r.date, placeCode: r.placeCode, kai: r.kai, day: r.day,
        race: r.race, uma: r.uma, name: r.name, scores: r.scores,
        surface: r.surface, distance: r.distance,
      })),
      postTimes: [...state.postTimes],
    });
  } catch { /* 保存できなくても動作は続ける */ }
}

async function restoreCache() {
  let cached;
  try {
    cached = await idbGet(CACHE_KEY);
  } catch { return false; }
  if (!cached || !cached.records || !cached.records.length) return false;

  state.records.clear();
  state.labels.clear();
  for (const r of cached.records) {
    const key = `${r.date}|${r.placeCode}|${r.race}|${r.uma}`;
    state.records.set(key, { ...r, scores: r.scores || {}, ranks: {} });
    for (const label of Object.keys(r.scores || {})) state.labels.add(label);
  }
  state.rootName = cached.rootName || '前回の読み込み';
  state.hiddenLabels = new Set(cached.hiddenLabels || state.labels);
  state.knownLabels = new Set(state.labels);
  state.postTimes = new Map(cached.postTimes || []);

  finalizeRecords();
  els.empty.hidden = true;
  els.dashboard.hidden = false;
  populateFilterOptions();
  renderColumnMenu();
  renderTable();
  state.races = buildRaceSummaries();
  populateRaceFilters();
  renderRaceList();

  const when = new Date(cached.savedAt).toLocaleString('ja-JP', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  els.loadStatus.textContent = `${state.rootName} / ${state.records.size}頭 / ${when}に読込`;
  return true;
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
    notify(`${fileCount}件を読み込みました（馬名なし。「厩舎・馬名CSVを追加」でname${firstLoadedDate()}.csvも選ぶと馬名が出ます）`);
  } else {
    notify(`${fileCount}件のファイルを読み込みました`);
  }

  saveCache();
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
    <span class="chip-note priority-legend"><b>優</b>=優先指数順位 · <b>複</b>=複勝優先指数順位</span>
    <span class="chip-note legend">内訳: ${
      BREAKDOWN.map(([l, s]) => `<b>${s}</b>=${LABEL_NAMES[l] || l}`).join(' · ')
    }（値と順位）</span>`;

  els.raceList.innerHTML = races.map((r) => {
    const f = r.firmness;
    const src = r.byOdds ? '当日人気' : '予想人気';
    const badge = f
      ? `<span class="firmness ${f.key}" title="この条件の優先1位馬は勝率${f.winRate.toFixed(1)}%・複勝率${f.place.toFixed(1)}%">${f.label}<em>${src} · 勝${f.winRate.toFixed(1)}% / 複${f.place.toFixed(1)}%</em></span>`
      : `<span class="firmness unknown">判定不可<em>予想人気(GYN)なし</em></span>`;
    const pop = r.popular || [];
    // 馬番順に並べるので、優先順位はクラスで示す（先頭行＝1位ではなくなる）
    const horses = r.byUma.map((h) => {
      const popularRank = pop.indexOf(h.uma) + 1;
      const classes = [
        h.priorityRank <= 2 ? `p${h.priorityRank}` : '',
        h.placePriorityRank <= 2 ? `fp${h.placePriorityRank}` : '',
        popularRank > 0 ? `is-popular pop${popularRank}` : '',
      ].filter(Boolean).join(' ');
      return `
      <li class="${classes}">
        <div class="hrow">
          <span class="prank" title="${PRIORITY_LABEL} ${h.priorityRank}位">優${h.priorityRank}</span>
          <span class="fprank" title="${PLACE_PRIORITY_LABEL} ${h.placePriorityRank}位">複${h.placePriorityRank}</span>
          <span class="uma">${h.uma}番</span>
          <span class="hname">${h.name ? escapeHtml(h.name) : ''}</span>
          <span class="pscores">
            <span class="pscore" title="優先スコア">${scoreStrengthHtml(h.priority, h.priorityRank, 'priority')}${scoreCautionHtml(h.priority, 'priority')}<i>優</i>${h.priority.toFixed(3)}</span>
            <span class="fpscore" title="複勝優先スコア">${scoreStrengthHtml(h.placePriority, h.placePriorityRank, 'placePriority')}${scoreCautionHtml(h.placePriority, 'placePriority')}<i>複</i>${h.placePriority.toFixed(3)}</span>
            ${h.scores['GYN'] !== undefined ? `<span class="gyn" title="予想人気"><i>予</i>${h.scores['GYN']}人気</span>` : ''}
          </span>
        </div>
        ${breakdownHtml(h)}
      </li>`;
    }).join('');
    return `
      <article class="race-card ${f ? f.key : 'unknown'}${r.byOdds ? ' confirmed' : ''}">
        <header>
          <div class="rtitle">
            <strong>${formatDate(r.date)} ${r.place} ${r.race}R${r.postTime ? `<span class="post-time">${r.postTime}</span>` : ''}</strong>
            <span class="rmeta">${r.fieldSize}頭 / ${r.basis}指数${shapeChipHtml(r)}${r.dirtLong ? '<span class="dirt-long-badge" title="ダート1801m以上のためＳ指数優位の重みで複勝優先指数を計算しています">ダ長</span>' : ''}</span>
            ${r.raceName ? `<span class="rcourse">
              <span class="race-name">${r.raceName}</span>
              ${r.courseType ? `<span class="surface-badge ${surfaceBadgeClass(r.courseType)}"${r.aim ? ` title="${escapeAttr(r.aim)}"` : ''}>${r.courseType}${r.raceDistance || ''}</span>` : ''}
            </span>` : ''}
            ${shapeDetailHtml(r)}
          </div>
          ${badge}
        </header>
        <ol class="horses">${horses}</ol>
        <div class="race-actions">
          <button type="button" class="x-post-button" data-race="${r.key}" aria-label="${r.place} ${r.race}Rの全馬をXへ投稿">Xへ投稿</button>
        </div>
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

// X投稿用本文。全馬を収めやすいよう、項目名は見出しにまとめ、優先値は小数2桁にする。
function racePostText(race) {
  const marks = ['◎', '〇', '▲'];
  const selections = race.all.slice(0, 3).map((h, i) => {
    const name = h.name ? String(h.name).trim() : '馬名なし';
    return `${marks[i]} ${h.uma}番 ${name}`;
  });
  const rows = race.byUma.map((h) => {
    const name = h.name ? String(h.name).trim() : '馬名なし';
    return `${h.uma} ${name} ${h.priority.toFixed(2)}`;
  });
  return `EUの優先指数🐎\n${race.place} ${race.race}R\n${selections.join('\n')}\n\n全馬指数\n馬番 馬名 優先値\n${rows.join('\n')}`;
}

function openRacePost(raceKey) {
  const race = state.races.find((r) => r.key === raceKey);
  if (!race) return;
  const text = racePostText(race);
  window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`,
    '_blank', 'noopener,noreferrer');
  if (text.length > 280) {
    notify(`全馬分は${text.length}文字です。通常投稿に収まらない場合はX側で調整してください`);
  }
}

// ---------- フィルタUI ----------
function formatDate(d) {
  return `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}`;
}

// 芝=緑・ダ=茶・それ以外(障害など)=グレー
function surfaceBadgeClass(courseType) {
  if (courseType === '芝') return 'turf';
  if (courseType === 'ダ') return 'dirt';
  return 'jump';
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

// iPhoneなどフォルダ選択が使えない環境向け。指数ZIPだけを直接選ぶ
els.zipButton.addEventListener('click', () => {
  els.zipPicker = els.zipPicker
    || createFilePicker('zipPicker', '.zip', '', '指数ZIP選択');
  els.zipPicker.click();
});

// 厩舎Finish-Up・馬名CSVをまとめて選ぶ。厩舎は日付だけのファイル名で
// 指数名が判別できないため、フォールバック用に'厩舎Finish-Up'を指定しておく
// （name<日付>.csvは自分のファイル名から'name'ラベルを判別できるので上書きされない）。
els.csvButton.addEventListener('click', () => {
  els.csvPicker = els.csvPicker
    || createFilePicker('csvPicker', '.csv', '厩舎Finish-Up', '厩舎・馬名CSV追加');
  els.csvPicker.click();
});

// 発走時刻Excel（週間競馬フォルダの「検討事項およびメモ」形式）を選ぶ
els.scheduleButton.addEventListener('click', () => {
  els.schedulePicker = els.schedulePicker || createSchedulePicker();
  els.schedulePicker.click();
});

// OneDrive等の同期フォルダへ現在のデータをJSONで書き出す(PC側)
els.shareWriteButton.addEventListener('click', async () => {
  try {
    const name = await writeShareFile();
    notify(`「${name}」に書き出しました。OneDriveの同期が終わってから他端末で読み込んでください`);
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    notify(err.message || '書き出しに失敗しました');
  }
});

// OneDrive等の同期フォルダから共有JSONを読み込む(PC・iPhone共通)
els.shareReadButton.addEventListener('click', () => {
  els.shareReadPicker = els.shareReadPicker || createShareReadPicker();
  els.shareReadPicker.click();
});

// 入力した当日人気を、他の端末へ渡すリンクにする
els.sharePopButton.addEventListener('click', async () => {
  if (!state.popular.size) {
    notify('当日人気がまだ入力されていません');
    return;
  }
  const url = `${location.origin}${location.pathname}#pop=${encodeURIComponent(encodePopular())}`;
  try {
    await navigator.clipboard.writeText(url);
    notify(`${state.popular.size}レース分のリンクをコピーしました`);
  } catch {
    // クリップボードが使えない環境では選択できる形で出す
    window.prompt('このリンクを他の端末で開いてください', url);
  }
});

// 保存済みの指数と、当日入力した人気をまとめて消す
els.clearButton.addEventListener('click', async () => {
  await idbSet(CACHE_KEY, null).catch(() => {});
  state.popular.clear();
  savePopular();
  state.records.clear();
  state.labels.clear();
  state.knownLabels = new Set();
  state.postTimes.clear();
  state.races = [];
  els.dashboard.hidden = true;
  els.empty.hidden = false;
  els.loadStatus.textContent = '未読み込み';
  notify('保存データを消しました');
});

// フォルダ選択が使えない環境では、そちらのボタンを目立たせない
if (typeof window.showDirectoryPicker !== 'function') {
  els.loadButton.classList.remove('primary');
  els.zipButton.classList.add('primary');
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
  const postButton = ev.target.closest('.x-post-button');
  if (postButton) {
    openRacePost(postButton.dataset.race);
    return;
  }
  const strength = ev.target.closest('.score-strength');
  if (strength) {
    const willOpen = !strength.classList.contains('show-tip');
    els.raceList.querySelectorAll('.score-strength.show-tip').forEach((el) => {
      el.classList.remove('show-tip');
      el.setAttribute('aria-expanded', 'false');
    });
    if (willOpen) {
      strength.classList.add('show-tip');
      strength.setAttribute('aria-expanded', 'true');
    }
    return;
  }
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
  if (!e.target.closest('.score-strength')) {
    document.querySelectorAll('.score-strength.show-tip').forEach((el) => {
      el.classList.remove('show-tip');
      el.setAttribute('aria-expanded', 'false');
    });
  }
  if (!els.columnMenu.hidden && !els.columnMenu.contains(e.target) && e.target !== els.columnButton) {
    els.columnMenu.hidden = true;
  }
});
els.columnMenu.addEventListener('click', (e) => {
  const action = e.target.dataset.action;
  if (action === 'all') { state.hiddenLabels.clear(); renderColumnMenu(); renderTable(); }
  if (action === 'none') { state.hiddenLabels = new Set(state.labels); renderColumnMenu(); renderTable(); }
  if (action === 'all' || action === 'none') persistHiddenLabels();
});
els.columnMenu.addEventListener('change', (e) => {
  const label = e.target.dataset.label;
  if (!label) return;
  if (e.target.checked) state.hiddenLabels.delete(label);
  else state.hiddenLabels.add(label);
  updateColumnCount();
  renderTable();
  persistHiddenLabels();
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

// 指数の表示選択を変えたら、その状態も残しておく
function persistHiddenLabels() {
  if (!state.records.size) return;
  saveCache();
}

// 当日入力した人気は再読み込みしても残す
state.popular = loadPopular();

// 共有リンク（#pop=...）で開かれたときは、そこに入っている人気を取り込む
const sharedPop = location.hash.match(/[#&]pop=([^&]+)/);
let importedPop = 0;
if (sharedPop) {
  const incoming = decodePopular(decodeURIComponent(sharedPop[1]));
  for (const [key, nums] of incoming) state.popular.set(key, nums);
  importedPop = incoming.size;
  if (importedPop) savePopular();
  // 取り込んだらURLから消す。hashは replaceState だけでは残ることがあるので
  // location.hash も明示的に空にする
  history.replaceState(null, '', location.pathname + location.search);
  if (location.hash) location.hash = '';
}

// 起動時の読み込み。前回のキャッシュがあればそのまま表示する。
(async () => {
  const restored = await restoreCache();
  const popMsg = importedPop ? `／当日人気${importedPop}レース分を取り込みました` : '';

  if (restored) {
    // 共有リンクで人気が増えていれば、判定を出し直す
    if (importedPop) {
      state.races = buildRaceSummaries();
      renderRaceList();
    }
    notify('前回読み込んだ指数を表示しています' + popMsg);
  } else if (importedPop) {
    notify(`当日人気${importedPop}レース分を取り込みました（指数はこれから読み込んでください）`);
  }
})();
