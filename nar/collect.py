#!/usr/bin/env python3
"""ネット競馬（地方競馬）のレース結果を収集し、分析用CSVにまとめるツール。

使い方（詳しくは README.md）。collect.py を置いたフォルダで実行する:
    python collect.py --start 20250101 --end 20261102 --venues 南関東
    python collect.py --build-only          # キャッシュからCSVだけ作り直す

- データは collect.py と同じフォルダの nar_data/ に保存する
- 取得したページは nar_data/cache/ に「1日分＝1ファイル」で圧縮保存し、二度と同じ
  ページを取りに行かない（途中で止めても、次回は続きから再開する）。OneDrive上に
  置いてもファイル数が膨らまないよう、1日単位にまとめている
- アクセス間隔は既定3秒。ネット競馬の利用規約（第16条12号：設備の運営に支障を
  与える行為の禁止）に配慮し、短くしすぎないこと
- 取得データは私的利用の範囲でのみ使うこと（利用規約第14条）。公開リポジトリや
  GitHub Pagesに置かない（nar_data/ は .gitignore 済み）

Python 3.8以上・標準ライブラリのみで動く（pip install 不要）。
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import html
import json
import random
import re
import signal
import ssl
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

BASE = "https://nar.netkeiba.com"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)

# ネット競馬（地方）の場コード。race_id = 年4桁 + 場2桁 + 月日4桁 + R2桁
VENUES = {
    "30": "門別", "35": "盛岡", "36": "水沢", "42": "浦和", "43": "船橋",
    "44": "大井", "45": "川崎", "46": "金沢", "47": "笠松", "48": "名古屋",
    "50": "園田", "51": "姫路", "54": "高知", "55": "佐賀", "65": "帯広(ば)",
}
VENUE_GROUPS = {
    "南関東": ["42", "43", "44", "45"],
    "岩手": ["35", "36"],
    "東海": ["47", "48"],
    "兵庫": ["50", "51"],
}
BANEI = "65"

DEFAULT_OUT = Path(__file__).resolve().parent / "nar_data"

RACE_FIELDS = [
    "race_id", "date", "venue_code", "venue", "race_no", "race_name", "class",
    "surface", "distance", "direction", "weather", "going", "field_size",
    "post_time", "kai", "nichi", "prize1_man", "lap", "pace_first3f", "pace_last3f",
]
HORSE_FIELDS = [
    "race_id", "date", "venue", "surface", "distance", "going", "field_size",
    "finish", "finish_pos", "frame", "horse_no", "horse_id", "horse_name",
    "sex", "age", "carried_weight", "jockey_id", "jockey", "jockey_mark", "time", "time_sec",
    "margin", "popularity", "win_odds", "last3f", "affiliation", "trainer_id",
    "trainer", "body_weight", "body_weight_diff", "corner_pass", "corner_last",
]
PAYOUT_FIELDS = ["race_id", "date", "venue", "bet_type", "combination", "payout", "popularity"]


class Blocked(Exception):
    """アクセス制限を受けた可能性が高いときに投げる（即座に全体を止める）。"""


class NetworkRefused(Exception):
    """証明書エラー等で接続自体ができないとき（会社などのフィルタで遮断されている場合など）。
    再試行しても無駄なうえ、遮断されたアクセスの記録が増えるだけなので即座に止める。"""


# ---------------------------------------------------------------------------
# 取得
# ---------------------------------------------------------------------------
class Fetcher:
    def __init__(self, interval: float):
        self.interval = interval
        self.last = 0.0
        self.count = 0

    def get(self, url: str) -> str:
        for attempt, backoff in enumerate((0, 15, 60, 180)):
            if backoff:
                print(f"    再試行まで{backoff}秒待機…", flush=True)
                time.sleep(backoff)
            wait = self.interval * random.uniform(0.9, 1.3) - (time.monotonic() - self.last)
            if wait > 0:
                time.sleep(wait)
            req = urllib.request.Request(
                url, headers={"User-Agent": USER_AGENT, "Accept-Language": "ja,en;q=0.5"}
            )
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    raw = resp.read()
                    charset = resp.headers.get_content_charset() or "utf-8"
                return decode(raw, charset)
            except urllib.error.HTTPError as e:
                if e.code in (400, 403, 429):
                    raise Blocked(f"HTTP {e.code}: {url}") from e
                if e.code == 404:
                    raise ConnectionError(f"ページがありません（404）: {url}") from e
                print(f"    HTTP {e.code}: {url}", flush=True)
            except urllib.error.URLError as e:
                if isinstance(e.reason, ssl.SSLError):
                    raise NetworkRefused(str(e.reason)) from e
                print(f"    通信エラー: {e}", flush=True)
            except (TimeoutError, ConnectionError) as e:
                print(f"    通信エラー: {e}", flush=True)
            finally:
                self.last = time.monotonic()
                self.count += 1
        raise ConnectionError(f"取得失敗: {url}")


def decode(raw: bytes, charset: str = "utf-8") -> str:
    for enc in (charset, "utf-8", "euc-jp", "cp932"):
        try:
            return raw.decode(enc)
        except (LookupError, UnicodeDecodeError):
            continue
    return raw.decode("utf-8", errors="replace")


def day_path(out: Path, ymd: str) -> Path:
    return out / "cache" / ymd[:4] / f"{ymd}.json.gz"


def load_day(path: Path) -> dict | None:
    """1日分のキャッシュ: {"race_ids": その日の全レース, "pages": {race_id: 結果ページ}, "no_result": [...]}"""
    if not path.exists():
        return None
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return json.load(f)


def save_day(path: Path, day: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with gzip.open(tmp, "wt", encoding="utf-8") as f:
        json.dump(day, f, ensure_ascii=False)
    for i in range(10):
        try:
            tmp.replace(path)
            return
        except PermissionError:  # OneDriveの同期中などで一時的に置き換えられないことがある
            time.sleep(1 + i)
    raise PermissionError(f"キャッシュを保存できませんでした（{tmp} に退避しています）: {path}")


def trim_result_page(text: str) -> str:
    """分析に使う部分（レース情報＋表）だけを残してキャッシュを小さくする。"""
    a = text.find('<div class="RaceList_Item02">')
    b = text.find("<!-- /.RaceList_Item02 -->")
    head = text[a:b] if a >= 0 and b > a else ""
    tables = re.findall(r"(?s)<table[^>]*>.*?</table>", text)
    return head + "\n" + "\n".join(tables)


# ---------------------------------------------------------------------------
# 解析
# ---------------------------------------------------------------------------
def clean(s: str) -> str:
    s = re.sub(r"(?s)<[^>]+>", " ", s)
    s = html.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def to_int(s: str):
    m = re.search(r"-?\d+", s.replace(",", ""))
    return int(m.group()) if m else ""


def to_float(s: str):
    m = re.search(r"-?\d+(?:\.\d+)?", s.replace(",", ""))
    return float(m.group()) if m else ""


def time_to_sec(s: str):
    m = re.fullmatch(r"(?:(\d+):)?(\d+(?:\.\d+)?)", s.strip())
    if not m:
        return ""
    return round(int(m.group(1) or 0) * 60 + float(m.group(2)), 1)


def parse_race_list(text: str) -> list[str]:
    return sorted(set(re.findall(r"race_id=(\d{12})", text)))


def parse_corner_order(s: str) -> dict[int, int]:
    """'(11,10)-(2,12),(8,9),7' → {11:1, 10:1, 2:3, 12:3, 8:5, 9:5, 7:7}
    括弧内は横並び（同じ位置）として扱う。"""
    s = s.replace("*", "").replace(" ", "")
    out: dict[int, int] = {}
    pos, i = 1, 0
    while i < len(s):
        c = s[i]
        if c == "(":
            j = s.find(")", i)
            if j < 0:
                break
            group = [x for x in re.split(r"[,\-=・]", s[i + 1 : j]) if x.isdigit()]
            for h in group:
                out[int(h)] = pos
            pos += len(group)
            i = j + 1
        elif c.isdigit():
            m = re.match(r"\d+", s[i:])
            out[int(m.group())] = pos
            pos += 1
            i += len(m.group())
        else:
            i += 1
    return out


def parse_laps(table: str):
    rows = re.findall(r"(?s)<tr[^>]*>(.*?)</tr>", table)
    if len(rows) < 3:
        return "", "", ""
    header = [clean(c) for c in re.findall(r"(?s)<th[^>]*>(.*?)</th>", rows[0])]
    cumul = [clean(c) for c in re.findall(r"(?s)<td[^>]*>(.*?)</td>", rows[1])]
    laps = [clean(c) for c in re.findall(r"(?s)<td[^>]*>(.*?)</td>", rows[2])]
    lap_f = [to_float(x) for x in laps]
    lap_str = "-".join(laps)
    first3f = ""
    if "600m" in header:
        idx = header.index("600m")
        if idx < len(cumul):
            first3f = time_to_sec(cumul[idx])
    last3f = ""
    if len(lap_f) >= 3 and all(isinstance(x, float) for x in lap_f[-3:]):
        last3f = round(sum(lap_f[-3:]), 1)
    return lap_str, first3f, last3f


def parse_payouts(tables: list[str]) -> list[dict]:
    out = []
    for tb in tables:
        for tr in re.findall(r"(?s)<tr[^>]*>(.*?)</tr>", tb):
            th = re.search(r"(?s)<th[^>]*>(.*?)</th>", tr)
            res = re.search(r'(?s)<td\s+class="Result">(.*?)</td>', tr)
            pay = re.search(r'(?s)<td class="Payout">(.*?)</td>', tr)
            nin = re.search(r'(?s)<td class="Ninki">(.*?)</td>', tr)
            if not (th and res and pay):
                continue
            bet = clean(th.group(1))
            if "<ul" in res.group(1):
                combos = []
                for ul in re.findall(r"(?s)<ul[^>]*>(.*?)</ul>", res.group(1)):
                    nums = [clean(x) for x in re.findall(r"(?s)<span[^>]*>(.*?)</span>", ul)]
                    combos.append("-".join(n for n in nums if n))
            else:
                nums = [clean(x) for x in re.findall(r"(?s)<span[^>]*>(.*?)</span>", res.group(1))]
                combos = [n for n in nums if n]
            pays = [clean(x) for x in re.split(r"<br\s*/?>", pay.group(1))]
            pays = [x for x in pays if x]
            ninkis = [clean(x) for x in re.split(r"<br\s*/?>", nin.group(1))] if nin else []
            ninkis = [x for x in ninkis if x]
            for k, combo in enumerate(combos):
                out.append({
                    "bet_type": bet,
                    "combination": combo,
                    "payout": to_int(pays[k]) if k < len(pays) else "",
                    "popularity": to_int(ninkis[k]) if k < len(ninkis) else "",
                })
    return out


def parse_result(text: str, race_id: str):
    """結果ページ → (レース情報dict, 出走馬dictのlist, 払戻dictのlist)。結果が無ければNone。"""
    m = re.search(r'(?s)<table[^>]*id="All_Result_Table"[^>]*>(.*?)</table>', text)
    if not m:
        return None
    main = m.group(1)

    date = f"{race_id[0:4]}-{race_id[6:8]}-{race_id[8:10]}"
    vcode = race_id[4:6]
    race = {k: "" for k in RACE_FIELDS}
    race.update(race_id=race_id, date=date, venue_code=vcode,
                venue=VENUES.get(vcode, vcode), race_no=int(race_id[10:12]))

    name = re.search(r'(?s)<div class="RaceName">(.*?)</div>', text)
    race["race_name"] = clean(name.group(1)) if name else ""
    d1 = re.search(r'(?s)<div class="RaceData01">(.*?)</div>', text)
    if d1:
        s = clean(d1.group(1))
        if (mm := re.search(r"(\d{1,2}:\d{2})発走", s)):
            race["post_time"] = mm.group(1)
        if (mm := re.search(r"(芝|ダ|障)\s*(\d+)m", s)):
            race["surface"], race["distance"] = mm.group(1), int(mm.group(2))
        if (mm := re.search(r"\((左|右|直線?)[^)]*\)", s)):
            race["direction"] = mm.group(1)
        if (mm := re.search(r"天候:(\S+)", s)):
            race["weather"] = mm.group(1)
        if (mm := re.search(r"馬場:(\S+)", s)):
            race["going"] = mm.group(1)
    d2 = re.search(r'(?s)<div class="RaceData02">(.*?)</div>', text)
    if d2:
        spans = [clean(x) for x in re.findall(r"(?s)<span[^>]*>(.*?)</span>", d2.group(1))]
        for sp in spans:
            if re.fullmatch(r"\d+回", sp):
                race["kai"] = to_int(sp)
            elif re.fullmatch(r"\d+日目", sp):
                race["nichi"] = to_int(sp)
            elif re.fullmatch(r"\d+頭", sp):
                race["field_size"] = to_int(sp)
            elif sp.startswith("本賞金"):
                race["prize1_man"] = to_float(sp.split(":", 1)[-1])
            elif (sp and not race["class"] and sp not in VENUES.values() and sp != "帯広"
                  and re.search(r"[A-Za-zＡ-Ｚ一-龥]", sp)):
                race["class"] = sp

    tables = re.findall(r"(?s)<table[^>]*>.*?</table>", text)
    for tb in tables:
        if "Race_HaronTime" in tb[:200]:
            race["lap"], race["pace_first3f"], race["pace_last3f"] = parse_laps(tb)

    # コーナー通過順
    corners: list[dict[int, int]] = []
    for tb in tables:
        if "Corner_Num" in tb[:200]:
            for tr in re.findall(r"(?s)<tr[^>]*>(.*?)</tr>", tb):
                td = re.search(r"(?s)<td[^>]*>(.*?)</td>", tr)
                if td:
                    corners.append(parse_corner_order(clean(td.group(1))))

    # 着順表（列は見出しの文字で対応づける）
    head = re.search(r"(?s)<thead>(.*?)</thead>", main)
    headers = [re.sub(r"\s+", "", clean(h)) for h in re.findall(r"(?s)<th[^>]*>(.*?)</th>", head.group(1))] if head else []
    body = main[head.end():] if head else main
    horses = []
    for tr in re.findall(r"(?s)<tr[^>]*>(.*?)</tr>", body):
        cells = re.findall(r"(?s)<td[^>]*>(.*?)</td>", tr)
        if len(cells) < len(headers) or not headers:
            continue
        col = dict(zip(headers, cells))
        h = {k: "" for k in HORSE_FIELDS}
        h.update(race_id=race_id, date=date, venue=race["venue"], surface=race["surface"],
                 distance=race["distance"], going=race["going"], field_size=race["field_size"])
        h["finish"] = clean(col.get("着順", ""))
        h["finish_pos"] = int(h["finish"]) if h["finish"].isdigit() else ""
        h["frame"] = to_int(clean(col.get("枠", "")))
        h["horse_no"] = to_int(clean(col.get("馬番", "")))
        cell = col.get("馬名", "")
        if (mm := re.search(r"/horse/(\w+)", cell)):
            h["horse_id"] = mm.group(1)
        h["horse_name"] = clean(cell)
        sa = clean(col.get("性齢", ""))
        if sa:
            h["sex"], h["age"] = sa[0], to_int(sa[1:])
        h["carried_weight"] = to_float(clean(col.get("斤量", "")))
        cell = col.get("騎手", "")
        if (mm := re.search(r"/jockey/(?:result/recent/)?(\w+)", cell)):
            h["jockey_id"] = mm.group(1)
        # 減量記号（☆★▲△◇など）は騎手名から分けて別の列に入れる
        mm = re.match(r"([☆★▲△◇◆]*)\s*(.*)", clean(cell))
        h["jockey_mark"], h["jockey"] = mm.group(1), mm.group(2)
        h["time"] = clean(col.get("タイム", ""))
        h["time_sec"] = time_to_sec(h["time"]) if h["time"] else ""
        h["margin"] = clean(col.get("着差", ""))
        h["popularity"] = to_int(clean(col.get("人気", "")))
        h["win_odds"] = to_float(clean(col.get("単勝オッズ", "")))
        h["last3f"] = to_float(clean(col.get("後3F", "")))
        cell = col.get("厩舎", "")
        if (mm := re.search(r'class="LabelGray">(.*?)</span>', cell)):
            h["affiliation"] = clean(mm.group(1))
        if (mm := re.search(r"/trainer/(?:result/recent/)?(\w+)", cell)):
            h["trainer_id"] = mm.group(1)
        if (mm := re.search(r'title="([^"]+)"', cell)):
            h["trainer"] = html.unescape(mm.group(1))
        else:
            h["trainer"] = clean(re.sub(r'(?s)<span class="LabelGray">.*?</span>', "", cell))
        bw_key = next((k for k in headers if k.startswith("馬体重")), None)
        bw = clean(col.get(bw_key, "")) if bw_key else ""
        if (mm := re.match(r"(\d+)\s*\(([+\-]?\d+)\)", bw)):
            h["body_weight"], h["body_weight_diff"] = int(mm.group(1)), int(mm.group(2))
        elif (mm := re.match(r"(\d+)", bw)):
            h["body_weight"] = int(mm.group(1))
        if corners and isinstance(h["horse_no"], int):
            seq = [str(c.get(h["horse_no"], "")) for c in corners]
            h["corner_pass"] = "-".join(seq) if any(seq) else ""
            last = corners[-1].get(h["horse_no"])
            h["corner_last"] = last if last is not None else ""
        horses.append(h)

    if not horses:
        return None
    if not race["field_size"]:
        race["field_size"] = len(horses)
        for h in horses:
            h["field_size"] = race["field_size"]

    payouts = parse_payouts([tb for tb in tables if "Payout_Detail_Table" in tb[:200]])
    for p in payouts:
        p.update(race_id=race_id, date=date, venue=race["venue"])
    return race, horses, payouts


# ---------------------------------------------------------------------------
# 収集の本体
# ---------------------------------------------------------------------------
def resolve_venues(spec: str | None, include_banei: bool) -> set[str]:
    if not spec:
        codes = set(VENUES)
    else:
        codes = set()
        name_to_code = {v: k for k, v in VENUES.items()}
        for tok in re.split(r"[,、\s]+", spec.strip()):
            if not tok:
                continue
            if tok in VENUE_GROUPS:
                codes.update(VENUE_GROUPS[tok])
            elif tok in VENUES:
                codes.add(tok)
            elif tok in name_to_code:
                codes.add(name_to_code[tok])
            elif tok in ("帯広", "ばんえい"):
                codes.add(BANEI)
            else:
                sys.exit(f"不明な競馬場: {tok}（使える名前: {', '.join(list(VENUES.values()) + list(VENUE_GROUPS))}）")
    if not include_banei and spec is None:
        codes.discard(BANEI)
    return codes


def daterange_desc(start: dt.date, end: dt.date):
    d = end
    while d >= start:
        yield d
        d -= dt.timedelta(days=1)


def collect(args) -> None:
    out: Path = args.out
    today = dt.date.today()
    start = dt.datetime.strptime(args.start, "%Y%m%d").date()
    end = dt.datetime.strptime(args.end, "%Y%m%d").date() if args.end else today - dt.timedelta(days=1)
    if end >= today:
        end = today - dt.timedelta(days=1)
        print(f"結果が確定している昨日（{end:%Y-%m-%d}）までに絞ります。")
    venues = resolve_venues(args.venues, args.include_banei)
    print(f"対象: {start:%Y-%m-%d} 〜 {end:%Y-%m-%d} / "
          f"{'・'.join(VENUES[c] for c in sorted(venues))} / 間隔{args.interval}秒")

    fetcher = Fetcher(args.interval)
    consecutive_fail = 0
    new_pages = 0
    day, path, dirty = None, None, False
    try:
        for d in daterange_desc(start, end):
            ymd = d.strftime("%Y%m%d")
            path = day_path(out, ymd)
            day, dirty = load_day(path), False
            if day is None:
                try:
                    text = fetcher.get(f"{BASE}/top/race_list_sub.html?kaisai_date={ymd}")
                except ConnectionError as e:
                    print(f"  ! {d:%Y-%m-%d} のレース一覧を取得できませんでした（次回再試行）: {e}", flush=True)
                    continue
                race_ids = parse_race_list(text)
                if not race_ids:  # 開催なしの日は保存しない（念のため次回も確認）
                    continue
                day, dirty = {"race_ids": race_ids, "pages": {}, "no_result": []}, True
            targets = [r for r in day["race_ids"] if r[4:6] in venues]
            todo = [r for r in targets if r not in day["pages"] and r not in day["no_result"]]
            if todo:
                per_venue = Counter(VENUES.get(r[4:6], r[4:6]) for r in targets)
                eta_min = len(todo) * 3.7 * args.interval / 3 / 60  # 実測: 間隔3秒で1件約3.7秒
                eta = f"約{eta_min:.0f}分" if eta_min >= 1 else "1分未満"
                print(f"{d:%Y-%m-%d} " + " ".join(f"{k}{v}R" for k, v in per_venue.items())
                      + f" → {len(todo)}件取得（{eta}）", flush=True)
            for r in todo:
                try:
                    text = fetcher.get(f"{BASE}/race/result.html?race_id={r}")
                    consecutive_fail = 0
                except ConnectionError as e:
                    consecutive_fail += 1
                    print(f"  ! {e}", flush=True)
                    if consecutive_fail >= 5:
                        raise Blocked("連続で取得に失敗しました") from e
                    continue
                if 'id="All_Result_Table"' in text and parse_result(text, r):
                    day["pages"][r] = trim_result_page(text)
                    new_pages += 1
                else:
                    # 開催中止・競走不成立などで結果表が無いレース
                    day["no_result"].append(r)
                    print(f"  - {r}: 結果表なし（中止等）", flush=True)
                dirty = True
            if dirty:  # 1日分まとめて保存
                save_day(path, day)
                dirty = False
    except Blocked as e:
        print(f"\n!! アクセスを中断しました: {e}\n"
              "   アクセス制限を受けた可能性があります。数時間〜1日おいてから同じコマンドで再開してください。\n"
              "   取得済みのページは保存済みなので、続きから再開されます。", flush=True)
    except NetworkRefused as e:
        print(f"\n!! ネット競馬に安全に接続できなかったため、すぐに中止しました（{e}）。\n"
              "   会社などのネットワークでは、フィルタで競馬サイトへの接続が止められていることがあります。\n"
              "   その場合は、このネットワークでは実行しないでください。", flush=True)
    except KeyboardInterrupt:
        print("\n中断しました（取得済み分は保存済み。同じコマンドで続きから再開できます）")
    finally:
        if dirty and day is not None:  # 途中で止まった日の取得済み分も保存する
            save_day(path, day)
    print(f"\n今回のアクセス数: {fetcher.count} / 新規保存: {new_pages}レース")


def build(out: Path) -> None:
    files = sorted((out / "cache").glob("*/*.json.gz"))
    if not files:
        print("キャッシュがありません。先に収集を実行してください。")
        return
    races, horses, payouts = [], [], []
    bad = 0
    for f in files:
        for race_id, page in load_day(f)["pages"].items():
            parsed = parse_result(page, race_id)
            if not parsed:
                bad += 1
                continue
            r, hs, ps = parsed
            races.append(r)
            horses.extend(hs)
            payouts.extend(ps)
    races.sort(key=lambda r: r["race_id"])
    order = {r["race_id"]: i for i, r in enumerate(races)}
    horses.sort(key=lambda h: (order[h["race_id"]], h["horse_no"] if isinstance(h["horse_no"], int) else 99))
    payouts.sort(key=lambda p: order[p["race_id"]])
    for name, rows, fields in (("races.csv", races, RACE_FIELDS),
                               ("results.csv", horses, HORSE_FIELDS),
                               ("payouts.csv", payouts, PAYOUT_FIELDS)):
        path = out / name
        try:
            with open(path, "w", newline="", encoding="utf-8-sig") as f:
                w = csv.DictWriter(f, fieldnames=fields)
                w.writeheader()
                w.writerows(rows)
        except PermissionError:
            sys.exit(f"{path} に書き込めません。Excelで開いている場合は閉じてから、"
                     "python collect.py --build-only でCSVだけ作り直してください（取得済みのデータは保存済みです）。")
    print(f"CSVを作成: {out / 'races.csv'}（{len(races)}レース）, results.csv（{len(horses)}頭）, "
          f"payouts.csv（{len(payouts)}行）" + (f" / 解析できなかったキャッシュ{bad}件" if bad else ""))


def main() -> None:
    p = argparse.ArgumentParser(description="ネット競馬（地方）の結果を収集してCSVにまとめる")
    p.add_argument("--start", help="開始日 YYYYMMDD")
    p.add_argument("--end", help="終了日 YYYYMMDD（省略時は昨日）")
    p.add_argument("--venues", help="競馬場（例: 南関東 / 大井,川崎 / 44,45）。省略時はばんえい以外の全場")
    p.add_argument("--include-banei", action="store_true", help="--venues 省略時にばんえいも含める")
    p.add_argument("--interval", type=float, default=3.0, help="アクセス間隔（秒、既定3。2未満は不可）")
    p.add_argument("--out", type=Path, default=DEFAULT_OUT, help=f"保存先（既定 {DEFAULT_OUT}）")
    p.add_argument("--build-only", action="store_true", help="取得せず、キャッシュからCSVだけ作り直す")
    args = p.parse_args()

    if sys.version_info < (3, 8):
        sys.exit("Python 3.8以上が必要です")

    def _terminate(signum, frame):  # 外から止められたときも、その日の取得分を保存してから終わる
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, _terminate)

    if not args.build_only:
        if not args.start:
            p.error("--start を指定してください（--build-only のときは不要）")
        if args.interval < 2:
            p.error("--interval は2秒以上にしてください（相手サーバーへの負荷配慮）")
        collect(args)
    build(args.out)


if __name__ == "__main__":
    main()
