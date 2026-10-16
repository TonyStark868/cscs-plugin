# -*- coding: utf-8 -*-
"""按书页码 OCR《NSCA-CSCS体能教练认证指南(第4版)》页面的工具（可移植版）。

书 PDF 定位顺序:
  1. --pdf 参数
  2. 环境变量 NSCA_CSCS_PDF
  3. 技能目录下 references/book-path.txt（首行 = PDF 绝对路径）

用法:
  python ocr_pages.py 343              # 单页
  python ocr_pages.py 47 48-50         # 多页 / 范围
  python ocr_pages.py 47 --dpi 220     # 提高识别质量
  python ocr_pages.py 47 --force       # 忽略缓存重新识别

说明:
- 默认页码映射: PDF 页 = 书页 + 14（可用 --offset 覆盖）。
- OCR 结果缓存于 %TEMP%\\nsca-cscs-ocr-cache\\（或 ~/.cache/nsca-cscs-ocr-cache）。
- 依赖: pymupdf, rapidocr-onnxruntime, numpy（见 requirements.txt）。
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import os
import sys
import time
from pathlib import Path

try:  # Windows 控制台兜底，避免生僻字导致 UnicodeEncodeError
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

try:
    import pymupdf
except ImportError:
    sys.stderr.write("缺少依赖 pymupdf。请运行: pip install -r requirements.txt\n")
    raise SystemExit(2)

SKILL_DIR = Path(__file__).resolve().parents[1]
BOOK_PATH_FILE = SKILL_DIR / "references" / "book-path.txt"


def resolve_pdf(cli_path: str | None) -> str | None:
    if cli_path and os.path.exists(cli_path):
        return cli_path
    env = os.getenv("NSCA_CSCS_PDF")
    if env and os.path.exists(env):
        return env
    if BOOK_PATH_FILE.exists():
        first = BOOK_PATH_FILE.read_text(encoding="utf-8-sig").strip().splitlines()
        for line in first:  # 跳过以 # 开头的注释行
            line = line.strip()
            if line and not line.startswith("#"):
                if os.path.exists(line):
                    return line
                sys.stderr.write(
                    f"book-path.txt 中的路径不存在: {line}\n"
                    "请更新 references/book-path.txt 或用 --pdf / NSCA_CSCS_PDF 指定。\n"
                )
                return None
    if cli_path or env:
        sys.stderr.write("配置的书籍路径不存在，请检查后重试。\n")
    else:
        sys.stderr.write(
            "未配置书籍 PDF。三种方式任选：\n"
            "  1) 本命令加 --pdf \"PDF绝对路径\"\n"
            "  2) 设置环境变量 NSCA_CSCS_PDF\n"
            "  3) 在 " + str(BOOK_PATH_FILE) + " 首行写入 PDF 绝对路径\n"
        )
    return None


def parse_pages(items: list[str]) -> list[int]:
    pages: list[int] = []
    for item in items:
        if "-" in item:
            a, b = item.split("-", 1)
            pages.extend(range(int(a), int(b) + 1))
        else:
            pages.append(int(item))
    return pages


def cache_dir() -> str:
    base = os.environ.get("TEMP") or os.environ.get(
        "XDG_CACHE_HOME", str(Path.home() / ".cache")
    )
    path = os.path.join(base, "nsca-cscs-ocr-cache")
    os.makedirs(path, exist_ok=True)
    return path


def ocr_page(doc, book_page: int, offset: int, dpi: int, engine) -> str:
    pdf_index = (book_page - 1) + offset
    if pdf_index < 0 or pdf_index >= doc.page_count:
        return f"(书第{book_page}页超出范围: PDF共{doc.page_count}页)"

    key = hashlib.sha1(f"{book_page}:{dpi}".encode()).hexdigest()[:16]
    cache_file = os.path.join(cache_dir(), f"p{book_page}_d{dpi}_{key}.txt")
    if os.path.exists(cache_file):
        with open(cache_file, encoding="utf-8") as f:
            return f.read()

    import numpy as np

    page = doc[pdf_index]
    pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csRGB)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
        pix.height, pix.width, 3
    )[:, :, ::-1].copy()  # RGB -> BGR，匹配OpenCV习惯

    result, _ = engine(img)
    if not result:
        text = "(OCR未识别到内容，可能是图表页或空白页。可尝试 --force 并提高 --dpi)"
    else:
        text = "\n".join(r[1] for r in result)
    with open(cache_file, "w", encoding="utf-8") as f:
        f.write(text)
    return text


def main() -> int:
    ap = argparse.ArgumentParser(description="按书页码 OCR NSCA-CSCS 指南（可移植版）")
    ap.add_argument("pages", nargs="+", help="书页码，支持范围如 47-50")
    ap.add_argument("--pdf", default=None, help="PDF 绝对路径（优先级最高）")
    ap.add_argument("--offset", type=int, default=14, help="PDF页 = 书页 + offset")
    ap.add_argument("--dpi", type=int, default=200)
    ap.add_argument("--force", action="store_true", help="忽略缓存")
    args = ap.parse_args()

    pdf = resolve_pdf(args.pdf)
    if not pdf:
        return 1

    if args.force:
        for book_page in parse_pages(args.pages):
            for fp in glob.glob(os.path.join(cache_dir(), f"p{book_page}_*")):
                os.remove(fp)

    from rapidocr_onnxruntime import RapidOCR

    engine = RapidOCR()
    doc = pymupdf.open(pdf)

    for book_page in parse_pages(args.pages):
        t0 = time.time()
        text = ocr_page(doc, book_page, args.offset, args.dpi, engine)
        header = f"===== 书第{book_page}页 (PDF第{book_page + args.offset}页) ===="
        print(header)
        print(text)
        print()
        sys.stderr.write(f"[页{book_page} 用时 {time.time() - t0:.1f}s]\n")

    doc.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
