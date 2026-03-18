use ab_glyph::{Font, FontRef, PxScale, ScaleFont};
use image::{ImageBuffer, Rgba, RgbaImage};

/// Embedded font for tray text rendering.
const FONT_DATA: &[u8] = include_bytes!("../icons/Inter-Medium.ttf");

/// Render just the icon for the tray (no cost text). Used on Windows.
#[cfg(target_os = "windows")]
pub fn render_tray_icon_only(icon: &RgbaImage) -> tauri::image::Image<'static> {
    let size: u32 = 32;
    let mut img: RgbaImage = ImageBuffer::new(size, size);
    composite_icon(&mut img, icon, 0, 0, size);
    let (w, h) = (img.width(), img.height());
    tauri::image::Image::new_owned(img.into_raw(), w, h)
}

/// Render a composite tray image: white rounded rect background with icon + cost text.
///
/// The image is rendered at 2x pixel density (44px height = 22pt on Retina).
pub fn render_tray_image(icon: &RgbaImage, cost_text: &str) -> tauri::image::Image<'static> {
    let font = FontRef::try_from_slice(FONT_DATA).expect("failed to parse embedded font");

    let img_height: u32 = 44;
    let icon_size: u32 = 42; // icon rendered at this size within the 44px height
    let padding_x: u32 = 12;
    let spacing: u32 = 10; // space between icon and text
    let font_size: f32 = 36.0;

    let scale = PxScale::from(font_size);
    let scaled_font = font.as_scaled(scale);

    // Measure text width
    let text_width = measure_text_width(&scaled_font, cost_text);

    // Total image dimensions
    let total_width = padding_x + icon_size + spacing + text_width as u32 + padding_x;

    // Create transparent image buffer
    let mut img: RgbaImage = ImageBuffer::new(total_width, img_height);

    // Draw white rounded rectangle background
    let bg_color = Rgba([255, 255, 255, 255]); // fully opaque white
    let corner_radius = 14.0_f32;
    draw_rounded_rect(&mut img, 0, 0, total_width, img_height, corner_radius, bg_color);

    // Composite the icon (vertically centered, left-aligned after padding)
    let icon_x = padding_x;
    let icon_y = (img_height - icon_size) / 2;
    composite_icon(&mut img, icon, icon_x, icon_y, icon_size);

    // Render text (vertically centered, right of icon)
    let text_x = padding_x + icon_size + spacing;
    let text_color = Rgba([50, 50, 50, 255]); // dark gray text
    draw_text(&mut img, &scaled_font, cost_text, text_x, img_height, text_color);

    let (w, h) = (img.width(), img.height());
    tauri::image::Image::new_owned(img.into_raw(), w, h)
}

/// Measure the width of text in pixels using glyph advance widths.
fn measure_text_width(font: &ab_glyph::PxScaleFont<&FontRef>, text: &str) -> f32 {
    let mut width = 0.0_f32;
    let mut prev_glyph: Option<ab_glyph::GlyphId> = None;

    for ch in text.chars() {
        let glyph_id = font.glyph_id(ch);
        if let Some(prev) = prev_glyph {
            width += font.kern(prev, glyph_id);
        }
        width += font.h_advance(glyph_id);
        prev_glyph = Some(glyph_id);
    }

    width
}

/// Draw a filled rounded rectangle with anti-aliased corners.
fn draw_rounded_rect(
    img: &mut RgbaImage,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    radius: f32,
    color: Rgba<u8>,
) {
    for py in y..y + h {
        for px in x..x + w {
            let alpha = rounded_rect_coverage(
                px as f32 - x as f32,
                py as f32 - y as f32,
                w as f32,
                h as f32,
                radius,
            );
            if alpha > 0.0 {
                let a = (color.0[3] as f32 * alpha) as u8;
                let pixel = Rgba([color.0[0], color.0[1], color.0[2], a]);
                blend_pixel(img, px, py, pixel);
            }
        }
    }
}

/// Compute the coverage (0.0–1.0) of a pixel within a rounded rectangle.
fn rounded_rect_coverage(lx: f32, ly: f32, w: f32, h: f32, r: f32) -> f32 {
    // Distance from the pixel center to the nearest corner circle center
    let cx = if lx < r {
        r - lx
    } else if lx > w - r - 1.0 {
        lx - (w - r - 1.0)
    } else {
        0.0
    };

    let cy = if ly < r {
        r - ly
    } else if ly > h - r - 1.0 {
        ly - (h - r - 1.0)
    } else {
        0.0
    };

    if cx > 0.0 && cy > 0.0 {
        // We're in a corner region — check distance to corner circle
        let dist = (cx * cx + cy * cy).sqrt();
        if dist > r + 0.5 {
            0.0
        } else if dist < r - 0.5 {
            1.0
        } else {
            // Anti-alias: linear interpolation in the 1px transition band
            r + 0.5 - dist
        }
    } else {
        1.0 // Inside the non-corner area
    }
}

/// Composite a source icon onto the destination image, resizing to fit `target_size`.
fn composite_icon(dst: &mut RgbaImage, src: &RgbaImage, x: u32, y: u32, target_size: u32) {
    // Simple nearest-neighbor resize for the small icon
    let (sw, sh) = (src.width(), src.height());

    for dy in 0..target_size {
        for dx in 0..target_size {
            let sx = (dx as f32 / target_size as f32 * sw as f32) as u32;
            let sy = (dy as f32 / target_size as f32 * sh as f32) as u32;

            if sx < sw && sy < sh {
                let src_pixel = *src.get_pixel(sx, sy);
                if src_pixel.0[3] > 0 {
                    blend_pixel(dst, x + dx, y + dy, src_pixel);
                }
            }
        }
    }
}

/// Draw text onto the image at the given position.
fn draw_text(
    img: &mut RgbaImage,
    font: &ab_glyph::PxScaleFont<&FontRef>,
    text: &str,
    x: u32,
    img_height: u32,
    color: Rgba<u8>,
) {
    let ascent = font.ascent();
    let descent = font.descent();
    let text_height = ascent - descent;
    let baseline_y = (img_height as f32 - text_height) / 2.0 + ascent;

    let mut cursor_x = x as f32;
    let mut prev_glyph: Option<ab_glyph::GlyphId> = None;

    for ch in text.chars() {
        let glyph_id = font.glyph_id(ch);

        if let Some(prev) = prev_glyph {
            cursor_x += font.kern(prev, glyph_id);
        }

        let glyph = glyph_id.with_scale_and_position(
            font.scale(),
            ab_glyph::point(cursor_x, baseline_y),
        );

        if let Some(outlined) = font.outline_glyph(glyph) {
            let bounds = outlined.px_bounds();
            outlined.draw(|gx, gy, coverage| {
                let px = bounds.min.x as u32 + gx;
                let py = bounds.min.y as u32 + gy;
                if px < img.width() && py < img.height() {
                    let alpha = (color.0[3] as f32 * coverage) as u8;
                    let pixel = Rgba([color.0[0], color.0[1], color.0[2], alpha]);
                    blend_pixel(img, px, py, pixel);
                }
            });
        }

        cursor_x += font.h_advance(glyph_id);
        prev_glyph = Some(glyph_id);
    }
}

/// Alpha-blend a source pixel over a destination pixel.
fn blend_pixel(img: &mut RgbaImage, x: u32, y: u32, src: Rgba<u8>) {
    if x >= img.width() || y >= img.height() {
        return;
    }

    let dst = img.get_pixel(x, y);
    let sa = src.0[3] as f32 / 255.0;
    let da = dst.0[3] as f32 / 255.0;

    let out_a = sa + da * (1.0 - sa);
    if out_a < 0.001 {
        return;
    }

    let blend = |s: u8, d: u8| -> u8 {
        ((s as f32 * sa + d as f32 * da * (1.0 - sa)) / out_a) as u8
    };

    img.put_pixel(
        x,
        y,
        Rgba([
            blend(src.0[0], dst.0[0]),
            blend(src.0[1], dst.0[1]),
            blend(src.0[2], dst.0[2]),
            (out_a * 255.0) as u8,
        ]),
    );
}
