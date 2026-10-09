"""Generate the desktop admin app icons from the console's icon (server-network/web/app/icon.svg).

    .venv/Scripts/python scripts/make_icons.py      (needs Pillow: pip install pillow)

Writes assets/app-icon.png (1024 px), assets/app-icon.ico (Windows, 16-256 px) and
assets/app-icon.icns (macOS). The results are committed, so builds do not need Pillow; rerun
this only when the icon changes. The geometry mirrors icon.svg and web/components/BrandMark.tsx
(viewBox 0 0 32 32):
  <rect width="32" height="32" rx="8" fill="diagonal gradient #6366f1 -> #8b5cf6 (45%) -> #ec4899"/>
  <path d="M10 23V9l12 14V9" stroke="#fff" stroke-width="3.2" round caps/joins/>   (an "N")
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets"

STOPS = [(0.0, (0x63, 0x66, 0xF1)), (0.45, (0x8B, 0x5C, 0xF6)), (1.0, (0xEC, 0x48, 0x99))]
WHITE = (255, 255, 255, 255)
VIEWBOX = 32
RADIUS = 8
STROKE = 3.2
PATH = [(10, 23), (10, 9), (22, 23), (22, 9)]


def gradient(size: int) -> Image.Image:
    """Top-left -> bottom-right linear gradient through STOPS (like the SVG's userSpaceOnUse x1=y1=0, x2=y2=32)."""
    def color(t: float) -> tuple[int, int, int]:
        for (t0, c0), (t1, c1) in zip(STOPS, STOPS[1:]):
            if t <= t1:
                f = (t - t0) / (t1 - t0)
                return tuple(round(a + (b - a) * f) for a, b in zip(c0, c1))  # type: ignore[return-value]
        return STOPS[-1][1]

    v = Image.linear_gradient("L").resize((size, size))  # top 0 -> bottom 255
    h = v.transpose(Image.Transpose.TRANSPOSE)  # left 0 -> right 255
    t = Image.blend(h, v, 0.5)  # (x + y) / 2: 0 at the top-left corner, 255 at the bottom-right
    lut = [color(i / 255) for i in range(256)]
    return Image.merge("RGB", [t.point([c[ch] for c in lut]) for ch in range(3)])


def render(size: int, supersample: int = 4) -> Image.Image:
    """Draw at `supersample`x and downscale for smooth (anti-aliased) edges."""
    big = size * supersample
    s = big / VIEWBOX
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, big - 1, big - 1), radius=round(RADIUS * s), fill=255)
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    img.paste(gradient(big), (0, 0), mask)
    d = ImageDraw.Draw(img)
    pts = [(x * s, y * s) for x, y in PATH]
    width = round(STROKE * s)
    d.line(pts, fill=WHITE, width=width, joint="curve")
    r = width / 2
    for x, y in pts:  # round caps and joins
        d.ellipse((x - r, y - r, x + r, y + r), fill=WHITE)
    return img.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    OUT.mkdir(exist_ok=True)
    master = render(1024)
    master.save(OUT / "app-icon.png")
    # Each ICO size is rendered separately so small sizes stay crisp.
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [render(n) for n in ico_sizes]
    frames[-1].save(OUT / "app-icon.ico", sizes=[(n, n) for n in ico_sizes], append_images=frames[:-1])
    master.save(OUT / "app-icon.icns")
    for f in ("app-icon.png", "app-icon.ico", "app-icon.icns"):
        print(f"wrote {OUT / f} ({(OUT / f).stat().st_size} bytes)")


if __name__ == "__main__":
    main()
