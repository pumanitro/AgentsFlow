#!/usr/bin/env python3
"""Build assets/icon.png with proper transparency and Apple-style safe-area padding."""
from PIL import Image, ImageDraw, ImageFilter
from pathlib import Path

SIZE = 1024
PAD = 100                              # safe-area padding (~10% per Apple HIG)
INNER = SIZE - 2 * PAD                 # 824
RADIUS = int(INNER * 0.225)            # macOS squircle ratio

ORANGE = (255, 120, 71)                # #ff7847
TOP_BG = (31, 36, 53)                  # #1f2435
BOT_BG = (12, 14, 20)                  # #0c0e14

def into_canvas(inner_img: Image.Image) -> Image.Image:
    """Place an INNER-sized RGBA layer into a full SIZE canvas at PAD offset."""
    layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    layer.paste(inner_img, (PAD, PAD), inner_img)
    return layer

# --- Squircle mask (used to clip each inner layer to the icon shape) ---
mask = Image.new("L", (INNER, INNER), 0)
ImageDraw.Draw(mask).rounded_rectangle(
    [0, 0, INNER - 1, INNER - 1], radius=RADIUS, fill=255
)

# --- Layer 1: vertical gradient, clipped to squircle ---
grad = Image.new("RGBA", (INNER, INNER), (0, 0, 0, 0))
gd = ImageDraw.Draw(grad)
for y in range(INNER):
    t = y / (INNER - 1)
    r = round(TOP_BG[0] + (BOT_BG[0] - TOP_BG[0]) * t)
    g = round(TOP_BG[1] + (BOT_BG[1] - TOP_BG[1]) * t)
    b = round(TOP_BG[2] + (BOT_BG[2] - TOP_BG[2]) * t)
    gd.line([(0, y), (INNER - 1, y)], fill=(r, g, b, 255))
grad.putalpha(mask)

# --- Layer 2: subtle top-left highlight for depth ---
hl = Image.new("RGBA", (INNER, INNER), (0, 0, 0, 0))
hd = ImageDraw.Draw(hl)
cx, cy = int(INNER * 0.28), int(INNER * 0.18)
max_r = int(INNER * 0.7)
for i in range(max_r, 0, -6):
    a = int(28 * (1 - i / max_r))
    if a <= 0:
        continue
    hd.ellipse([cx - i, cy - i, cx + i, cy + i], fill=(255, 255, 255, a))
hl = hl.filter(ImageFilter.GaussianBlur(18))
# Clip highlight to squircle by multiplying its alpha by the mask
hl_alpha = hl.split()[3]
hl_alpha = Image.eval(hl_alpha, lambda v: v)  # ensure it's an L image
combined_a = Image.new("L", (INNER, INNER))
combined_a.putdata([min(a, m) for a, m in zip(hl_alpha.getdata(), mask.getdata())])
hl.putalpha(combined_a)

# --- Layer 3: foreground — three agent dots + three flow bars ---
fg = Image.new("RGBA", (INNER, INNER), (0, 0, 0, 0))
fd = ImageDraw.Draw(fg)

DOT_R = int(INNER * 0.034)
DOTS_X = int(INNER * 0.27)
ROW_YS = [int(INNER * 0.36), int(INNER * 0.50), int(INNER * 0.64)]
BARS_X = int(INNER * 0.345)
BAR_H = int(INNER * 0.07)
BAR_LENS = [int(INNER * 0.40), int(INNER * 0.31), int(INNER * 0.22)]
ALPHAS = [255, 199, 133]

for i in range(3):
    a = ALPHAS[i]
    fd.ellipse(
        [DOTS_X - DOT_R, ROW_YS[i] - DOT_R, DOTS_X + DOT_R, ROW_YS[i] + DOT_R],
        fill=ORANGE + (a,),
    )
    bw = BAR_LENS[i]
    fd.rounded_rectangle(
        [BARS_X, ROW_YS[i] - BAR_H // 2, BARS_X + bw, ROW_YS[i] + BAR_H // 2],
        radius=BAR_H // 2,
        fill=ORANGE + (a,),
    )

# --- Layer 4: hairline inner border for definition against light wallpapers ---
border = Image.new("RGBA", (INNER, INNER), (0, 0, 0, 0))
ImageDraw.Draw(border).rounded_rectangle(
    [1, 1, INNER - 2, INNER - 2], radius=RADIUS - 1,
    outline=(255, 255, 255, 32), width=2,
)

# Composite the layers in order
out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
for layer in (grad, hl, fg, border):
    out = Image.alpha_composite(out, into_canvas(layer))

target = Path(__file__).parent / "icon.png"
out.save(target)
print(f"wrote {target} ({SIZE}x{SIZE}, RGBA)")
