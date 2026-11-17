from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "src-tauri" / "icons" / "app-icon.png"


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for name in ("arialbd.ttf", "DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def narrow_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for name in (r"C:\Windows\Fonts\ARIALNB.TTF", "Arial Narrow Bold.ttf", "DejaVuSansCondensed-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size=size)
        except OSError:
            continue
    return font(size)


def rounded_tile(size: int) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    image = Image.new("RGBA", (size, size), (255, 255, 255, 255))
    draw = ImageDraw.Draw(image)
    inset = max(2, round(size * 0.04))
    draw.rounded_rectangle(
        (inset, inset, size - inset, size - inset),
        radius=round(size * 0.19),
        fill=(255, 255, 255, 255),
        outline=(193, 208, 218, 255),
        width=max(1, round(size * 0.012)),
    )
    return image, draw


def full_wordmark(size: int) -> Image.Image:
    image, draw = rounded_tile(size)
    label_font = font(round(size * 0.255))
    parts = (("Tu", (25, 38, 50, 255)), ("FFT", (32, 109, 168, 255)))
    widths = [draw.textlength(text, font=label_font) for text, _ in parts]
    x = (size - sum(widths)) / 2
    bbox = draw.textbbox((0, 0), "TuFFT", font=label_font)
    y = (size - (bbox[3] - bbox[1])) / 2 - bbox[1] - size * 0.015
    for (text, color), width in zip(parts, widths):
        draw.text((x, y), text, font=label_font, fill=color)
        x += width
    accent_y = round(y + bbox[3] + size * 0.032)
    draw.rounded_rectangle(
        (round(size * 0.31), accent_y, round(size * 0.78), accent_y + max(2, round(size * 0.018))),
        radius=max(1, round(size * 0.009)),
        fill=(43, 164, 162, 255),
    )
    return image


def compact_windows_mark(size: int) -> Image.Image:
    """Render the complete wordmark natively for each Windows icon size."""
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    inset = max(1, round(size * 0.04))
    draw.rounded_rectangle(
        (inset, inset, size - inset - 1, size - inset - 1),
        radius=max(2, round(size * 0.18)),
        fill=(32, 109, 168, 255),
    )

    if size <= 16:
        glyphs = {
            "T": ("11", "10", "10", "10", "10"),
            "u": ("00", "10", "10", "10", "11"),
            "F": ("11", "10", "11", "10", "10"),
        }
        word = "TuFFT"
        gap = 1
        width = sum(len(glyphs[letter][0]) for letter in word) + gap * (len(word) - 1)
        pixel_height = 2 if size == 16 else 3
        x = (size - width) // 2
        y = (size - 5 * pixel_height) // 2
        for letter in word:
            glyph = glyphs[letter]
            for row, bits in enumerate(glyph):
                for column, bit in enumerate(bits):
                    if bit == "1":
                        draw.rectangle(
                            (x + column, y + row * pixel_height, x + column, y + (row + 1) * pixel_height - 1),
                            fill=(255, 255, 255, 255),
                        )
            x += len(glyph[0]) + gap
        return image

    target_width = size * 0.92
    target_height = size * 0.52
    label_font = narrow_font(max(6, round(size * 0.42)))
    for candidate in range(max(6, round(size * 0.65)), 5, -1):
        candidate_font = narrow_font(candidate)
        bbox = draw.textbbox((0, 0), "TuFFT", font=candidate_font)
        if bbox[2] - bbox[0] <= target_width and bbox[3] - bbox[1] <= target_height:
            label_font = candidate_font
            break
    bbox = draw.textbbox((0, 0), "TuFFT", font=label_font)
    text_width = bbox[2] - bbox[0]
    text_height = bbox[3] - bbox[1]
    x = (size - text_width) / 2 - bbox[0]
    y = (size - text_height) / 2 - bbox[1] - size * 0.01
    draw.text((x, y), "TuFFT", font=label_font, fill=(255, 255, 255, 255))
    return image


def main() -> None:
    size = 1024
    image = full_wordmark(size)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    image.save(OUTPUT)

    compact_sizes = {
        "32x32.png": 32,
        "64x64.png": 64,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "StoreLogo.png": 50,
        "Square30x30Logo.png": 30,
        "Square44x44Logo.png": 44,
        "Square71x71Logo.png": 71,
        "Square89x89Logo.png": 89,
        "Square107x107Logo.png": 107,
        "Square142x142Logo.png": 142,
        "Square150x150Logo.png": 150,
        "Square284x284Logo.png": 284,
        "Square310x310Logo.png": 310,
    }
    for filename, edge in compact_sizes.items():
        compact_windows_mark(edge).save(OUTPUT.parent / filename)
    image.resize((512, 512), Image.Resampling.LANCZOS).save(OUTPUT.parent / "icon.png")

    # Include Windows' common DPI-scaled title-bar and taskbar sizes so the OS
    # can select a native raster instead of interpolating the wordmark.
    ico_edges = [16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 96, 128, 256]
    ico_sizes = [(edge, edge) for edge in ico_edges]
    ico_frames = [compact_windows_mark(edge) for edge, _ in ico_sizes]
    ico_frames[-1].save(
        OUTPUT.parent / "icon.ico",
        sizes=ico_sizes,
        append_images=ico_frames[:-1],
    )
    image.save(OUTPUT.parent / "icon.icns", sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)])


if __name__ == "__main__":
    main()
