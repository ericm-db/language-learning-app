#!/usr/bin/env python3
"""
Simple PWA icon generator for Language Learning App
Creates basic gradient icons with text overlay
"""

from PIL import Image, ImageDraw, ImageFont
import os

# Icon sizes needed for PWA
SIZES = [72, 96, 128, 144, 152, 192, 384, 512]

# Output directory
OUTPUT_DIR = 'static/icons'

def create_icon(size):
    """Create a single icon of the specified size"""
    # Create image with gradient background
    img = Image.new('RGB', (size, size), color='#667eea')
    draw = ImageDraw.Draw(img)

    # Draw gradient-like effect (simple two-tone)
    for y in range(size):
        ratio = y / size
        r = int(102 + (118 - 102) * ratio)
        g = int(126 + (75 - 126) * ratio)
        b = int(234 + (162 - 234) * ratio)
        draw.line([(0, y), (size, y)], fill=(r, g, b))

    # Draw text
    try:
        # Try to use a nice font
        font_size = int(size * 0.4)
        font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', font_size)
    except:
        # Fall back to default font
        font = ImageFont.load_default()

    # Draw "Aa" in the center
    text = "Aa"
    bbox = draw.textbbox((0, 0), text, font=font)
    text_width = bbox[2] - bbox[0]
    text_height = bbox[3] - bbox[1]
    position = ((size - text_width) // 2, (size - text_height) // 2 - size // 10)

    # Draw white text with shadow
    shadow_offset = max(1, size // 100)
    draw.text((position[0] + shadow_offset, position[1] + shadow_offset), text, font=font, fill=(0, 0, 0, 80))
    draw.text(position, text, font=font, fill=(255, 255, 255))

    return img

def generate_all_icons():
    """Generate all required PWA icons"""
    # Create output directory if it doesn't exist
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    for size in SIZES:
        print(f'Generating {size}x{size} icon...')
        icon = create_icon(size)
        output_path = os.path.join(OUTPUT_DIR, f'icon-{size}x{size}.png')
        icon.save(output_path, 'PNG')
        print(f'  Saved to {output_path}')

    print(f'\nAll icons generated successfully in {OUTPUT_DIR}/')

if __name__ == '__main__':
    try:
        generate_all_icons()
    except ImportError:
        print('Error: PIL (Pillow) is required to generate icons.')
        print('Install it with: pip install Pillow')
        print('\nAlternatively, you can:')
        print('1. Open static/icons/generate-icons.html in a browser')
        print('2. Or use an online PWA icon generator like https://www.pwabuilder.com/imageGenerator')
