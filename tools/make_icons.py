#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成主题自带的图标产物（hub 1.4.0 面板没设图标时的兜底）。

    preview-src/site-icon.png    源图（512×512，透明底）：一枚手绘五角星 ——
                                 黄标记笔填色、墨线描边、右下角错位的红影子。
                                 由本脚本**程序化画出**（不用外部素材）：顶点位置
                                 带确定性抖动，所以这颗星每次生成都一模一样。
    public/apple-touch-icon.png  iOS 主屏幕图标 —— 180×180、**不透明**（iOS 会把
                                 透明的填黑，所以铺一层纸色底）。
    public/favicon.ico           老浏览器 / 书签管理器不看 <link> 直接来要这条，
                                 多尺寸（16/32/48）。
    public/favicon.svg           手写的矢量版（比位图缩下去清楚）——**不由本脚本生成**，
                                 脚本只核对它还在。

跑法：python tools/make_icons.py [--check]
    --check 只比对（不写盘）。
"""
import io
import math
import os
import random
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
SRC = os.path.join(ROOT, "preview-src", "site-icon.png")
SVG = os.path.join(ROOT, "public", "favicon.svg")
TOUCH = os.path.join(ROOT, "public", "apple-touch-icon.png")
ICO = os.path.join(ROOT, "public", "favicon.ico")

SIZE = 512
TOUCH_PX = 180
# 主屏图标那层底：纸色（与 index.css 的 --paper 同值）。
PAPER = (255, 254, 245, 255)
INK = (44, 44, 44, 255)
YELLOW = (255, 217, 61, 255)
RED = (255, 107, 107, 255)


def star_points(cx, cy, r_out, r_in, jitter, seed):
    """五角星顶点：每枚顶点加一点确定性抖动（手画感），相位 -90°（尖朝上）。"""
    rnd = random.Random(seed)
    pts = []
    for i in range(10):
        r = r_out if i % 2 == 0 else r_in
        a = math.radians(-90 + i * 36)
        pts.append((cx + math.cos(a) * r + rnd.uniform(-jitter, jitter),
                    cy + math.sin(a) * r + rnd.uniform(-jitter, jitter)))
    return pts


def draw_star() -> Image.Image:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    star = star_points(248, 258, 196, 86, 7.0, seed=7)
    # 红影子：错位 +18px（素材的“硬边偏移影子”，不是模糊阴影）。
    d.polygon([(x + 17, y + 19) for x, y in star], fill=RED)
    # 星身：黄标记笔填色。
    d.polygon(star, fill=YELLOW)
    # 墨线描边：闭合折线、圆角接头（joint="curve"），线宽 16。
    d.line(star + [star[0]], fill=INK, width=16, joint="curve")
    # 两个线头（折线首尾重合处）补两枚圆点，让接头看不出接缝。
    for p in (star[0],):
        d.ellipse([p[0] - 8, p[1] - 8, p[0] + 8, p[1] + 8], fill=INK)
    # 左上角一枚白色高光点（像笔尖停过的那一下）。
    d.ellipse([150, 150, 176, 176], fill=(255, 255, 255, 210))
    return img


def touch_png(src: Image.Image) -> bytes:
    # iOS 会把透明区域填黑，所以铺一层纸色底。
    canvas = Image.new("RGBA", (TOUCH_PX, TOUCH_PX), PAPER)
    art = src.convert("RGBA")
    scale = min((TOUCH_PX - 24) / art.width, (TOUCH_PX - 24) / art.height)
    art = art.resize((round(art.width * scale), round(art.height * scale)), Image.LANCZOS)
    canvas.alpha_composite(art, ((TOUCH_PX - art.width) // 2, (TOUCH_PX - art.height) // 2))
    out = io.BytesIO()
    _palette(canvas.convert("RGB")).save(out, "PNG", optimize=True)
    return out.getvalue()


def _palette(img: Image.Image) -> Image.Image:
    """量化成 256 色调色板：源图描边的抗锯齿有一千多色，缩到这两个尺寸看不出差别，
    体积只有 RGBA 的三分之一。不平滑（dither=NONE）—— 平涂的手绘线条抖动反而出噪点。"""
    return img.convert("P", palette=Image.ADAPTIVE, colors=256, dither=Image.NONE)


def ico_bytes(src: Image.Image) -> bytes:
    """多尺寸 ICO：16/32/48 三档（浏览器标签页、任务栏、书签管理器各取所需）。"""
    art = src.convert("RGBA")
    out = io.BytesIO()
    art.save(out, "ICO", sizes=[(16, 16), (32, 32), (48, 48)])
    return out.getvalue()


def main() -> int:
    check = "--check" in sys.argv
    src = Image.open(SRC) if os.path.exists(SRC) and check else draw_star()
    if check:
        ok = True
        if not os.path.exists(SVG):
            print("★ public/favicon.svg 不见了（手写那张要保留）")
            ok = False
        have = open(TOUCH, "rb").read() if os.path.exists(TOUCH) else b""
        if have != touch_png(src):
            print("★ public/apple-touch-icon.png 与源图不一致")
            ok = False
        have = open(ICO, "rb").read() if os.path.exists(ICO) else b""
        if have != ico_bytes(src):
            print("★ public/favicon.ico 与源图不一致")
            ok = False
        print("图标产物与源图一致" if ok else "图标产物需要重新生成")
        return 0 if ok else 1

    os.makedirs(os.path.dirname(SRC), exist_ok=True)
    src.save(SRC)
    open(TOUCH, "wb").write(touch_png(src))
    open(ICO, "wb").write(ico_bytes(src))
    print(f"preview-src/site-icon.png {os.path.getsize(SRC)} B（512×512，程序化画出的手绘星）")
    print(f"public/favicon.ico         {os.path.getsize(ICO)} B（16/32/48 多尺寸）")
    print(f"public/apple-touch-icon.png {os.path.getsize(TOUCH)} B（{TOUCH_PX}×{TOUCH_PX}，纸色底不透明）")
    print("public/favicon.svg         手写矢量（不由本脚本生成，记得手工维护）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
