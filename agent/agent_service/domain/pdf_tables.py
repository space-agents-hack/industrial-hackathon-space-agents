"""Tables on a regulation PDF page, read as rows under their column headers (#52, SYS-23).

Why: pdfium's text layer gives a table line by line as the page draws it. A cell that wraps onto
two lines, or a column of crosses, comes out as loose lines ("x\\nx\\nx"), and nobody can tell any
more which value belongs to which row and column. A writer asked for one requirement per row
cannot rebuild the rows.

How: the challenge's PDFs were rendered from HTML by headless Chrome, which draws every cell's
border as a thin filled rectangle (0.75 pt). Those rectangles give the grid; each character goes
to the grid slot its centre is in; two neighbouring slots with no border between them are one
cell (a header over several columns, a reference over several rows). Header rows are the top rows
whose cells are all heavier than the rest of the table, which is how Chrome draws `<th>`.

What this does NOT do:
  - find tables without borders. A table drawn with spaces or without rules stays as lines, as
    before; nothing is lost, it is just not regrouped.
  - join a table that continues on the next page into one block. Each page's part is read on its
    own, under its own repeated header row, or under the previous page's headers if it has the
    same columns and no header row of its own.
  - read text inside pictures. A picture in a cell is not text.
"""

import bisect
import ctypes
from collections import Counter
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pypdfium2 import PdfPage, PdfTextPage

# A border is a filled rectangle at most this thick, and at least this long. Chrome draws 0.75 pt;
# a shaded cell is a rectangle too, but thick in both directions.
_THIN = 2.0
_LONG = 2.0
# Borders closer than this are one line: neighbouring cells each draw their own border, and the
# two land a fraction of a point apart.
_SAME = 1.5
# Smaller than two by two is a rule or a frame around one block of text, not a table.
_MIN_ROWS = 2
_MIN_COLUMNS = 2
# Up to this many body rows, every value carries its column's name. Past it, the names are written
# once (see _render). About a page of rows: a reader can still see the header line above.
_LONG_TABLE = 20


@dataclass(frozen=True)
class _Segment:
    horizontal: bool
    left: float
    bottom: float
    right: float
    top: float


@dataclass(frozen=True)
class Table:
    # One line per body row: "Header A: value; Header B: value". Header rows are not repeated as
    # lines of their own: their text is in every row.
    rows: list[str]
    # Which of the page's lines (indexes into `line_starts`) the rows replace.
    lines: tuple[int, ...]
    # Column edges in points and the header of each column ("" if none), for the next page's part.
    columns: tuple[float, ...]
    headers: tuple[str, ...]


def borders(page: "PdfPage") -> list[_Segment]:
    """Thin rectangles on the page: the candidates for cell borders."""
    import pypdfium2.raw as pdfium_c

    segments = []
    # Depth 3: Chrome puts some tables inside a form object.
    for obj in page.get_objects(filter=[pdfium_c.FPDF_PAGEOBJ_PATH], max_depth=3):
        left, bottom, right, top = obj.get_bounds()
        width, height = right - left, top - bottom
        if height <= _THIN and width >= _LONG:
            segments.append(_Segment(True, left, bottom, right, top))
        elif width <= _THIN and height >= _LONG:
            segments.append(_Segment(False, left, bottom, right, top))
    return segments


def _groups(segments: list[_Segment]) -> list[list[_Segment]]:
    """Segments that touch, transitively: one group per table (or per drawing made of rules)."""
    parent = list(range(len(segments)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    # Sorted by left edge, so only segments that start before this one ends need comparing.
    order = sorted(range(len(segments)), key=lambda i: segments[i].left)
    for position, i in enumerate(order):
        a = segments[i]
        for j in order[position + 1 :]:
            b = segments[j]
            if b.left > a.right + _SAME:
                break
            if b.bottom <= a.top + _SAME and a.bottom <= b.top + _SAME:
                parent[find(i)] = find(j)
    groups: dict[int, list[_Segment]] = {}
    for i, segment in enumerate(segments):
        groups.setdefault(find(i), []).append(segment)
    return list(groups.values())


def _positions(values: list[float]) -> list[float]:
    """Distinct coordinates, merging those within _SAME of each other."""
    merged: list[list[float]] = []
    for value in sorted(values):
        if merged and value - merged[-1][-1] <= _SAME:
            merged[-1].append(value)
        else:
            merged.append([value])
    return [sum(group) / len(group) for group in merged]


@dataclass
class _Grid:
    xs: list[float]  # column edges, left to right
    ys: list[float]  # row edges, top to bottom
    segments: list[_Segment]
    # Each border's span along its edge, by edge index: what `ruled` looks up. Built once, because
    # R49's drive cycles have 900 borders a page and asking all of them for every cell was most of
    # the time.
    _vertical: dict[int, list[tuple[float, float]]] = field(default_factory=dict)
    _horizontal: dict[int, list[tuple[float, float]]] = field(default_factory=dict)
    _ys_up: list[float] = field(default_factory=list)

    def __post_init__(self) -> None:
        # Ascending copies of the edges for bisect; ys is kept top to bottom for reading order.
        self._ys_up = self.ys[::-1]
        for s in self.segments:
            if s.horizontal:
                edge = _nearest(self.ys, (s.bottom + s.top) / 2)
                if edge is not None:
                    self._horizontal.setdefault(edge, []).append((s.left, s.right))
            else:
                edge = _nearest(self.xs, (s.left + s.right) / 2)
                if edge is not None:
                    self._vertical.setdefault(edge, []).append((s.bottom, s.top))

    @property
    def rows(self) -> int:
        return len(self.ys) - 1

    @property
    def columns(self) -> int:
        return len(self.xs) - 1

    def slot(self, x: float, y: float) -> tuple[int, int] | None:
        if not (self.xs[0] <= x <= self.xs[-1] and self.ys[-1] <= y <= self.ys[0]):
            return None
        column = min(max(bisect.bisect_left(self.xs, x) - 1, 0), self.columns - 1)
        from_bottom = min(max(bisect.bisect_left(self._ys_up, y) - 1, 0), self.rows - 1)
        return self.rows - 1 - from_bottom, column

    def ruled(self, *, horizontal: bool, edge: int, across: float) -> bool:
        """Whether a border runs along edge number `edge` (of ys if horizontal, else of xs) and
        covers `across`."""
        spans = (self._horizontal if horizontal else self._vertical).get(edge, [])
        return any(low <= across <= high for low, high in spans)

    def cells(self) -> list[list[int]]:
        """For each slot (row, column), the id of the cell it belongs to."""
        ids = list(range(self.rows * self.columns))

        def find(i: int) -> int:
            while ids[i] != i:
                ids[i] = ids[ids[i]]
                i = ids[i]
            return i

        for row in range(self.rows):
            middle_y = (self.ys[row] + self.ys[row + 1]) / 2
            for column in range(self.columns):
                middle_x = (self.xs[column] + self.xs[column + 1]) / 2
                here = row * self.columns + column
                if column + 1 < self.columns and not self.ruled(
                    horizontal=False, edge=column + 1, across=middle_y
                ):
                    ids[find(here)] = find(here + 1)
                if row + 1 < self.rows and not self.ruled(
                    horizontal=True, edge=row + 1, across=middle_x
                ):
                    ids[find(here)] = find(here + self.columns)
        return [
            [find(row * self.columns + column) for column in range(self.columns)]
            for row in range(self.rows)
        ]


def _nearest(edges: list[float], value: float) -> int | None:
    """The index of the edge within _SAME of `value`, if any."""
    best = min(range(len(edges)), key=lambda i: abs(edges[i] - value))
    return best if abs(edges[best] - value) <= _SAME else None


def _grid(group: list[_Segment]) -> _Grid | None:
    horizontal = [s for s in group if s.horizontal]
    vertical = [s for s in group if not s.horizontal]
    if not horizontal or not vertical:
        return None
    xs = _positions([(s.left + s.right) / 2 for s in vertical])
    ys = _positions([(s.bottom + s.top) / 2 for s in horizontal])[::-1]
    if len(xs) - 1 < _MIN_COLUMNS or len(ys) - 1 < _MIN_ROWS:
        return None
    return _Grid(xs, ys, group)


def _char_box(textpage: "PdfTextPage", index: int) -> tuple[float, float] | None:
    import pypdfium2.raw as pdfium_c

    left, right, bottom, top = (ctypes.c_double() for _ in range(4))
    if not pdfium_c.FPDFText_GetCharBox(textpage.raw, index, left, right, bottom, top):
        return None
    return (left.value + right.value) / 2, (bottom.value + top.value) / 2


def read_tables(
    page: "PdfPage",
    textpage: "PdfTextPage",
    text: str,
    line_starts: list[int],
    previous: "Table | None" = None,
) -> tuple[list["Table"], int]:
    """The bordered tables on a page, top to bottom, with each body row as one line, and how
    many sets of borders were not read as a table because they cut through words.

    `text` is the page's text range and `line_starts` the offset in it where each line starts:
    a character is read only if its line starts inside a table, so a page without tables costs
    one pass over its drawing objects and nothing per character. `previous` is the last table of
    the page before, whose headers a table without its own header row takes over if it has the
    same columns (a table that goes on over a page break without repeating its header).
    """
    import pypdfium2.raw as pdfium_c

    grids = [g for g in map(_grid, _groups(borders(page))) if g is not None]
    grids.sort(key=lambda g: -g.ys[0])
    if not grids:
        return [], 0
    ends = [*line_starts[1:], len(text)]
    # A line belongs to the table its first visible character is in.
    leads = []
    for start, end in zip(line_starts, ends, strict=True):
        lead = start + (len(text[start:end]) - len(text[start:end].lstrip()))
        leads.append(_char_box(textpage, lead) if lead < end else None)
    tables: list[Table] = []
    taken: set[int] = set()
    misfits = 0
    for grid in grids:
        cells = grid.cells()
        content: dict[int, list[str]] = {}
        weights: dict[int, list[int]] = {}
        consumed: list[int] = []
        # Borders never cut through a word in a real table. If they do, these rules are not the
        # table's (a frame, a chart's axes, rules under a formula) and the lines stay as they are.
        cut = False
        for number, (start, end) in enumerate(zip(line_starts, ends, strict=True)):
            centre = leads[number]
            # A table drawn inside another's cell: its lines are already in the outer table.
            if centre is None or number in taken or grid.slot(*centre) is None:
                continue
            consumed.append(number)
            last: int | None = None
            in_word = False
            for index in range(start, end):
                char = text[index]
                if char.isspace() or pdfium_c.FPDFText_IsGenerated(textpage.raw, index) == 1:
                    if last is not None:
                        content[last].append(" ")
                    in_word = False
                    continue
                centre = _char_box(textpage, index)
                slot = grid.slot(*centre) if centre else None
                if slot is None:
                    cut = True
                    break
                cell = cells[slot[0]][slot[1]]
                if in_word and cell != last:
                    cut = True
                    break
                if last is not None and cell != last and content.get(cell):
                    content[cell].append(" ")
                content.setdefault(cell, []).append(char)
                weights.setdefault(cell, []).append(
                    pdfium_c.FPDFText_GetFontWeight(textpage.raw, index)
                )
                last, in_word = cell, True
            if cut:
                break
        if cut:
            misfits += 1
            continue
        if not content:
            continue
        carry = previous if not tables else None
        tables.append(_render(grid, cells, content, weights, consumed, carry))
        taken.update(consumed)
    return tables, misfits


def _clean(chars: list[str]) -> str:
    # Chrome writes a hyphen that falls at a line break as U+FFFE (as in paragraphs.py).
    return " ".join("".join(chars).replace("\ufffe", "-").split())


def _render(
    grid: _Grid,
    cells: list[list[int]],
    content: dict[int, list[str]],
    weights: dict[int, list[int]],
    consumed: list[int],
    previous: "Table | None",
) -> "Table":
    value = {cell: _clean(chars) for cell, chars in content.items()}
    # The weight the last row with text is set in: that row is body, whatever the header does.
    # Header cells are heavier than it. Compared with the table's own body and not with a fixed
    # 700, because pdfium reports a font's weight as the font declares it: 550 for regular and
    # 1056 for an italic header in one PDF (R171). Not the weight most of the table is set in: in
    # a short table with long headers that is the headers' own.
    last = next(row for row in reversed(cells) if any(weights.get(cell) for cell in row))
    counts = Counter(w for cell in dict.fromkeys(last) for w in weights.get(cell, []))
    body = counts.most_common(1)[0][0]

    def is_header(cell: int) -> bool:
        cell_weights = weights.get(cell, [])
        heavier = sum(w > body for w in cell_weights)
        return bool(cell_weights) and heavier * 2 > len(cell_weights)

    header_rows = 0
    for row in cells:
        filled = [cell for cell in dict.fromkeys(row) if value.get(cell)]
        if not filled or not all(is_header(cell) for cell in filled):
            break
        header_rows += 1
    if header_rows == grid.rows:
        header_rows = 0
    # A header cell across the whole width is a title ("Tabled requirements expressed in cd"):
    # written once above the rows, not put in front of every column's name.
    titles = [
        value[row[0]] for row in cells[:header_rows] if len(set(row)) == 1 and value.get(row[0])
    ]
    headers = []
    for column in range(grid.columns):
        names = [
            value.get(cells[row][column], "")
            for row in range(header_rows)
            if len(set(cells[row])) > 1
        ]
        headers.append(" ".join(dict.fromkeys(n for n in names if n)))
    if (
        header_rows == 0
        and previous is not None
        and len(previous.columns) == len(grid.xs)
        and all(abs(a - b) <= 2 * _SAME for a, b in zip(previous.columns, grid.xs, strict=True))
    ):
        headers = list(previous.headers)

    body_rows = cells[header_rows:]
    if len(body_rows) > _LONG_TABLE and any(headers):
        # A long table (a drive cycle, a list of test points): the header row once and each row
        # as its values in column order, an empty cell left empty so the columns still line up.
        # Repeating the names on every row made R49's drive cycle five times longer (24,000 to
        # 121,000 characters), which every writer window and embedding then pays for.
        lines = ["; ".join(headers)]
        for row in body_rows:
            values = [value.get(cell, "") for column, cell in enumerate(row)
                      if cell not in row[:column]]  # fmt: skip
            if any(values):
                lines.append("; ".join(values))
        return Table([*titles, *lines], tuple(consumed), tuple(grid.xs), tuple(headers))
    lines = []
    used: set[str] = set()
    for row in body_rows:
        parts = []
        for column, cell in enumerate(row):
            if cell in row[:column] or not value.get(cell):
                continue
            parts.append(f"{headers[column]}: {value[cell]}" if headers[column] else value[cell])
            used.add(headers[column])
        if parts:
            lines.append("; ".join(parts))
    # A column with no value in any row (a form left for the manufacturer to fill in) would lose
    # its header: the header row is then written as a line of its own, once.
    names = list(dict.fromkeys(h for h in headers if h))
    if any(name not in used for name in names):
        lines.insert(0, "; ".join(names))
    lines[:0] = titles
    return Table(
        rows=lines,
        lines=tuple(consumed),
        columns=tuple(grid.xs),
        headers=tuple(headers),
    )
