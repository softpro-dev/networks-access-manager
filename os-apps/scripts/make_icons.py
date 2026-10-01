"""Generate the desktop admin app icons from the console's icon (server-network/web/app/icon.svg).

    .venv/Scripts/python scripts/make_icons.py      (needs Pillow: pip install pillow)

Writes assets/app-icon.png (1024 px), assets/app-icon.ico (Windows, 16-256 px) and
assets/app-icon.icns (macOS). The results are committed, so builds do not need Pillow; rerun
this only when the icon changes. The geometry mirrors icon.svg (viewBox 0 0 32 32):
  <rect width="32" height="32" rx="7" fill="#2451c7"/>
  <path d="M8 22V10l8 7 8-7v12" stroke="#fff" stroke-width="3" round caps/joins/>
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets"

BLUE = (0x24, 0x51, 0xC7, 255)
WHITE = (255, 255, 255, 255)
VIEWBOX = 32
RADIUS = 7
STROKE = 3
PATH = [(8, 22), (8, 10), (16, 17), (24, 10), (24, 22)]


def render(size: int, supersample: int = 4) -> Image.Image:
    """Draw at `supersample`x and downscale for smooth (anti-aliased) edges."""
    big = size * supersample
    s = big / VIEWBOX
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, big - 1, big - 1), radius=round(RADIUS * s), fill=BLUE)
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
