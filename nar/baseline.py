#!/usr/bin/env python3
"""collect.py で作ったCSVから、地方競馬の基礎傾向を集計するツール。

    python nar/baseline.py                 # nar_data/ の全データ
    python nar/baseline.py --venues 南関東  # 競馬場を絞る

結果は画面表示に加えて nar_data/reports/baseline.md に保存する。
各表には期間を前半・後半に分けた勝率（または複勝率）を並べてあるので、
前後半で同じ傾向が出ているか（＝偶然でないか）を必ず確認すること。

集計対象は出走した馬のみ（取消・除外は除く）。複勝率は3着以内率、
回収率は払戻データ（payouts.csv）の実際の配当で計算する。
Python 3.8以上・標準ライブラリのみ。
"""
from __future__ import annotations

import argparse
import csv
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from collect import DEFAULT_OUT, resolve_venues, VENUES  # noqa: E402

MIN_N = 30  # これ未満のセルは「-」表示（少なすぎて解釈できないため）


def load(out: Path, venue_codes: set[str]):
    venue_names = {VENUES[c] for c in venue_codes}
    with open(out / "results.csv", encoding="utf-8-sig") as f:
        rows = [r for r in csv.DictReader(f) if r["venue"] in venue_names]
    with open(out / "payouts.csv", encoding="utf-8-sig") as f:
        pay = defaultdict(int)
        for p in csv.DictReader(f):
            if p["bet_type"] in ("単勝", "複勝") and p["payout"]:
                pay[(p["race_id"], p["bet_type"], p["combination"])] += int(p["payout"])
    horses = []
    for r in rows:
        if r["finish"] in ("取消", "除外") or not r["horse_no"]:
            continue
        pos = int(r["finish_pos"]) if r["finish_pos"] else None
        h = {
            "race_id": r["race_id"], "date": r["date"], "venue": r["venue"],
            "surface": r["surface"], "distance": int(r["distance"] or 0),
            "field": int(r["field_size"] or 0), "horse_id": r["horse_id"],
            "horse_no": r["horse_no"], "frame": int(r["frame"] or 0),
            "jockey": r["jockey_id"] or r["jockey"], "jockey_name": r["jockey"], "pop": int(r["popularity"]) if r["popularity"] else None,
            "pos": pos, "last3f": float(r["last3f"]) if r["last3f"] else None,
            "corner_last": int(r["corner_last"]) if r["corner_last"] else None,
        }
        h["win"] = pos == 1
        h["place"] = pos is not None and pos <= 3
        h["win_ret"] = pay.get((r["race_id"], "単勝", r["horse_no"]), 0) if h["win"] else 0
        h["place_ret"] = pay.get((r["race_id"], "複勝", r["horse_no"]), 0)
        horses.append(h)
    return horses


def add_prev_features(horses: list[dict]) -> None:
    """同じ馬の「収集データ内での前走」の情報を付ける（中央・他地区からの転入初戦などは None）。"""
    by_race = defaultdict(list)
    for h in horses:
        by_race[h["race_id"]].append(h)
    for hs in by_race.values():  # レース内の上がり3F順位
        vals = sorted(h["last3f"] for h in hs if h["last3f"] is not None)
        for h in hs:
            h["l3f_rank"] = vals.index(h["last3f"]) + 1 if h["last3f"] is not None else None
    by_horse = defaultdict(list)
    for h in horses:
        if h["horse_id"]:
            by_horse[h["horse_id"]].append(h)
    for hs in by_horse.values():
        hs.sort(key=lambda x: (x["date"], x["race_id"]))
        prev = None
        for h in hs:
            h["prev"] = prev
            prev = h
    for h in horses:
        h.setdefault("prev", None)


def stats(rows: list[dict]):
    n = len(rows)
    if n == 0:
        return None
    return {
        "n": n,
        "win": 100 * sum(r["win"] for r in rows) / n,
        "place": 100 * sum(r["place"] for r in rows) / n,
        "win_roi": sum(r["win_ret"] for r in rows) / n,  # 100円あたり払戻 → %
        "place_roi": sum(r["place_ret"] for r in rows) / n,
    }


def fmt(v, n, digits=1):
    return "-" if v is None or n < MIN_N else f"{v:.{digits}f}"


class Report:
    def __init__(self):
        self.lines: list[str] = []

    def h(self, text: str):
        self.lines += ["", f"## {text}", ""]

    def p(self, text: str):
        self.lines.append(text)

    def table(self, header: list[str], rows: list[list]):
        self.lines.append("| " + " | ".join(header) + " |")
        self.lines.append("|" + "|".join("---" for _ in header) + "|")
        for r in rows:
            self.lines.append("| " + " | ".join(str(x) for x in r) + " |")

    def text(self):
        return "\n".join(self.lines) + "\n"


def group_table(rep: Report, horses, key_fn, order, label, half_of, metric="win"):
    """key_fn で分けた各グループの成績表（前半/後半の再現性つき）。"""
    groups = defaultdict(list)
    for h in horses:
        k = key_fn(h)
        if k is not None:
            groups[k].append(h)
    mname = "勝率" if metric == "win" else "複勝率"
    rows = []
    for k in order(groups):
        s = stats(groups[k])
        if not s:
            continue
        a = stats([h for h in groups[k] if half_of(h) == 0])
        b = stats([h for h in groups[k] if half_of(h) == 1])
        rows.append([
            k, s["n"], fmt(s["win"], s["n"]), fmt(s["place"], s["n"]),
            fmt(s["win_roi"], s["n"], 0), fmt(s["place_roi"], s["n"], 0),
            fmt(a[metric] if a else None, a["n"] if a else 0),
            fmt(b[metric] if b else None, b["n"] if b else 0),
        ])
    rep.table([label, "頭数", "勝率%", "複勝率%", "単回収%", "複回収%",
               f"{mname}(前半)", f"{mname}(後半)"], rows)


def bucket(v, edges: list[tuple[int, int, str]]):
    if v is None:
        return None
    for lo, hi, name in edges:
        if lo <= v <= hi:
            return name
    return None


def main() -> None:
    ap = argparse.ArgumentParser(description="地方競馬の基礎傾向を集計する")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help="collect.py の保存先")
    ap.add_argument("--venues", help="競馬場を絞る（例: 南関東 / 大井,川崎）")
    args = ap.parse_args()
    if not (args.out / "results.csv").exists():
        sys.exit(f"{args.out / 'results.csv'} がありません。先に collect.py を実行してください。")

    horses = load(args.out, resolve_venues(args.venues, include_banei=False))
    if not horses:
        sys.exit("対象データがありません。")
    add_prev_features(horses)
    dates = sorted({h["date"] for h in horses})
    if len(dates) < 2:
        sys.exit("前半・後半に分けるため、2日分以上のデータが必要です。")
    k = len(dates) // 2
    mid = dates[k]
    half_of = lambda h: 0 if h["date"] < mid else 1  # noqa: E731
    venues_present = [v for v in VENUES.values() if any(h["venue"] == v for h in horses)]
    by_venue_order = lambda g: [v for v in venues_present if v in g]  # noqa: E731

    rep = Report()
    rep.p("# 地方競馬 基礎傾向レポート")
    rep.p("")
    rep.p(f"- 期間: {dates[0]} 〜 {dates[-1]}（開催日数で二分。前半: {dates[0]}〜{dates[k - 1]} / "
          f"後半: {mid}〜{dates[-1]}）")
    rep.p(f"- 出走頭数: {len(horses):,}頭 / {len({h['race_id'] for h in horses}):,}レース")
    rep.p(f"- 頭数{MIN_N}未満のセルは「-」。回収率は100円あたりの払戻（単勝・複勝の実配当）")

    rep.h("1. 競馬場別のデータ量")
    rows = []
    for v in venues_present:
        hs = [h for h in horses if h["venue"] == v]
        ds = sorted({h["date"] for h in hs})
        rows.append([v, len({h["race_id"] for h in hs}), len(hs), f"{ds[0]}〜{ds[-1]}"])
    rep.table(["競馬場", "レース", "頭数", "期間"], rows)

    rep.h("2. 人気別の成績（全場）")
    pop_edges = [(1, 1, "1番人気"), (2, 2, "2番人気"), (3, 3, "3番人気"), (4, 5, "4-5番人気"),
                 (6, 9, "6-9番人気"), (10, 99, "10番人気以下")]
    group_table(rep, horses, lambda h: bucket(h["pop"], pop_edges),
                lambda g: [e[2] for e in pop_edges if e[2] in g], "人気", half_of)

    rep.h("3. 競馬場別の1番人気")
    rep.p("中央より1番人気が強いと言われる地方の「人気の信頼度」を競馬場ごとに確認する。")
    rep.p("")
    group_table(rep, [h for h in horses if h["pop"] == 1], lambda h: h["venue"],
                by_venue_order, "競馬場", half_of)

    rep.h("4. 4角位置別の成績（先行有利度・レース後の情報）")
    rep.p("レース後にしか分からない情報だが、競馬場ごとに「前にいることの価値」がどれだけ違うかの物差しになる。"
          "下の5・6が、これをレース前に予測するための指標。")
    rep.p("")
    corner_edges = [(1, 1, "4角先頭"), (2, 3, "4角2-3番手"), (4, 6, "4角4-6番手"), (7, 99, "4角7番手以下")]
    for v in venues_present:
        hs = [h for h in horses if h["venue"] == v]
        rep.p(f"**{v}**")
        rep.p("")
        group_table(rep, hs, lambda h: bucket(h["corner_last"], corner_edges),
                    lambda g: [e[2] for e in corner_edges if e[2] in g], "4角位置", half_of, metric="place")
        rep.p("")

    rep.h("5. 前走の4角位置（先行力）別の今走成績")
    rep.p("前走＝収集データ内の同じ馬の直前のレース。前走なし＝初出走・中央/他地区からの転入初戦・収集期間外。")
    rep.p("")
    prev_corner = lambda h: ("前走なし" if h["prev"] is None  # noqa: E731
                             else bucket(h["prev"]["corner_last"], corner_edges))
    order_pc = lambda g: [k for k in ["前走なし"] + [e[2] for e in corner_edges] if k in g]  # noqa: E731
    for v in venues_present:
        rep.p(f"**{v}**")
        rep.p("")
        group_table(rep, [h for h in horses if h["venue"] == v], prev_corner, order_pc,
                    "前走4角", half_of, metric="place")
        rep.p("")

    rep.h("6. 前走着順・前走上がり順位別の今走成績（全場）")
    fin_edges = [(1, 1, "前走1着"), (2, 3, "前走2-3着"), (4, 5, "前走4-5着"), (6, 99, "前走6着以下")]
    group_table(rep, horses,
                lambda h: "前走なし" if h["prev"] is None else bucket(h["prev"]["pos"], fin_edges),
                lambda g: [k for k in ["前走なし"] + [e[2] for e in fin_edges] if k in g],
                "前走着順", half_of)
    rep.p("")
    l3_edges = [(1, 1, "前走上がり1位"), (2, 3, "前走上がり2-3位"), (4, 99, "前走上がり4位以下")]
    group_table(rep, horses,
                lambda h: None if h["prev"] is None else bucket(h["prev"]["l3f_rank"], l3_edges),
                lambda g: [e[2] for e in l3_edges if e[2] in g], "前走上がり", half_of)

    rep.h("7. 枠番別の成績（競馬場別・複勝率）")
    frame_edges = [(1, 2, "1-2枠"), (3, 4, "3-4枠"), (5, 6, "5-6枠"), (7, 8, "7-8枠")]
    rows = []
    for v in venues_present:
        hs = [h for h in horses if h["venue"] == v]
        row = [v]
        for lo, hi, _ in frame_edges:
            g = [h for h in hs if lo <= h["frame"] <= hi]
            s = stats(g)
            a = stats([h for h in g if half_of(h) == 0])
            b = stats([h for h in g if half_of(h) == 1])
            row.append("-" if not s or s["n"] < MIN_N else
                       f"{s['place']:.1f}（{fmt(a['place'] if a else None, a['n'] if a else 0)}/"
                       f"{fmt(b['place'] if b else None, b['n'] if b else 0)}）")
        rows.append(row)
    rep.table(["競馬場"] + [f"{e[2]} 複勝率（前半/後半）" for e in frame_edges], rows)
    rep.p("")
    rep.p("※枠の有利不利は距離（コース）で大きく変わるので、傾向が見えたら競馬場×距離で掘り下げる。")

    rep.h("8. 騎手（騎乗数上位20名）")
    jk = defaultdict(list)
    for h in horses:
        jk[h["jockey"]].append(h)  # 騎手IDでまとめる（減量記号の有無で別人扱いにしない）
    top = sorted(jk, key=lambda j: -len(jk[j]))[:20]
    names = {j: jk[j][-1]["jockey_name"] for j in top}
    group_table(rep, horses, lambda h: names.get(h["jockey"]),
                lambda g: [names[j] for j in top if names[j] in g], "騎手", half_of)

    text = rep.text()
    rdir = args.out / "reports"
    rdir.mkdir(parents=True, exist_ok=True)
    path = rdir / "baseline.md"
    path.write_text(text, encoding="utf-8")
    print(text)
    print(f"保存: {path}")


if __name__ == "__main__":
    main()
