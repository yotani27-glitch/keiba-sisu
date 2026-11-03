#!/usr/bin/env python3
"""地方版の優先指数を作って検証するツール（collect.py で集めた結果を使う）。

    python index_model.py --venues 南関東

中央の優先指数と同じ考え方で作る:
  1. レース前に分かる指標（近走のスピード・先行力・上がり、騎手・調教師の成績など）を
     レース内で順位化する（1＝そのレースで一番良い、0＝一番悪い、データなし＝0.5）
  2. 条件付きロジット（レース内で勝ち馬→2着馬→3着馬を順に選ぶモデル）で重みを推定する
  3. 古い期間で推定した重みを、新しい期間（検証期間）にそのまま当てはめて成績を見る

さらに「人気（単勝オッズ）にこの指数を足すと予測が良くなるか」も確かめる。
良くならなければ、指数の情報はすでにオッズに織り込まれていて、買い方で儲ける余地は小さい。

結果は画面表示に加えて nar_data/reports/index_model.md と index_weights.json に保存する。
Python 3.8以上・標準ライブラリのみ。
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.dont_write_bytecode = True  # 置き場所（OneDrive等）に __pycache__ フォルダを作らない
sys.path.insert(0, str(Path(__file__).resolve().parent))
from collect import DEFAULT_OUT, resolve_venues, VENUES  # noqa: E402
from baseline import Report  # noqa: E402

PRIOR_N = 50        # 騎手・調教師の成績を全体平均へ寄せる強さ（騎乗数50回分）
LAYOFF_DAYS = 90    # これ以上あいたら「休養明け」
SHORT_REST_DAYS = 14
MARGIN_CAP = 3.0    # 前走着差（秒）の上限。大敗の差は同じ扱いにする


# ───────────────────────── 読み込み ─────────────────────────

def class_group(text: str) -> str:
    m = re.search(r"([ABC])(\d)", text)
    if m:
        return m.group(1) + m.group(2)
    for key in ("2歳", "3歳"):
        if key in text:
            return key
    return "OP"


def load(out: Path, venue_codes: set[str]):
    names = {VENUES[c] for c in venue_codes}
    with open(out / "races.csv", encoding="utf-8-sig") as f:
        races = {r["race_id"]: r for r in csv.DictReader(f) if r["venue"] in names}
    pay = defaultdict(int)
    with open(out / "payouts.csv", encoding="utf-8-sig") as f:
        for p in csv.DictReader(f):
            if p["race_id"] in races and p["bet_type"] in ("単勝", "複勝") and p["payout"]:
                pay[(p["race_id"], p["bet_type"], p["combination"])] += int(p["payout"])
    by_race = defaultdict(list)
    with open(out / "results.csv", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            if r["race_id"] not in races or r["finish"] in ("取消", "除外") or not r["horse_no"]:
                continue
            ri = races[r["race_id"]]
            pos = int(r["finish_pos"]) if r["finish_pos"] else None
            h = {
                "race_id": r["race_id"], "date": r["date"], "venue": r["venue"],
                "course": (r["venue"], r["surface"], int(r["distance"] or 0)),
                "dist": int(r["distance"] or 0), "going": r["going"], "cls": class_group(ri["class"]),
                "horse_id": r["horse_id"], "horse_no": int(r["horse_no"]),
                "jockey": r["jockey_id"] or r["jockey"], "trainer": r["trainer_id"] or r["trainer"],
                "weight": float(r["carried_weight"]) if r["carried_weight"] else None,
                "bw": int(r["body_weight"]) if r["body_weight"] else None,
                "pos": pos, "time": float(r["time_sec"]) if r["time_sec"] else None,
                "last3f": float(r["last3f"]) if r["last3f"] else None,
                "corner_last": int(r["corner_last"]) if r["corner_last"] else None,
                "odds": float(r["win_odds"]) if r["win_odds"] else None,
                "pop": int(r["popularity"]) if r["popularity"] else None,
            }
            h["win"] = pos == 1
            h["place"] = pos is not None and pos <= 3
            h["win_ret"] = pay.get((r["race_id"], "単勝", r["horse_no"]), 0) if h["win"] else 0
            h["place_ret"] = pay.get((r["race_id"], "複勝", r["horse_no"]), 0) if h["place"] else 0
            by_race[r["race_id"]].append(h)
    return {rid: hs for rid, hs in by_race.items() if len(hs) >= 2}


# ───────────────────────── スピード指数 ─────────────────────────

def fit_speed(by_race: dict, train_dates: set[str]):
    """勝ち時計（1000mあたり秒）を「コース＋クラス＋その日の馬場」に分解する。
    コースとクラスの基準は学習期間だけで決め、馬場差（日・場・馬場状態ごと）は全期間で求める。
    馬のスピード指数 = コース基準 + 当日の馬場差 − その馬の1000mあたりの時計（大きいほど速い）"""
    obs = []
    for hs in by_race.values():
        w = [h for h in hs if h["pos"] == 1 and h["time"] and h["dist"]]
        if w:
            h = w[0]
            obs.append((h["course"], h["cls"], (h["date"], h["venue"], h["going"]),
                        h["time"] / h["dist"] * 1000, h["date"] in train_dates))
    course, cls, day = defaultdict(float), defaultdict(float), defaultdict(float)
    for _ in range(15):  # 交互に平均を取り直す（バックフィッティング）
        acc = defaultdict(lambda: [0.0, 0])
        for c, k, d, y, tr in obs:
            if tr:
                a = acc[c]; a[0] += y - cls[k] - day[d]; a[1] += 1
        course = defaultdict(float, {c: s / n for c, (s, n) in acc.items()})
        acc = defaultdict(lambda: [0.0, 0])
        for c, k, d, y, tr in obs:
            if tr and c in course:
                a = acc[k]; a[0] += y - course[c] - day[d]; a[1] += 1
        cls = defaultdict(float, {k: s / (n + 3) for k, (s, n) in acc.items()})
        acc = defaultdict(lambda: [0.0, 0])
        for c, k, d, y, tr in obs:
            if c in course:
                a = acc[d]; a[0] += y - course[c] - cls[k]; a[1] += 1
        day = defaultdict(float, {d: s / (n + 1) for d, (s, n) in acc.items()})  # 1レース分だけ0へ寄せる
    for hs in by_race.values():
        for h in hs:
            c, d = h["course"], (h["date"], h["venue"], h["going"])
            h["fig"] = (course[c] + day[d] - h["time"] / h["dist"] * 1000
                        if h["time"] and h["dist"] and c in course else None)


# ───────────────────────── レース前に分かる特徴 ─────────────────────────

def add_history(by_race: dict) -> None:
    """各馬の近走（収集データ内・前日まで）と、騎手・調教師の前日までの成績を付ける。"""
    for hs in by_race.values():
        n = len(hs)
        win_time = min((h["time"] for h in hs if h["pos"] == 1 and h["time"]), default=None)
        l3 = sorted(h["last3f"] for h in hs if h["last3f"] is not None)
        for h in hs:
            h["corner_ratio"] = (h["corner_last"] - 1) / (n - 1) if h["corner_last"] else None
            h["l3f_ratio"] = (l3.index(h["last3f"]) / (len(l3) - 1)
                              if h["last3f"] is not None and len(l3) > 1 else None)
            h["margin"] = (min(h["time"] - win_time, MARGIN_CAP)
                           if h["time"] is not None and win_time is not None else None)

    all_h = [h for hs in by_race.values() for h in hs]
    by_horse = defaultdict(list)
    for h in all_h:
        if h["horse_id"]:
            by_horse[h["horse_id"]].append(h)
    for runs in by_horse.values():
        runs.sort(key=lambda x: (x["date"], x["race_id"]))
        for i, h in enumerate(runs):
            past = [r for r in runs[:i] if r["date"] < h["date"]][-3:]
            h["n_prev"] = len(past)
            last = past[-1] if past else None
            figs = [r["fig"] for r in past if r["fig"] is not None]
            cor = [r["corner_ratio"] for r in past if r["corner_ratio"] is not None]
            l3 = [r["l3f_ratio"] for r in past if r["l3f_ratio"] is not None]
            h["spd_best3"] = max(figs) if figs else None
            h["corner_avg3"] = sum(cor) / len(cor) if cor else None
            h["l3f_avg3"] = sum(l3) / len(l3) if l3 else None
            h["margin_last"] = last["margin"] if last else None
            h["days"] = ((dt.date.fromisoformat(h["date"]) - dt.date.fromisoformat(last["date"])).days
                         if last else None)
            h["new_venue"] = bool(past) and all(r["venue"] != h["venue"] for r in runs[:i])
    for h in all_h:
        for k in ("spd_best3", "corner_avg3", "l3f_avg3", "margin_last", "days"):
            h.setdefault(k, None)
        h.setdefault("n_prev", 0)
        h.setdefault("new_venue", False)

    # 騎手・調教師: 前日までの複勝率（騎乗数が少ないうちは全体平均に寄せる）
    p0 = sum(h["place"] for h in all_h) / len(all_h)
    for key in ("jockey", "trainer"):
        cnt = defaultdict(lambda: [0, 0])
        by_date = defaultdict(list)
        for h in all_h:
            by_date[h["date"]].append(h)
        for date in sorted(by_date):
            for h in by_date[date]:
                n, p = cnt[h[key]]
                h[key + "_rate"] = (p + PRIOR_N * p0) / (n + PRIOR_N)
            for h in by_date[date]:
                c = cnt[h[key]]; c[0] += 1; c[1] += h["place"]


def rank01(vals, higher_better=True):
    """レース内の順位を0〜1に（1＝一番良い）。データなしは0.5、同値は平均順位。"""
    idx = [i for i, v in enumerate(vals) if v is not None]
    out = [0.5] * len(vals)
    if len(idx) < 2:
        return out
    idx.sort(key=lambda i: -vals[i] if higher_better else vals[i])
    m = len(idx)
    i = 0
    while i < m:
        j = i
        while j + 1 < m and vals[idx[j + 1]] == vals[idx[i]]:
            j += 1
        score = 1 - ((i + j) / 2) / (m - 1)
        for k in range(i, j + 1):
            out[idx[k]] = score
        i = j + 1
    return out


def feature_names(venues: list[str]) -> list[str]:
    return (["スピード（近3走最高）", "上がり（近3走平均）", "前走着差", "騎手（複勝率）", "調教師（複勝率）",
             "斤量（重いほど1）", "馬体重（重いほど1）", "前走なし", "休養明け（90日以上）",
             "中1週以内", "初めての競馬場"]
            + [f"先行力・{v}" for v in venues] + [f"内枠・{v}" for v in venues])


def race_matrix(hs: list[dict], venues: list[str]) -> list[list[float]]:
    zeros = [0.0] * len(hs)
    cols = [
        rank01([h["spd_best3"] for h in hs]),
        rank01([h["l3f_avg3"] for h in hs], higher_better=False),
        rank01([h["margin_last"] for h in hs], higher_better=False),
        rank01([h["jockey_rate"] for h in hs]),
        rank01([h["trainer_rate"] for h in hs]),
        rank01([h["weight"] for h in hs]),
        rank01([h["bw"] for h in hs]),
        [1.0 if h["n_prev"] == 0 else 0.0 for h in hs],
        [1.0 if h["days"] is not None and h["days"] >= LAYOFF_DAYS else 0.0 for h in hs],
        [1.0 if h["days"] is not None and h["days"] <= SHORT_REST_DAYS else 0.0 for h in hs],
        [1.0 if h["new_venue"] else 0.0 for h in hs],
    ]
    front = rank01([h["corner_avg3"] for h in hs], higher_better=False)
    inner = rank01([h["horse_no"] for h in hs], higher_better=False)
    v0 = hs[0]["venue"]
    cols += [front if v == v0 else zeros for v in venues]
    cols += [inner if v == v0 else zeros for v in venues]
    return [list(row) for row in zip(*cols)]


# ───────────────────────── 条件付きロジット ─────────────────────────

def solve(a: list[list[float]], b: list[float]) -> list[float]:
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(m[r][c]))
        m[c], m[p] = m[p], m[c]
        piv = m[c][c]
        for r in range(n):
            if r != c and m[r][c]:
                f = m[r][c] / piv
                m[r] = [x - f * y for x, y in zip(m[r], m[c])]
    return [m[i][n] / m[i][i] for i in range(n)]


def inverse(a: list[list[float]]) -> list[list[float]]:
    n = len(a)
    cols = [solve(a, [1.0 if i == j else 0.0 for i in range(n)]) for j in range(n)]
    return [[cols[j][i] for j in range(n)] for i in range(n)]


def fit_clogit(groups, d: int, ridge: float = 1.0, max_iter: int = 30):
    """groups: [(X, 選ばれた順の馬のindexリスト)]。ニュートン法で最尤推定（弱いリッジ付き）。"""
    beta = [0.0] * d
    prepared = []
    for X, seq in groups:  # レース内で全馬0の特徴（他場の先行力・内枠など）は計算から外す
        act = [k for k in range(d) if any(row[k] for row in X)]
        prepared.append(([[row[k] for k in act] for row in X], seq, act))
    ll = 0.0
    for _ in range(max_iter):
        ll = -ridge / 2 * sum(b * b for b in beta)
        g = [-ridge * b for b in beta]
        H = [[ridge if i == j else 0.0 for j in range(d)] for i in range(d)]
        for X, seq, act in prepared:
            bl = [beta[k] for k in act]
            s_all = [sum(b * x for b, x in zip(bl, row)) for row in X]
            alive = list(range(len(X)))
            na = len(act)
            for c in seq:
                s = [s_all[j] for j in alive]
                mx = max(s)
                e = [math.exp(v - mx) for v in s]
                z = sum(e)
                ll += s_all[c] - mx - math.log(z)
                p = [v / z for v in e]
                xbar = [sum(p[t] * X[j][a] for t, j in enumerate(alive)) for a in range(na)]
                for a in range(na):
                    g[act[a]] += X[c][a] - xbar[a]
                for a in range(na):
                    ha = H[act[a]]
                    for b2 in range(a, na):
                        v = sum(p[t] * X[j][a] * X[j][b2] for t, j in enumerate(alive)) - xbar[a] * xbar[b2]
                        ha[act[b2]] += v
                alive.remove(c)
        for i in range(d):
            for j in range(i):
                H[i][j] = H[j][i]
        step = solve(H, g)
        beta = [b + s for b, s in zip(beta, step)]
        if max(abs(s) for s in step) < 1e-6:
            break
    cov = inverse(H)
    return beta, [math.sqrt(max(cov[i][i], 0.0)) for i in range(d)], ll


# ───────────────────────── 評価 ─────────────────────────

def softmax(scores):
    mx = max(scores)
    e = [math.exp(s - mx) for s in scores]
    z = sum(e)
    return [v / z for v in e]


def market_prob(hs):
    inv = [1 / h["odds"] if h["odds"] else 0.0 for h in hs]
    z = sum(inv)
    return [v / z for v in inv] if z else None


def pct(a, n):
    return f"{100 * a / n:.1f}" if n else "-"


def eval_top(races: list[tuple[list[dict], list[float]]]):
    """スコア1位の馬の成績と、上位3頭に勝ち馬が入る率。"""
    n = win = place = wret = pret = top3 = 0
    for hs, sc in races:
        order = sorted(range(len(hs)), key=lambda i: (-sc[i], hs[i]["horse_no"]))
        h = hs[order[0]]
        n += 1
        win += h["win"]; place += h["place"]; wret += h["win_ret"]; pret += h["place_ret"]
        top3 += any(hs[i]["win"] for i in order[:3])
    return n, win, place, wret, pret, top3


def top_row(label, races):
    n, win, place, wret, pret, top3 = eval_top(races)
    return [label, n, pct(win, n), pct(place, n), f"{wret / n:.0f}" if n else "-",
            f"{pret / n:.0f}" if n else "-", pct(top3, n)]


def main() -> None:
    ap = argparse.ArgumentParser(description="地方版の優先指数を作って検証する")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help="collect.py の保存先")
    ap.add_argument("--venues", default="南関東", help="競馬場（既定: 南関東）")
    ap.add_argument("--warmup", type=int, default=90,
                    help="最初の何日分を「近走・騎手成績の材料」専用にして学習・検証に使わないか（既定90日）")
    ap.add_argument("--test-from", help="検証期間の開始日（YYYYMMDD）。省略時は残りの期間の後半")
    args = ap.parse_args()
    if not (args.out / "results.csv").exists():
        sys.exit(f"{args.out / 'results.csv'} がありません。先に collect.py を実行してください。")

    vcodes = resolve_venues(args.venues, include_banei=False)
    by_race = load(args.out, vcodes)
    if not by_race:
        sys.exit("対象データがありません。")
    venues = [VENUES[c] for c in sorted(vcodes) if any(hs[0]["venue"] == VENUES[c] for hs in by_race.values())]
    dates = sorted({hs[0]["date"] for hs in by_race.values()})
    start = dt.date.fromisoformat(dates[0]) + dt.timedelta(days=args.warmup)
    usable = [d for d in dates if dt.date.fromisoformat(d) >= start]
    if len(usable) < 20:
        sys.exit(f"学習・検証に使える開催日が足りません（{len(usable)}日）。データを増やすか --warmup を小さくしてください。")
    if args.test_from:
        t = args.test_from
        test_from = f"{t[:4]}-{t[4:6]}-{t[6:]}"
    else:
        test_from = usable[len(usable) // 2]
    train_dates = {d for d in usable if d < test_from}
    test_dates = {d for d in usable if d >= test_from}

    fit_speed(by_race, train_dates)
    add_history(by_race)
    names = feature_names(venues)
    d = len(names)

    train, test = [], []
    for rid in sorted(by_race):
        hs = by_race[rid]
        date = hs[0]["date"]
        if date not in train_dates and date not in test_dates:
            continue
        X = race_matrix(hs, venues)
        fin = sorted((h["pos"], i) for i, h in enumerate(hs) if h["pos"] is not None)
        seq = [i for p, i in fin if p <= 3]
        if not seq or seq[0] != next((i for i, h in enumerate(hs) if h["pos"] == 1), None):
            continue
        (train if date in train_dates else test).append((hs, X, seq))

    print(f"学習: {len(train)}レース / 検証: {len(test)}レース。重みを推定しています…", flush=True)
    beta, se, _ = fit_clogit([(X, seq) for _, X, seq in train], d)

    # オッズに指数を足すと良くなるか（勝ち馬だけで推定。オッズは確定オッズ）
    def with_market(rows):
        out = []
        for hs, X, seq in rows:
            q = market_prob(hs)
            if q and all(v > 0 for v in q):
                out.append((hs, X, seq, q))
        return out
    tr_m, te_m = with_market(train), with_market(test)
    beta_m, _, _ = fit_clogit([([[math.log(v)] for v in q], seq[:1]) for _, _, seq, q in tr_m], 1)
    beta_c, se_c, _ = fit_clogit([([[math.log(v)] + row for v, row in zip(q, X)], seq[:1])
                                  for _, X, seq, q in tr_m], d + 1)

    def ll_win(rows, fn):
        tot = 0.0
        for hs, X, seq, q in rows:
            p = fn(hs, X, q)
            tot += math.log(max(p[seq[0]], 1e-12))
        return tot / len(rows)

    def p_index(hs, X, q):
        return softmax([sum(b * x for b, x in zip(beta, row)) for row in X])

    def p_market(hs, X, q):
        return softmax([beta_m[0] * math.log(v) for v in q])

    def p_comb(hs, X, q):
        return softmax([beta_c[0] * math.log(v) + sum(b * x for b, x in zip(beta_c[1:], row))
                        for v, row in zip(q, X)])

    # ───── レポート ─────
    rep = Report()
    rep.p("# 地方版 優先指数の検証")
    rep.p("")
    tr_d, te_d = sorted(train_dates), sorted(test_dates)
    rep.p(f"- 対象: {'・'.join(venues)}")
    rep.p(f"- 材料のみ（学習・検証に使わない）: {dates[0]}〜{usable[0]}の手前")
    rep.p(f"- 学習期間: {tr_d[0]}〜{tr_d[-1]}（{len(train):,}レース） / "
          f"検証期間: {te_d[0]}〜{te_d[-1]}（{len(test):,}レース）")
    rep.p("- 近走＝収集データ内の前日までのレース（中央・他地区の成績は入っていない）")
    rep.p("- 回収率は100円あたりの実配当（%）。オッズは確定オッズなので、実際に買えるオッズとは少しずれる")

    rep.h("1. 推定した重み（学習期間）")
    rep.p("各指標はレース内で0〜1に順位化（1＝そのレースで一番良い）。前走なし・休養明けなどは該当すれば1。"
          "t値の絶対値が2を超えるものが、偶然ではないと言える目安。")
    rep.p("")
    rows = []
    for nm, b, s in sorted(zip(names, beta, se), key=lambda x: -abs(x[1])):
        rows.append([nm, f"{b:+.2f}", f"{b / s:+.1f}" if s else "-"])
    rep.table(["指標", "重み", "t値"], rows)

    def scored(rows, fn):
        return [(hs, fn(hs, X)) for hs, X, *_ in rows]

    idx_fn = lambda hs, X: [sum(b * x for b, x in zip(beta, row)) for row in X]  # noqa: E731
    pop_fn = lambda hs, X: [-(h["pop"] or 99) for h in hs]  # noqa: E731
    spd_fn = lambda hs, X: [row[0] for row in X]  # noqa: E731

    rep.h("2. 1位の馬の成績（指数・人気・スピード単独の比較）")
    rep.p("「上位3頭に勝ち馬」は、スコア上位3頭（人気なら1〜3番人気）の中に勝ち馬がいた率。")
    rep.p("")
    hdr = ["", "レース", "勝率%", "複勝率%", "単回収%", "複回収%", "上位3頭に勝ち馬%"]
    for label, rows_ in (("学習期間", train), ("検証期間", test)):
        rep.p(f"**{label}**")
        rep.p("")
        rep.table(hdr, [top_row("指数1位", scored(rows_, idx_fn)),
                        top_row("1番人気", scored(rows_, pop_fn)),
                        top_row("スピード1位", scored(rows_, spd_fn))])
        rep.p("")
    half = sorted(test_dates)[len(test_dates) // 2]
    rep.p("**検証期間を前半・後半に分けた指数1位**")
    rep.p("")
    rep.table(hdr, [top_row(f"前半（〜{half}の前日）", scored([r for r in test if r[0][0]["date"] < half], idx_fn)),
                    top_row(f"後半（{half}〜）", scored([r for r in test if r[0][0]["date"] >= half], idx_fn))])

    rep.h("3. 競馬場別（検証期間）")
    rows = []
    for v in venues:
        rs = [r for r in test if r[0][0]["venue"] == v]
        if rs:
            a, b = top_row("", scored(rs, idx_fn)), top_row("", scored(rs, pop_fn))
            rows.append([v, a[1], a[2], b[2], a[3], b[3], a[4], a[5]])
    rep.table(["競馬場", "レース", "指数1位 勝率%", "1番人気 勝率%", "指数1位 複勝率%", "1番人気 複勝率%",
               "指数1位 単回収%", "指数1位 複回収%"], rows)

    rep.h("4. オッズに指数を足すと予測が良くなるか")
    rep.p("勝ち馬の予測の当たり具合（1レースあたりの対数尤度。0に近いほど良い）。"
          "「オッズ＋指数」が「オッズのみ」より良くなれば、指数にオッズに無い情報が含まれている。")
    rep.p("")
    rep.table(["モデル", "学習期間", "検証期間"], [
        ["でたらめ（全馬同じ確率）", f"{sum(-math.log(len(r[0])) for r in tr_m) / len(tr_m):.4f}",
         f"{sum(-math.log(len(r[0])) for r in te_m) / len(te_m):.4f}"],
        ["指数のみ", f"{ll_win(tr_m, p_index):.4f}", f"{ll_win(te_m, p_index):.4f}"],
        ["オッズのみ", f"{ll_win(tr_m, p_market):.4f}", f"{ll_win(te_m, p_market):.4f}"],
        ["オッズ＋指数", f"{ll_win(tr_m, p_comb):.4f}", f"{ll_win(te_m, p_comb):.4f}"],
    ])
    rep.p("")
    rep.p("オッズ＋指数モデルでの各指標の重み（オッズで説明できない部分。t値2超が目安）:")
    rep.p("")
    rows = [["オッズ（log）", f"{beta_c[0]:+.2f}", f"{beta_c[0] / se_c[0]:+.1f}"]]
    for nm, b, s in sorted(zip(names, beta_c[1:], se_c[1:]), key=lambda x: -abs(x[1] / x[2] if x[2] else 0)):
        rows.append([nm, f"{b:+.2f}", f"{b / s:+.1f}" if s else "-"])
    rep.table(["指標", "重み", "t値"], rows)

    rep.h("5. 期待値で単勝を買った場合（検証期間）")
    rep.p("「オッズ＋指数」で出した勝率 × 単勝オッズ が基準以上の馬を買い続けた場合。"
          "確定オッズで判定しているので、実際には締切前のオッズで判断することになり、成績はこれより落ちる。")
    rep.p("")
    rows = []
    halves = [("全体", lambda r: True), ("前半", lambda r: r[0][0]["date"] < half),
              ("後半", lambda r: r[0][0]["date"] >= half)]
    for th in (1.0, 1.2, 1.5):
        row = [f"期待値{th:.1f}以上"]
        for _, cond in halves:
            n = hit = ret = 0
            for r in te_m:
                if not cond(r):
                    continue
                hs, X, seq, q = r
                p = p_comb(hs, X, q)
                for i, h in enumerate(hs):
                    if h["odds"] and p[i] * h["odds"] >= th:
                        n += 1; hit += h["win"]; ret += h["win_ret"]
            row.append(f"{n}点 的中{pct(hit, n)}% 回収{ret / n:.0f}%" if n else "-")
        rows.append(row)
    rep.table(["条件", "全体", "前半", "後半"], rows)

    text = rep.text()
    rdir = args.out / "reports"
    rdir.mkdir(parents=True, exist_ok=True)
    (rdir / "index_model.md").write_text(text, encoding="utf-8")
    (rdir / "index_weights.json").write_text(json.dumps({
        "venues": venues, "train": [tr_d[0], tr_d[-1]], "test": [te_d[0], te_d[-1]],
        "features": names, "beta": beta, "se": se,
        "market_model": {"features": ["log_odds_prob"] + names, "beta": beta_c, "se": se_c},
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(text)
    print(f"保存: {rdir / 'index_model.md'} / {rdir / 'index_weights.json'}")


if __name__ == "__main__":
    main()
