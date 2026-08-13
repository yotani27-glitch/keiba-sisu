# -*- coding: utf-8 -*-
"""
週次の指数データを webapp/data/ に書き出して、iPhoneから見られるようにする

PCで週次ZIPを取り込んでこれを実行し、git push すると、
iPhone側はURLを開くだけで最新データが表示される（ファイル選択が要らない）。

  python publish_data.py                    # 指数フォルダの最新日を書き出す
  python publish_data.py 20260809           # 日付を指定
  python publish_data.py 20260808 20260809  # 複数日まとめて

出力: webapp/data/index.json（日付一覧）と webapp/data/<日付>.json（1日分）

※ このリポジトリは公開されているため、書き出したデータは誰でも取得できる。
   優先指数の計算と表示に使うラベルだけに絞ってある。
"""
import gzip
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).parent
OUT_DIR = ROOT / "webapp" / "data"

# webapp が使うラベルだけ出す（全部入れても動くが、無駄に大きくなる）
KEEP = {
    "7tua",           # Ｆ指数
    "6tua",           # Ｓ指数
    "11tua",          # arms指数２
    "00tua",          # LVL2
    "厩舎Finish-Up",
    "GYN",            # 予想人気順（堅さ判定に使う）
}


def split_line(line: str) -> list[str]:
    return line.split("\t") if "\t" in line else line.split(",")


def read_pairs(text: str) -> list[tuple[str, str]]:
    out = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        parts = split_line(line)
        if len(parts) < 2:
            continue
        key = parts[0].strip()
        if len(key) == 18 and key.isdigit():
            out.append((key, parts[1].strip()))
    return out


def collect(date8: str) -> dict:
    recs: dict[str, dict] = {}

    zip_path = ROOT / "指数フォルダ" / f"2tua{date8}.zip"
    if not zip_path.exists():
        raise SystemExit(f"週次ZIPが見つかりません: {zip_path}")
    with zipfile.ZipFile(zip_path) as z:
        for name in z.namelist():
            label = Path(name).name.replace(f"{date8}.csv", "")
            if label not in KEEP:
                continue
            text = z.read(name).decode("utf-8", errors="replace")
            for key, val in read_pairs(text):
                recs.setdefault(key, {})[label] = val

    # 馬名（別フォルダ）
    name_file = ROOT / "競争馬名" / f"name{date8}.csv"
    if name_file.exists():
        for key, val in read_pairs(name_file.read_text(encoding="utf-8", errors="replace")):
            recs.setdefault(key, {})["name"] = val

    # 厩舎Finish-Up（ファイル名が日付だけなのでフォルダ名がラベル）
    ky_file = ROOT / "厩舎Finish-Up" / f"{date8}.csv"
    if ky_file.exists():
        for key, val in read_pairs(ky_file.read_text(encoding="utf-8", errors="replace")):
            recs.setdefault(key, {})["厩舎Finish-Up"] = val

    return recs


def latest_date() -> str:
    dates = sorted(
        m.group(1)
        for p in (ROOT / "指数フォルダ").glob("2tua*.zip")
        if (m := re.search(r"(\d{8})\.zip$", p.name))
    )
    if not dates:
        raise SystemExit("指数フォルダにZIPが見つかりません")
    return dates[-1]


def main(argv: list[str]) -> int:
    dates = argv[1:] or [latest_date()]
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    written = []
    for date8 in dates:
        recs = collect(date8)
        if not recs:
            print(f"{date8}: データがありません")
            continue
        path = OUT_DIR / f"{date8}.json"
        body = json.dumps(recs, ensure_ascii=False, separators=(",", ":"))
        path.write_text(body, encoding="utf-8")
        has_name = sum(1 for v in recs.values() if "name" in v)
        has_ky = sum(1 for v in recs.values() if "厩舎Finish-Up" in v)
        print(f"{date8}: {len(recs)}頭 / {len(body)/1024:.0f}KB"
              f"（gzip {len(gzip.compress(body.encode()))/1024:.0f}KB）"
              f" 馬名{has_name} 厩舎{has_ky}")
        written.append(date8)

    # 既に置いてある日付も含めて一覧を作り直す
    all_dates = sorted(p.stem for p in OUT_DIR.glob("*.json") if p.stem.isdigit())
    (OUT_DIR / "index.json").write_text(
        json.dumps({"dates": all_dates}, ensure_ascii=False), encoding="utf-8")

    print(f"\n書き出し先: {OUT_DIR}")
    print(f"公開中の日付: {', '.join(all_dates) if all_dates else '(なし)'}")
    if written:
        print("\n次のコマンドで公開されます:")
        print('  git add webapp/data && git commit -m "指数データを更新" && git push')
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
