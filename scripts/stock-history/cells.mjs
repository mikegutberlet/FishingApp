// Tables in saved web pages, read from page text whose table cells are separated by " | " (fetch-time tableText).
// A header is a run of cells that each name a different column; rows are then found by their date cell, so a stray
// empty cell or a note under the header doesn't shift the columns.

const clean = s => s.replace(/\s+/g, ' ').trim();

export function cellTables(text, cols, { required = ['date'], dateOf }) {
  const cells = text.split('|').map(clean);
  const rows = [];
  for (let i = 0; i < cells.length; i++) {
    const head = [];
    for (let k = i; k < cells.length; k++) {
      const col = Object.keys(cols).find(c => cols[c].test(cells[k]));
      if (!col || head.includes(col)) break;
      head.push(col);
    }
    if (!required.every(c => head.includes(c))) continue;
    const w = head.length, d = head.indexOf('date');
    let k = i + w, misses = 0;
    // Rows follow until a few cells in a row aren't the start of one (the end of the table).
    while (k < cells.length && misses < w + 3) {
      const date = dateOf(cells[k]);
      if (!date || k - d < i + w) { k++; misses++; continue; }
      const r = Object.fromEntries(head.map((c, n) => [c, cells[k - d + n] ?? '']));
      r.date = date;
      rows.push(r);
      k += w - d; misses = 0;
    }
    i = k - 1;
  }
  return rows;
}
