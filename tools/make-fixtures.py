#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""tools/make-fixtures.py — 生成 fixtures/images/look1..4.jpg（SPEC §6.1）

- 390x520 JPEG，纯色背景 + 简单形状（模拟一张穿搭照），体积 < 20KB。
- 幂等：同一次运行输出完全一致（不依赖随机数、不依赖时间），重复执行不会改动文件内容。
- 必须用 DSH 自带 python（系统 python 没有 Pillow）：
      C:\\Users\\34872\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe
   用法：<python> tools/make-fixtures.py
- stdout 只输出 ASCII（本机控制台 GBK）。
"""

import io
import os
import sys

from PIL import Image, ImageDraw

W, H = 390, 520
QUALITY = 72
MAX_BYTES = 20 * 1024

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(os.path.dirname(HERE), "fixtures", "images")

# 每套：背景色 / 上衣 / 下装 / 鞋 / 肤色 / 头发
LOOKS = [
    dict(  # look1 通勤：浅蓝衬衫 + 深灰西裤 + 白鞋
        name="look1",
        bg=(233, 238, 245),
        top=(150, 187, 224),
        bottom=(78, 84, 96),
        shoe=(246, 246, 244),
        skin=(233, 200, 176),
        hair=(58, 44, 38),
        accent=(122, 92, 62),
    ),
    dict(  # look2 温柔甜美：米白针织 + 浅粉长裙 + 米色鞋
        name="look2",
        bg=(247, 240, 236),
        top=(242, 233, 220),
        bottom=(232, 186, 190),
        shoe=(214, 194, 170),
        skin=(238, 208, 186),
        hair=(74, 52, 42),
        accent=(226, 214, 222),
    ),
    dict(  # look3 酷飒：黑皮衣 + 深蓝牛仔 + 黑靴
        name="look3",
        bg=(226, 228, 232),
        top=(46, 48, 54),
        bottom=(62, 82, 118),
        shoe=(38, 38, 42),
        skin=(229, 196, 172),
        hair=(32, 30, 34),
        accent=(150, 152, 158),
    ),
    dict(  # look4 元气：亮黄短卫衣 + 浅蓝阔腿 + 白老爹鞋
        name="look4",
        bg=(240, 244, 232),
        top=(243, 200, 66),
        bottom=(150, 182, 216),
        shoe=(248, 248, 246),
        skin=(236, 202, 178),
        hair=(70, 50, 40),
        accent=(232, 122, 106),
    ),
]


def rect(d, box, fill, outline=None, width=1):
    d.rectangle(box, fill=fill, outline=outline, width=width)


def draw_look(cfg, idx):
    img = Image.new("RGB", (W, H), cfg["bg"])
    d = ImageDraw.Draw(img)

    # 背景：一条竖向色块 + 地面线，模拟室内墙面与地板
    rect(d, (0, 0, W, 300), cfg["bg"])
    floor = tuple(max(0, c - 18) for c in cfg["bg"])
    rect(d, (0, 300, W, H), floor)
    rect(d, (0, 298, W, 302), tuple(max(0, c - 40) for c in cfg["bg"]))

    cx = W // 2

    # 头 + 头发
    head_r = 34
    d.ellipse((cx - head_r, 58, cx + head_r, 58 + head_r * 2), fill=cfg["skin"])
    d.pieslice((cx - head_r - 3, 52, cx + head_r + 3, 58 + head_r * 2 + 6), 180, 360, fill=cfg["hair"])

    # 脖子
    rect(d, (cx - 10, 120, cx + 10, 142), cfg["skin"])

    # 上衣（略有宽窄差异，模拟版型）
    top_w = [64, 70, 60, 74][idx]
    rect(d, (cx - top_w, 138, cx + top_w, 264), cfg["top"])
    # 袖子
    rect(d, (cx - top_w - 26, 142, cx - top_w + 2, 236), cfg["top"])
    rect(d, (cx + top_w - 2, 142, cx + top_w + 26, 236), cfg["top"])

    # 下装
    bottom_w = [78, 88, 70, 96][idx]
    rect(d, (cx - bottom_w, 262, cx + bottom_w, 402), cfg["bottom"])
    if idx == 1:
        # 长裙：向外扩的梯形
        d.polygon(
            [(cx - bottom_w, 262), (cx + bottom_w, 262), (cx + bottom_w + 34, 412), (cx - bottom_w - 34, 412)],
            fill=cfg["bottom"],
        )
    else:
        rect(d, (cx - 6, 262, cx + 6, 402), tuple(max(0, c - 22) for c in cfg["bottom"]))

    # 腰带 / 配饰
    rect(d, (cx - bottom_w - 2, 256, cx + bottom_w + 2, 268), cfg["accent"])

    # 鞋
    rect(d, (cx - bottom_w - 4, 404, cx - 8, 434), cfg["shoe"])
    rect(d, (cx + 8, 404, cx + bottom_w + 4, 434), cfg["shoe"])

    # 手部小色块（肤色）
    d.ellipse((cx - top_w - 34, 232, cx - top_w - 4, 262), fill=cfg["skin"])
    d.ellipse((cx + top_w + 4, 232, cx + top_w + 34, 262), fill=cfg["skin"])

    # 左下角编号条（纯色，便于人工核对是哪一套）
    rect(d, (0, H - 14, 46, H), cfg["accent"])
    return img


def encode(img):
    """固定编码参数 → 输出字节稳定（幂等）"""
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=QUALITY, optimize=True, progressive=False, subsampling=2)
    return buf.getvalue()


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    total = 0
    for idx, cfg in enumerate(LOOKS):
        img = draw_look(cfg, idx)
        data = encode(img)
        while len(data) > MAX_BYTES and QUALITY > 40:
            # 极端情况下（理论上到不了）降质量重编码，保证 < 20KB
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=QUALITY - 8, optimize=True)
            data = buf.getvalue()
        path = os.path.join(OUT_DIR, cfg["name"] + ".jpg")
        old = None
        if os.path.exists(path):
            with open(path, "rb") as fh:
                old = fh.read()
        if old != data:
            with open(path, "wb") as fh:
                fh.write(data)
        total += len(data)
        sys.stdout.write(
            "%s %dx%d %d bytes %s\n"
            % (cfg["name"] + ".jpg", W, H, len(data), "unchanged" if old == data else "written")
        )
    sys.stdout.write("total %d bytes -> %s\n" % (total, OUT_DIR))


if __name__ == "__main__":
    main()
