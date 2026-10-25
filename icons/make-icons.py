#!/usr/bin/env python3
"""Render the app icons. Run from the repo root: python3 icons/make-icons.py"""
from PIL import Image, ImageDraw

INK = (22, 19, 15, 255)
PAPER = (244, 239, 229, 255)
VERD = (99, 201, 168, 255)

# Crop-mark frame around a page: the app's signature, straight off the capture screen.
ARMS = [
    (96, 96, 112, 192), (96, 96, 192, 112),
    (400, 96, 416, 192), (320, 96, 416, 112),
    (96, 320, 112, 416), (96, 400, 192, 416),
    (400, 320, 416, 416), (320, 400, 416, 416),
]


def art(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = size / 512

    def rect(x0, y0, x1, y1, color):
        d.rectangle([x0 * u, y0 * u, x1 * u - 1, y1 * u - 1], fill=color)

    rect(150, 128, 362, 384, PAPER)
    for x0, y0, x1, y1 in ARMS:
        rect(x0, y0, x1, y1, VERD)
    return img


def icon(px, scale=1.0):
    big = px * 4
    base = Image.new("RGBA", (big, big), INK)
    layer = art(big)
    if scale != 1.0:
        n = int(big * scale)
        layer = layer.resize((n, n), Image.LANCZOS)
        base.alpha_composite(layer, ((big - n) // 2, (big - n) // 2))
    else:
        base.alpha_composite(layer)
    return base.resize((px, px), Image.LANCZOS)


for name, px, scale in [
    ("icon-180.png", 180, 1.0),
    ("icon-192.png", 192, 1.0),
    ("icon-512.png", 512, 1.0),
    ("icon-512-maskable.png", 512, 0.72),
]:
    icon(px, scale).save(f"icons/{name}")
    print("wrote", name)
