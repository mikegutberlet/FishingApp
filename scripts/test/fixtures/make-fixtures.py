#!/usr/bin/env python3
"""Writes the two test books (stdlib only): a two-page PDF with a text layer and a two-chapter EPUB.
The words are written for the tests; they come from no book. Run from anywhere; files land beside this script."""
import os, zipfile
here = os.path.dirname(os.path.abspath(__file__))

PAGES = [
    ["Convict Lake sits below Mount Morrison and fishes well in spring.",
     "The inlet holds browns after ice-out, and the far shore drops fast",
     "into deep water where the rainbows cruise in the first hour of light."],
    ["Crowley Lake opens the last Saturday in April with crowds along McGee Bay.",
     "Later in the season the perch move shallow and the big browns follow them",
     "along the weed lines on the north side as the water warms."],
]

def pdf(path):
    objs = []  # (num, bytes)
    def add(body): objs.append(body); return len(objs)
    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    page_ids = []
    for lines in PAGES:
        text = b"BT /F1 12 Tf 72 720 Td 14 TL " + b" ".join(b"(" + l.encode() + b") Tj T*" for l in lines) + b" ET"
        content = add(b"<< /Length %d >>\nstream\n" % len(text) + text + b"\nendstream")
        page_ids.append(add(b"PLACEHOLDER-%d" % content))
    pages_id = len(objs) + 1
    for i, pid in enumerate(page_ids):
        content = int(objs[pid - 1].split(b"-")[1])
        objs[pid - 1] = b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>" % (pages_id, font, content)
    add(b"<< /Type /Pages /Kids [" + b" ".join(b"%d 0 R" % p for p in page_ids) + b"] /Count %d >>" % len(page_ids))
    catalog = add(b"<< /Type /Catalog /Pages %d 0 R >>" % pages_id)
    info = add(b"<< /Title (Fixture Guide) /Author (Test Author) >>")
    out = b"%PDF-1.4\n"; offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out)); out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root %d 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, catalog, info, xref)
    open(path, "wb").write(out)

CHAPTERS = [("Mono County", PAGES[0]), ("Inyo County", PAGES[1])]

def epub(path):
    z = zipfile.ZipFile(path, "w")
    z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
    z.writestr("META-INF/container.xml", '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
    items = "".join(f'<item id="c{i}" href="ch{i}.xhtml" media-type="application/xhtml+xml"/>' for i in range(1, 3))
    spine = "".join(f'<itemref idref="c{i}"/>' for i in range(1, 3))
    z.writestr("OEBPS/content.opf", f'<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">fixture</dc:identifier><dc:title>Fixture Guide</dc:title><dc:creator>Test Author</dc:creator><dc:language>en</dc:language></metadata><manifest>{items}</manifest><spine>{spine}</spine></package>')
    for i, (title, lines) in enumerate(CHAPTERS, 1):
        z.writestr(f"OEBPS/ch{i}.xhtml", f'<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>{title}</title></head><body><h1>{title}</h1><p>{" ".join(lines)}</p><p>A second paragraph long enough to be kept as its own passage by the splitter, about nothing in particular.</p></body></html>')
    z.close()

pdf(os.path.join(here, "two-pages.pdf")); epub(os.path.join(here, "book.epub"))
print("wrote two-pages.pdf and book.epub")
