"""
Raster ValkAde app icon concepts for preview, or apply the chosen one to the app icons.

Each concept is drawn from the same geometry as its master SVG in `assets/valkade-concepts/`
(64-unit tile), supersampled per output size so 16-32px icons stay crisp. OS / taskbar icons sit
on the filled rounded tile; the etch asset is the white silhouette used as a CSS mask.

Preview mode (default) writes 16/32/64/256px PNGs, a 256px etch mask and a contact sheet
(real-size and 4x-zoomed icons on dark and light backgrounds) into --out-dir.
--apply overwrites build/icon.*, build/icons/, and the renderer's app-icon / etch / favicon;
`npm run render:icon` applies the shipped concept and palette.

Run from repo root:
  python scripts/render_valkade_icon.py --concept a
  python scripts/render_valkade_icon.py --concept c --apply
"""

from __future__ import annotations

import argparse
import io
import math
import struct
import sys
from dataclasses import dataclass, field
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    print("Install Pillow: pip install Pillow", file=sys.stderr)
    sys.exit(1)

PREVIEW_SIZES = (16, 32, 64, 256)
ETCH_PREVIEW_SIZE = 256
HICOLOR_SIZES = (16, 24, 32, 48, 64, 96, 128, 256, 512, 1024)
FAVICON_SIZES = (16, 32, 48)
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)

# Palette (keep in sync with assets/valkade-concepts/*.svg).
PLATE = (15, 15, 17, 255)  # #0f0f11
GLYPH = (244, 244, 245, 255)  # #f4f4f5
GLYPH_DIM = (188, 192, 202, 255)  # #bcc0ca
ACCENT = (77, 163, 255, 255)  # #4da3ff
ACCENT_LIGHT = (132, 196, 255, 255)  # #84c4ff
ACCENT_DEEP = (46, 126, 224, 255)  # #2e7ee0
LOOP = (74, 74, 84, 255)  # #4a4a54
WHITE = (255, 255, 255, 255)

PALETTES: dict[str, dict[str, tuple[int, int, int, int]]] = {
    "azure": {
        "plate": PLATE,
        "glyph": GLYPH,
        "glyph_dim": GLYPH_DIM,
        "accent_light": ACCENT_LIGHT,
        "accent": ACCENT,
        "accent_deep": ACCENT_DEEP,
    },
    "gold": {
        "plate": (14, 13, 12, 255),
        "glyph": (246, 242, 233, 255),
        "glyph_dim": (205, 196, 178, 255),
        "accent_light": (255, 222, 130, 255),
        "accent": (245, 168, 38, 255),
        "accent_deep": (196, 109, 18, 255),
    },
    "ember": {
        "plate": (17, 15, 15, 255),
        "glyph": (245, 243, 242, 255),
        "glyph_dim": (202, 192, 190, 255),
        "accent_light": (255, 176, 118, 255),
        "accent": (255, 107, 53, 255),
        "accent_deep": (212, 54, 30, 255),
    },
    "mint": {
        "plate": (11, 17, 17, 255),
        "glyph": (238, 247, 245, 255),
        "glyph_dim": (182, 206, 201, 255),
        "accent_light": (122, 247, 204, 255),
        "accent": (34, 211, 156, 255),
        "accent_deep": (13, 148, 136, 255),
    },
    "violet": {
        "plate": (14, 13, 20, 255),
        "glyph": (242, 241, 248, 255),
        "glyph_dim": (192, 188, 214, 255),
        "accent_light": (198, 168, 255, 255),
        "accent": (139, 92, 246, 255),
        "accent_deep": (91, 63, 214, 255),
    },
    "crimson": {
        "plate": (15, 13, 14, 255),
        "glyph": (238, 239, 243, 255),
        "glyph_dim": (192, 190, 198, 255),
        "accent_light": (255, 142, 164, 255),
        "accent": (244, 63, 94, 255),
        "accent_deep": (186, 18, 58, 255),
    },
}

TILE = 64.0
TILE_RADIUS = 14.0
ETCH_FILL = 0.92

Point = tuple[float, float]
Color = tuple[int, int, int, int]


@dataclass(frozen=True)
class Arc:
    """Round-capped open arc; the gap is centred on `gap_deg` (screen angles, clockwise from 3 o'clock)."""

    center: Point
    radius: float
    width: float
    gap_deg: float
    half_open: float
    color: Color


@dataclass(frozen=True)
class Shape:
    points: tuple[Point, ...]
    color: Color


@dataclass(frozen=True)
class Concept:
    slug: str
    title: str
    arcs: tuple[Arc, ...] = field(default=())
    shapes: tuple[Shape, ...] = field(default=())


CONCEPTS: dict[str, Concept] = {
    "a": Concept(
        slug="wing-chevron",
        title="Wing chevron",
        shapes=(
            Shape(((8, 14), (20, 14), (31, 37.83), (31, 50), (28, 50)), GLYPH),
            Shape(((33, 37.83), (44, 14), (56, 14), (36, 50), (33, 50)), ACCENT),
        ),
    ),
    "a1": Concept(
        slug="wing-sans-pinions",
        title="A1 · Geometric Sans + Pinions",
        shapes=(
            # Left: clean geometric sans-serif V leg
            Shape(((9.5, 14), (20.5, 14), (30.5, 38.5), (30.5, 51), (26.5, 51)), GLYPH),
            # Right: 4-feather swept Valkyrie wing
            Shape(((32.5, 38), (43, 13.5), (56.5, 11.5), (51.5, 19.5), (32.5, 42)), ACCENT_LIGHT),
            Shape(((32.5, 44), (47, 24.5), (55, 21.5), (49.5, 29), (32.5, 47.2)), ACCENT),
            Shape(((32.5, 49), (45.5, 32.5), (52, 30.5), (46.5, 37.2), (34, 51), (32.5, 51)), ACCENT),
            Shape(((36.5, 50.5), (45.5, 40), (49, 39), (43.5, 46), (38, 51)), ACCENT_DEEP),
        ),
    ),
    "a2": Concept(
        slug="wing-serif-plumes",
        title="A2 · Chiseled Serif + Plumes",
        shapes=(
            # Left: sculpted geometric display-serif V leg with subtle inner bevel
            Shape(((7.5, 13), (24.5, 13), (23, 17.5), (19.8, 17.5), (30.5, 40), (30.5, 51.5), (26.2, 51.5), (11.5, 17.5), (7.5, 17.5)), GLYPH),
            Shape(((7.5, 13), (11.5, 17.5), (26.2, 51.5), (28.4, 51.5), (14.2, 17.5), (11.5, 13)), GLYPH_DIM),
            # Right: structural V wing-spine + 4 fanned Valkyrie plumes
            Shape(((32.5, 40), (41.5, 19.5), (46.5, 13), (57, 10.5), (52.5, 18), (43.5, 24), (32.5, 45.5)), ACCENT_LIGHT),
            Shape(((32.5, 47.5), (43.5, 27), (54.5, 20.5), (50.2, 27), (41.5, 33), (32.5, 50.5)), ACCENT),
            Shape(((34, 51.5), (42.5, 35.5), (51, 30), (46.8, 36), (39.5, 42), (36, 51.5)), ACCENT),
            Shape(((37.5, 51), (43.5, 41.5), (48, 38.5), (44.5, 44.5), (39, 51)), ACCENT_DEEP),
        ),
    ),
    "a3": Concept(
        slug="wing-tech-blades",
        title="A3 · Chamfered Tech + Blades",
        shapes=(
            # Left: chamfered futuristic geometric V leg
            Shape(((13, 13), (21.5, 13), (30.5, 38.5), (30.5, 51), (26, 51), (9.5, 18)), GLYPH),
            # Right: inner V spar + 5 stacked aerodynamic wing blades (uniform 1.4u gap off spar)
            Shape(((32.5, 39), (42.5, 13), (46.8, 13), (35.5, 44.5), (33.5, 51), (32.5, 51)), ACCENT_LIGHT),
            Shape(((48.2, 13), (57.2, 13), (55.0, 17.4), (46.6, 17.4)), ACCENT_LIGHT),
            Shape(((45.8, 19.8), (55.4, 19.8), (53.2, 24.2), (44.2, 24.2)), ACCENT),
            Shape(((43.4, 26.6), (52.8, 26.6), (50.6, 31.0), (41.8, 31.0)), ACCENT),
            Shape(((41.0, 33.4), (49.6, 33.4), (47.4, 37.8), (39.4, 37.8)), ACCENT_DEEP),
            Shape(((38.6, 40.2), (45.8, 40.2), (43.6, 44.6), (37.0, 44.6)), ACCENT_DEEP),
        ),
    ),
    "a4": Concept(
        slug="wing-italic-sweep",
        title="A4 · Condensed Italic + Sweep",
        shapes=(
            # Left: steep forward-leaning geometric V leg
            Shape(((12, 12.5), (22, 14.5), (30.5, 41), (30.5, 52), (26, 52)), GLYPH),
            # Right: high-swept organic ribbon wing rising above the left arm
            Shape(((32.5, 41), (38.5, 25), (45.5, 14.5), (56.5, 9.5), (53.2, 16.5), (46.5, 21.5), (32.5, 45.2)), ACCENT_LIGHT),
            Shape(((32.5, 47.2), (45.2, 24.5), (55, 19.5), (51.5, 26), (44.2, 30.8), (32.5, 50.2)), ACCENT),
            Shape(((33.2, 52), (43.8, 33.5), (51.5, 29.5), (48, 35.2), (41.2, 40), (35.5, 52)), ACCENT),
            Shape(((37.5, 51.5), (43.8, 41.5), (48.2, 38.8), (45, 44.2), (39, 51.5)), ACCENT_DEEP),
        ),
    ),
    "b": Concept(
        slug="forged-v",
        title="Forged V",
        shapes=(
            Shape(
                (
                    (8, 12), (26, 12), (26, 17), (23, 17), (32, 38), (41, 17), (38, 17), (38, 12),
                    (56, 12), (56, 17), (52, 17), (38, 46), (26, 46), (12, 17), (8, 17),
                ),
                GLYPH,
            ),
            Shape(((18, 50), (46, 50), (43, 55), (21, 55)), ACCENT),
        ),
    ),
    "c": Concept(
        slug="blade-arc",
        title="Blade arc",
        arcs=(Arc((32, 33), 22, 6, -45, 40, LOOP),),
        shapes=(
            Shape(((17, 27), (24, 27), (29.5, 37.5), (45.67, 18.69), (47.2, 21.58), (34, 46), (27, 46)), GLYPH),
            Shape(((46.65, 17.55), (54, 9), (48, 20.1)), ACCENT),
        ),
    ),
}


def supersample_for(size: int) -> int:
    return 8 if size <= 64 else 4


def draw_dot(draw: ImageDraw.ImageDraw, scale: float, center: Point, radius: float, fill: Color) -> None:
    x, y = center
    draw.ellipse(
        [(x - radius) * scale, (y - radius) * scale, (x + radius) * scale, (y + radius) * scale],
        fill=fill,
    )


def draw_open_arc(draw: ImageDraw.ImageDraw, scale: float, arc: Arc, fill: Color) -> None:
    cx, cy = arc.center
    outer = arc.radius + arc.width / 2
    box = [(cx - outer) * scale, (cy - outer) * scale, (cx + outer) * scale, (cy + outer) * scale]
    start = arc.gap_deg + arc.half_open
    end = arc.gap_deg + 360 - arc.half_open
    draw.arc(box, start=start, end=end, fill=fill, width=max(1, round(arc.width * scale)))
    for angle in (start, end):
        ex = cx + arc.radius * math.cos(math.radians(angle))
        ey = cy + arc.radius * math.sin(math.radians(angle))
        draw_dot(draw, scale, (ex, ey), arc.width / 2, fill)


def remap_color(color: Color, palette: dict[str, Color]) -> Color:
    mapping = {
        GLYPH: palette["glyph"],
        GLYPH_DIM: palette["glyph_dim"],
        ACCENT_LIGHT: palette["accent_light"],
        ACCENT: palette["accent"],
        ACCENT_DEEP: palette["accent_deep"],
    }
    return mapping.get(color, color)


def draw_mark(
    draw: ImageDraw.ImageDraw,
    scale: float,
    concept: Concept,
    mono: Color | None = None,
    palette: dict[str, Color] | None = None,
) -> None:
    pal = palette or PALETTES["azure"]
    for arc in concept.arcs:
        draw_open_arc(draw, scale, arc, mono or remap_color(arc.color, pal))
    for shape in concept.shapes:
        draw.polygon([(x * scale, y * scale) for x, y in shape.points], fill=mono or remap_color(shape.color, pal))


def tiled_icon(concept: Concept, size: int, palette_key: str = "azure") -> Image.Image:
    pal = PALETTES[palette_key]
    ss = supersample_for(size)
    big = size * ss
    scale = big / TILE
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle([0, 0, big - 1, big - 1], radius=TILE_RADIUS * scale, fill=pal["plate"])
    draw_mark(draw, scale, concept, palette=pal)
    return img.resize((size, size), Image.Resampling.LANCZOS)


def etch_icon(concept: Concept, size: int) -> Image.Image:
    """White silhouette of the mark (no plate), fitted to ETCH_FILL of the canvas."""
    ss = supersample_for(size)
    big = size * ss
    mark = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw_mark(ImageDraw.Draw(mark), big / TILE, concept, WHITE)
    mark = mark.crop(mark.getbbox())
    target = int(round(big * ETCH_FILL))
    mark.thumbnail((target, target), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    canvas.paste(mark, ((big - mark.width) // 2, (big - mark.height) // 2), mark)
    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def contact_sheet(icons: dict[int, Image.Image], etch: Image.Image) -> Image.Image:
    """Two rows (dark / light background): each size at 1:1, then 16/32 zoomed 4x nearest-neighbour, then the etch."""
    pad = 24
    zoom = 4
    small = [s for s in (16, 32) if s in icons]
    cells: list[Image.Image] = [icons[s] for s in sorted(icons)]
    cells += [icons[s].resize((s * zoom, s * zoom), Image.Resampling.NEAREST) for s in small]
    row_h = max(max(c.height for c in cells), etch.height) + pad * 2
    width = pad + sum(c.width + pad for c in cells) + etch.width + pad
    sheet = Image.new("RGBA", (width, row_h * 2), (0, 0, 0, 255))
    for row, (bg, etch_tint) in enumerate((((32, 32, 36, 255), (228, 228, 231, 255)), ((243, 243, 245, 255), (39, 39, 42, 255)))):
        top = row * row_h
        sheet.paste(Image.new("RGBA", (width, row_h), bg), (0, top))
        x = pad
        for cell in cells:
            sheet.alpha_composite(cell, (x, top + (row_h - cell.height) // 2))
            x += cell.width + pad
        tinted = Image.new("RGBA", etch.size, etch_tint)
        tinted.putalpha(etch.getchannel("A"))
        sheet.alpha_composite(tinted, (x, top + (row_h - etch.height) // 2))
    return sheet


def write_png_ico(path: Path, images: list[Image.Image]) -> None:
    """Write a PNG-in-ICO with one pre-rendered bitmap per size (no upscaling)."""
    ordered = sorted(images, key=lambda im: im.size[0])
    blobs = []
    for im in ordered:
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        blobs.append((im.size[0], im.size[1], buf.getvalue()))
    offset = 6 + 16 * len(blobs)
    with path.open("wb") as fh:
        fh.write(struct.pack("<HHH", 0, 1, len(blobs)))
        cursor = offset
        for width, height, data in blobs:
            fh.write(
                struct.pack(
                    "<BBBBHHII",
                    0 if width >= 256 else width,
                    0 if height >= 256 else height,
                    0,
                    0,
                    1,
                    32,
                    len(data),
                    cursor,
                )
            )
            cursor += len(data)
        for _width, _height, data in blobs:
            fh.write(data)


def render_preview(concept_key: str, out_dir: Path, palette_key: str = "azure") -> None:
    concept = CONCEPTS[concept_key]
    out_dir.mkdir(parents=True, exist_ok=True)
    suffix = "" if palette_key == "azure" else f"-{palette_key}"
    prefix = f"valkade-{concept_key}-{concept.slug}{suffix}"
    icons = {size: tiled_icon(concept, size, palette_key) for size in PREVIEW_SIZES}
    for size, icon in icons.items():
        path = out_dir / f"{prefix}-{size}.png"
        icon.save(path, "PNG")
        print(f"Wrote {path}")
    etch = etch_icon(concept, ETCH_PREVIEW_SIZE)
    etch_path = out_dir / f"{prefix}-etch-{ETCH_PREVIEW_SIZE}.png"
    etch.save(etch_path, "PNG")
    print(f"Wrote {etch_path}")
    sheet_path = out_dir / f"{prefix}-sheet.png"
    contact_sheet(icons, etch).save(sheet_path, "PNG")
    print(f"Wrote {sheet_path}")


def apply_icons(concept_key: str, root: Path, palette_key: str = "azure") -> None:
    concept = CONCEPTS[concept_key]
    chrome = tiled_icon(concept, 1024, palette_key)
    etch = etch_icon(concept, 1024)

    out_build = root / "build" / "icon.png"
    out_public = root / "src" / "renderer" / "public" / "app-icon.png"
    out_etch = root / "src" / "renderer" / "public" / "app-icon-etch.png"
    out_build.parent.mkdir(parents=True, exist_ok=True)
    out_public.parent.mkdir(parents=True, exist_ok=True)
    chrome.save(out_build, "PNG")
    chrome.save(out_public, "PNG")
    etch.save(out_etch, "PNG")

    icons_dir = root / "build" / "icons"
    icons_dir.mkdir(parents=True, exist_ok=True)
    for size in HICOLOR_SIZES:
        tiled_icon(concept, size, palette_key).save(icons_dir / f"{size}x{size}.png", "PNG")

    ico_path = root / "build" / "icon.ico"
    write_png_ico(ico_path, [tiled_icon(concept, size, palette_key) for size in ICO_SIZES])
    fav_path = root / "src" / "renderer" / "public" / "favicon.ico"
    write_png_ico(fav_path, [tiled_icon(concept, size, palette_key) for size in FAVICON_SIZES])

    print(f"Applied concept {concept_key} ({concept.title}) [{palette_key}]")
    print(f"Wrote {out_build}")
    print(f"Wrote {out_public}")
    print(f"Wrote {out_etch}")
    print(f"Wrote {ico_path}")
    print(f"Wrote {fav_path}")
    print(f"Wrote {icons_dir} ({len(HICOLOR_SIZES)} sizes)")


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description="Render ValkAde icon concepts.")
    parser.add_argument("--concept", choices=sorted(CONCEPTS), required=True)
    parser.add_argument("--palette", choices=sorted(PALETTES), default="azure")
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=root / "assets" / "valkade-concepts" / "preview",
        help="Preview output folder (ignored with --apply).",
    )
    parser.add_argument("--apply", action="store_true", help="Overwrite build/icon.* and the renderer app icons.")
    args = parser.parse_args()

    if args.apply:
        apply_icons(args.concept, root, args.palette)
    else:
        render_preview(args.concept, args.out_dir, args.palette)


if __name__ == "__main__":
    main()
