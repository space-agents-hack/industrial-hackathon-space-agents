"""Pictures in a regulation PDF: where they are, and what they look like for a vision model (#52).

Why: the challenge's PDFs put test set-ups, dimensions, angles and charts in raster pictures, and
2,569 of their 2,572 pictures of at least 40 pt have no text in the text layer. Whatever they say
was invisible to the writer. In 8 picked at random, 6 carried values a requirement needs.

A picture is named by the sha256 of its image stream as stored in the PDF, so the same picture in
a base and a latest version, or an approval mark in many regulations, is described once
(figures.py keeps the descriptions per organisation).

What this does NOT do:
  - describe anything. figures.py asks the model; this only finds and renders.
  - see vector drawings. A drawing made of lines and text is already in the text layer, and a
    drawing made of lines alone has nothing to read for a text-only reader either.
  - keep pictures smaller than _MIN_SIDE: bullets, ticks, icons.
"""

import hashlib
import io
from dataclasses import dataclass
from typing import TYPE_CHECKING

from agent_service.pdf_lock import PDFIUM

if TYPE_CHECKING:
    from pypdfium2 import PdfPage

# Smaller than this on either side is a tick, a bullet or an inline icon: 508 of the 92 PDFs'
# 3,080 pictures. Above it are still some marks and symbols; the model says so in one line.
_MIN_SIDE = 40.0
# The longest side of what the model is sent, in pixels. Enough to read a dimension label; the
# vision models scale larger images down anyway, and pay per pixel.
_MAX_PIXELS = 1500
# Never enlarge a picture more than this: past it the model reads blur, not detail.
_MAX_SCALE = 4.0


@dataclass(frozen=True)
class Figure:
    page: int  # from 1, like Paragraph.page_start
    position: int  # among the page's pictures, in drawing order
    sha256: str
    # In PDF points, y upwards.
    left: float
    bottom: float
    right: float
    top: float

    @property
    def width(self) -> float:
        return self.right - self.left

    @property
    def height(self) -> float:
        return self.top - self.bottom


def page_figures(page: "PdfPage", number: int) -> list[Figure]:
    """The pictures on one page worth describing. The caller holds PDFIUM."""
    import pypdfium2 as pdfium
    import pypdfium2.raw as pdfium_c

    found: list[Figure] = []
    # Depth 3: Chrome puts some pictures inside a form object.
    for obj in page.get_objects(filter=[pdfium_c.FPDF_PAGEOBJ_IMAGE], max_depth=3):
        left, bottom, right, top = obj.get_bounds()
        if right - left < _MIN_SIDE or top - bottom < _MIN_SIDE:
            continue
        assert isinstance(obj, pdfium.PdfImage)
        digest = hashlib.sha256(bytes(obj.get_data(decode_simple=False))).hexdigest()
        found.append(Figure(number, len(found), digest, left, bottom, right, top))
    return found


def figures(pdf: bytes) -> list[Figure]:
    """Every picture worth describing, page by page."""
    import pypdfium2 as pdfium

    with PDFIUM:
        document = pdfium.PdfDocument(pdf)
        try:
            found: list[Figure] = []
            for index in range(len(document)):
                page = document[index]
                try:
                    found += page_figures(page, index + 1)
                finally:
                    page.close()
            return found
        finally:
            document.close()


def render(pdf: bytes, wanted: list[Figure]) -> dict[str, bytes]:
    """PNG of each figure as it appears on its page (what is drawn over it included), by sha256.

    The page region is rendered rather than the image stream extracted: a stream can be a mask, a
    CMYK JPEG or split into strips, while the rendered page is what a reader sees."""
    import pypdfium2 as pdfium

    out: dict[str, bytes] = {}
    with PDFIUM:
        document = pdfium.PdfDocument(pdf)
        try:
            for figure in wanted:
                if figure.sha256 in out:
                    continue
                page = document[figure.page - 1]
                try:
                    width, height = page.get_size()
                    scale = min(_MAX_SCALE, _MAX_PIXELS / max(figure.width, figure.height))
                    bitmap = page.render(
                        scale=scale,  # pyright: ignore[reportArgumentType] (a float works)
                        crop=(
                            max(figure.left, 0),
                            max(figure.bottom, 0),
                            max(width - figure.right, 0),
                            max(height - figure.top, 0),
                        ),
                    )
                    buffer = io.BytesIO()
                    bitmap.to_pil().save(buffer, format="PNG")
                    out[figure.sha256] = buffer.getvalue()
                finally:
                    page.close()
        finally:
            document.close()
    return out
