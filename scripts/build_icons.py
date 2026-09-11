"""Generate the raster PWA icons iOS needs from the same glyph as the SVG.

Safari ignores SVG in ``apple-touch-icon`` and in the web manifest, so the
"Add to Home Screen" icon has to exist as PNG.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "web" / "icons"
DARK = (13, 51, 40, 255)
LIME = (201, 241, 105, 255)


def draw_glyph(size: int, *, padding: float, rounded: bool) -> Image.Image:
    scale = 4
    canvas = Image.new("RGBA", (512 * scale, 512 * scale), (0, 0, 0, 0))
    pen = ImageDraw.Draw(canvas)

    def box(x0: float, y0: float, x1: float, y1: float) -> tuple[float, float, float, float]:
        return (x0 * scale, y0 * scale, x1 * scale, y1 * scale)

    if rounded:
        pen.rounded_rectangle(box(0, 0, 512, 512), radius=108 * scale, fill=DARK)
    else:
        pen.rectangle(box(0, 0, 512, 512), fill=DARK)

    # Pump body.
    pen.rounded_rectangle(box(151, 111, 355, 401), radius=36 * scale, fill=LIME)
    # Display and slot cut back to the background colour.
    pen.rectangle(box(175, 166, 295, 257), fill=DARK)
    pen.rectangle(box(175, 308, 295, 346), fill=DARK)
    # Hose arm on the right.
    pen.rounded_rectangle(box(355, 196, 425, 236), radius=18 * scale, fill=LIME)
    pen.rounded_rectangle(box(391, 196, 425, 401), radius=18 * scale, fill=LIME)

    if padding:
        inner = round(512 * (1 - padding))
        shrunk = canvas.resize((inner * scale, inner * scale), Image.LANCZOS)
        canvas = Image.new("RGBA", (512 * scale, 512 * scale), DARK)
        offset = (512 * scale - inner * scale) // 2
        canvas.paste(shrunk, (offset, offset), shrunk)
    return canvas.resize((size, size), Image.LANCZOS)


def main() -> int:
    ICONS.mkdir(parents=True, exist_ok=True)
    targets = [
        ("icon-192.png", 192, 0.0, True),
        ("icon-512.png", 512, 0.0, True),
        # Android masks aggressively, so the glyph needs its own safe area.
        ("icon-maskable-512.png", 512, 0.22, False),
        # iOS applies its own mask and expects a full-bleed square.
        ("apple-touch-icon.png", 180, 0.0, False),
    ]
    for name, size, padding, rounded in targets:
        image = draw_glyph(size, padding=padding, rounded=rounded)
        if not rounded:
            flat = Image.new("RGB", image.size, DARK[:3])
            flat.paste(image, mask=image.split()[3])
            image = flat
        image.save(ICONS / name, optimize=True)
        print(f"{name} {size}x{size}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
