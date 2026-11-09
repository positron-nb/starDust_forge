"""Render docs/WRITEUP.md to docs/WRITEUP.pdf (minimal Markdown -> HTML, then Edge headless print).
Supports headings, paragraphs, bullet/numbered lists, tables, bold/italic, inline code, links, blockquotes.
Usage: python scripts/writeup-pdf.py
"""
import html, re, subprocess, sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
src = root / 'docs' / 'WRITEUP.md'
out_html = root / 'docs' / 'WRITEUP.html'
out_pdf = root / 'docs' / 'WRITEUP.pdf'


def inline(t: str) -> str:
    t = html.escape(t, quote=False)
    t = re.sub(r'`([^`]+)`', r'<code>\1</code>', t)
    t = re.sub(r'\*\*([^*]+)\*\*', r'<b>\1</b>', t)
    t = re.sub(r'(?<![\w*])\*([^*]+)\*(?!\w)', r'<i>\1</i>', t)
    t = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', t)
    t = re.sub(r'&lt;(https?://[^&]+)&gt;', r'<a href="\1">\1</a>', t)
    return t


lines = src.read_text(encoding='utf-8').splitlines()
body, i = [], 0
while i < len(lines):
    l = lines[i]
    if not l.strip():
        i += 1; continue
    m = re.match(r'^(#{1,4})\s+(.*)', l)
    if m:
        n = len(m.group(1)); body.append(f'<h{n}>{inline(m.group(2))}</h{n}>'); i += 1; continue
    if l.startswith('|'):
        rows = []
        while i < len(lines) and lines[i].startswith('|'):
            rows.append([c.strip() for c in lines[i].strip().strip('|').split('|')]); i += 1
        head, rest = rows[0], [r for r in rows[1:] if not all(re.fullmatch(r':?-+:?', c) for c in r)]
        body.append('<table><tr>' + ''.join(f'<th>{inline(c)}</th>' for c in head) + '</tr>' +
                    ''.join('<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in r) + '</tr>' for r in rest) + '</table>')
        continue
    if re.match(r'^\s*([-*]|\d+\.)\s', l):
        ordered = bool(re.match(r'^\s*\d+\.', l)); tag = 'ol' if ordered else 'ul'; items = []
        while i < len(lines) and re.match(r'^\s*([-*]|\d+\.)\s', lines[i]):
            items.append(re.sub(r'^\s*([-*]|\d+\.)\s+', '', lines[i])); i += 1
        body.append(f'<{tag}>' + ''.join(f'<li>{inline(x)}</li>' for x in items) + f'</{tag}>'); continue
    if l.startswith('>'):
        body.append(f'<blockquote>{inline(l.lstrip("> "))}</blockquote>'); i += 1; continue
    para = []
    while i < len(lines) and lines[i].strip() and not re.match(r'^(#|\||\s*([-*]|\d+\.)\s|>)', lines[i]):
        para.append(lines[i]); i += 1
    body.append(f'<p>{inline(" ".join(para))}</p>')

css = """@page { size: A4; margin: 14mm 14mm; }
body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 9.6pt; line-height: 1.35; color: #111; }
h1 { font-size: 15pt; margin: 0 0 6px; } h2 { font-size: 11.5pt; margin: 10px 0 4px; border-bottom: 1px solid #ccc; }
p, li { margin: 3px 0; } ul, ol { margin: 3px 0 3px 18px; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 5px 0; font-size: 8.6pt; }
th, td { border: 1px solid #bbb; padding: 3px 5px; vertical-align: top; text-align: left; } th { background: #f0f0f0; }
code { font-family: Consolas, monospace; font-size: 8.6pt; background: #f4f4f4; padding: 0 2px; }
blockquote { color: #555; margin: 4px 0; padding-left: 8px; border-left: 3px solid #ddd; } a { color: #0645ad; }"""
out_html.write_text(f'<!doctype html><html><head><meta charset="utf-8"><title>Forge Agent write-up</title><style>{css}</style></head><body>{"".join(body)}</body></html>', encoding='utf-8')

edge = r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
subprocess.run([edge, '--headless=new', '--disable-gpu', '--no-pdf-header-footer', f'--print-to-pdf={out_pdf}', out_html.as_uri()],
               check=True, capture_output=True, timeout=120)
try:
    from pypdf import PdfReader
    print(f'{out_pdf} pages={len(PdfReader(str(out_pdf)).pages)}')
except ImportError:
    print(f'{out_pdf} written')
