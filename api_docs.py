#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MotorScope 的零依赖 Markdown -> HTML 渲染器与 ``/api/docs`` 页面.

只使用 Python 标准库。支持本项目 ``API.md`` 用到的语法：
``#/##/###`` 标题、段落、无序/有序列表、GFM 表格、围栏代码块、
行内 ``code``、``**bold**``、``>`` 引用和 ``---`` 分隔线。

安全约定：所有来自 Markdown 的文本都会先做 HTML 转义；代码块与行内
code 只转义一次，不会出现 ``&amp;lt;`` 之类的二次转义。

页面每次请求都由调用方重新读取 ``API.md``，因此改文档不需要重启服务。
"""
from __future__ import annotations

import html
import os
import re
from string import Template
from typing import List, Optional, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
DOC_PATH = os.path.join(HERE, "API.md")

_FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+.#-]*)\s*$")
_HEADING_RE = re.compile(r"^ {0,3}(#{1,6})\s+(.*?)\s*$")
_UL_RE = re.compile(r"^ {0,3}[-*+]\s+(.*)$")
_OL_RE = re.compile(r"^ {0,3}(\d+)[.)]\s+(.*)$")
_HR_RE = re.compile(r"^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$")
_TABLE_SEP_CELL_RE = re.compile(r"^:?-{3,}:?$")
_CODE_SPAN_RE = re.compile(r"`([^`\n]+)`")
_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")


def read_doc(path: Optional[str] = None) -> str:
    """读取 Markdown 源文件（默认仓库根目录的 API.md）。"""
    with open(path or DOC_PATH, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def _escape(text: str) -> str:
    """转义文本节点；引号不需要转义（只插入元素正文）。"""
    return html.escape(text, quote=False)


def _inline_plain(text: str) -> str:
    escaped = _escape(text)
    return _BOLD_RE.sub(r"<strong>\1</strong>", escaped)


def _inline(text: str) -> str:
    """渲染行内语法；先切 code span，避免 code 内部再解析 bold/HTML。"""
    out: List[str] = []
    pos = 0
    for m in _CODE_SPAN_RE.finditer(text):
        out.append(_inline_plain(text[pos:m.start()]))
        out.append("<code>%s</code>" % _escape(m.group(1)))
        pos = m.end()
    out.append(_inline_plain(text[pos:]))
    return "".join(out)


def _split_row(line: str) -> List[str]:
    """按未转义的 | 切分表格行；``\\|`` 还原为普通 |。"""
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|") and not s.endswith("\\|"):
        s = s[:-1]
    return [cell.strip().replace("\\|", "|")
            for cell in re.split(r"(?<!\\)\|", s)]


def _is_table_sep(line: str) -> bool:
    if "|" not in line:
        return False
    cells = _split_row(line)
    return bool(cells) and all(_TABLE_SEP_CELL_RE.match(c) for c in cells)


def _alignment(cell: str) -> str:
    left = cell.startswith(":")
    right = cell.endswith(":")
    if left and right:
        return "center"
    if right:
        return "right"
    if left:
        return "left"
    return ""


def _is_block_start(lines: List[str], i: int) -> bool:
    line = lines[i]
    if not line.strip():
        return True
    if _FENCE_RE.match(line) or _HEADING_RE.match(line) or _HR_RE.match(line):
        return True
    if line.lstrip().startswith(">"):
        return True
    if _UL_RE.match(line) or _OL_RE.match(line):
        return True
    if "|" in line and i + 1 < len(lines) and _is_table_sep(lines[i + 1]):
        return True
    return False


def _render_table(lines: List[str], i: int) -> Tuple[str, int]:
    header = _split_row(lines[i])
    sep = _split_row(lines[i + 1])
    aligns = [_alignment(c) for c in sep]
    cols = len(header)
    parts = ['<div class="table-wrap"><table>', "<thead><tr>"]
    for idx, cell in enumerate(header[:cols]):
        style = ' style="text-align:%s"' % aligns[idx] if idx < len(aligns) and aligns[idx] else ""
        parts.append("<th%s>%s</th>" % (style, _inline(cell)))
    parts.append("</tr></thead><tbody>")
    i += 2
    while i < len(lines):
        line = lines[i]
        if not line.strip() or "|" not in line:
            break
        cells = _split_row(line)
        cells = (cells + [""] * cols)[:cols]
        parts.append("<tr>")
        for idx, cell in enumerate(cells):
            style = ' style="text-align:%s"' % aligns[idx] if idx < len(aligns) and aligns[idx] else ""
            parts.append("<td%s>%s</td>" % (style, _inline(cell)))
        parts.append("</tr>")
        i += 1
    parts.append("</tbody></table></div>")
    return "\n".join(parts), i


def _render_list(lines: List[str], i: int, ordered: bool) -> Tuple[str, int]:
    """渲染列表；支持条目内缩进的续行（API.md 里有跨行的列表项）。"""
    item_re = _OL_RE if ordered else _UL_RE
    text_group = 2 if ordered else 1
    items: List[str] = []
    while i < len(lines):
        m = item_re.match(lines[i])
        if not m:
            break
        parts = [m.group(text_group)]
        i += 1
        while i < len(lines) and lines[i].strip():
            if _UL_RE.match(lines[i]) or _OL_RE.match(lines[i]):
                break
            if _is_block_start(lines, i):
                break
            parts.append(lines[i].strip())
            i += 1
        items.append("<li>%s</li>" % _inline("\n".join(parts)))
    tag = "ol" if ordered else "ul"
    return "<%s>\n%s\n</%s>" % (tag, "\n".join(items), tag), i


def render_markdown(markdown_text: str) -> str:
    """把 Markdown 渲染为 HTML 片段（不包裹页面骨架）。"""
    lines = markdown_text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out: List[str] = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        if not line.strip():
            i += 1
            continue

        # 围栏代码块：内容只转义一次，原样保留空行与缩进。
        fence = _FENCE_RE.match(line)
        if fence:
            marker = fence.group(1)
            lang = fence.group(2)
            code: List[str] = []
            i += 1
            close_re = re.compile(r"^ {0,3}%s{%d,}\s*$" % (re.escape(marker[0]), len(marker)))
            while i < n and not close_re.match(lines[i]):
                code.append(lines[i])
                i += 1
            if i < n:
                i += 1  # 跳过结束围栏
            body = _escape("\n".join(code))
            cls = ' class="language-%s"' % _escape(lang) if lang else ""
            out.append("<pre><code%s>%s</code></pre>" % (cls, body))
            continue

        heading = _HEADING_RE.match(line)
        if heading:
            level = len(heading.group(1))
            text = heading.group(2).rstrip("#").rstrip()
            out.append("<h%d>%s</h%d>" % (level, _inline(text), level))
            i += 1
            continue

        if _HR_RE.match(line):
            out.append("<hr>")
            i += 1
            continue

        # 表格：当前行有 |，下一行是 | --- | 分隔行。
        if "|" in line and i + 1 < n and _is_table_sep(lines[i + 1]):
            table, i = _render_table(lines, i)
            out.append(table)
            continue

        if line.lstrip().startswith(">"):
            quoted: List[str] = []
            while i < n and lines[i].lstrip().startswith(">"):
                quoted.append(re.sub(r"^ {0,3}> ?", "", lines[i]))
                i += 1
            out.append("<blockquote>\n%s\n</blockquote>" % render_markdown("\n".join(quoted)))
            continue

        ul = _UL_RE.match(line)
        if ul:
            rendered, i = _render_list(lines, i, ordered=False)
            out.append(rendered)
            continue

        ol = _OL_RE.match(line)
        if ol:
            rendered, i = _render_list(lines, i, ordered=True)
            out.append(rendered)
            continue

        # 普通段落：直到空行或下一个块级结构。
        para: List[str] = []
        while i < n and lines[i].strip() and not (para and _is_block_start(lines, i)):
            para.append(lines[i].strip())
            i += 1
        out.append("<p>%s</p>" % _inline("\n".join(para)))

    return "\n".join(out)


_PAGE = Template("""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>MotorScope API 文档</title>
<link rel="icon" href="data:,">
<style>
:root {
  --bg: #060a12;
  --bg2: #0a1120;
  --panel: #0d1626;
  --panel2: #101c30;
  --line: #1b2a44;
  --line2: #243753;
  --text: #dbe7f5;
  --muted: #7f93ad;
  --muted2: #5c7089;
  --cyan: #22d3ee;
  --amber: #f59e0b;
  --green: #34d399;
  --violet: #a78bfa;
  --radius: 12px;
  --mono: "JetBrains Mono", "Cascadia Code", Consolas, "SFMono-Regular", monospace;
  --sans: "Inter", "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background:
    radial-gradient(1100px 600px at 18% -10%, rgba(34, 211, 238, .10), transparent 60%),
    radial-gradient(900px 500px at 95% 0%, rgba(167, 139, 250, .07), transparent 55%),
    var(--bg);
  color: var(--text);
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.7;
  min-height: 100vh;
}
a { color: var(--cyan); text-decoration: none; }
a:hover { text-decoration: underline; }
::selection { background: rgba(34, 211, 238, .28); color: #f8fafc; }

.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 24px;
  background: rgba(6, 10, 18, .82);
  border-bottom: 1px solid var(--line);
  backdrop-filter: blur(12px);
}
.brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
.logo {
  width: 25px; height: 25px; flex: 0 0 25px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 7px;
  background: linear-gradient(135deg, rgba(34,211,238,.24), rgba(167,139,250,.18));
  border: 1px solid rgba(34,211,238,.42);
  color: var(--cyan);
  font-family: var(--mono); font-size: 13px; font-weight: 700;
}
.brand-name { font-family: var(--mono); font-size: 13px; letter-spacing: .05em; color: #e6f2ff; }
.version {
  font-family: var(--mono); font-size: 10.5px; color: var(--cyan);
  background: rgba(34,211,238,.09);
  border: 1px solid rgba(34,211,238,.28);
  border-radius: 999px; padding: 2px 8px; white-space: nowrap;
}
.actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.pill {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 11px; border-radius: 7px;
  border: 1px solid var(--line2);
  background: rgba(16,28,48,.72);
  color: var(--muted); font-size: 11.5px; white-space: nowrap;
}
.pill:hover { color: var(--text); border-color: #35507a; text-decoration: none; }
.pill.primary { color: var(--cyan); border-color: rgba(34,211,238,.38); background: rgba(34,211,238,.08); }

main { width: min(1080px, calc(100% - 40px)); margin: 0 auto; padding: 26px 0 56px; }
.docmeta {
  display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px;
  margin-bottom: 20px; padding: 10px 14px;
  border: 1px solid var(--line); border-radius: var(--radius);
  background: linear-gradient(180deg, rgba(13,22,38,.72), rgba(9,15,27,.56));
  color: var(--muted); font-size: 11.5px;
}
.docmeta .dot { color: var(--muted2); }
.docmeta a { margin-left: auto; font-family: var(--mono); font-size: 11px; }

.doc {
  padding: 30px 36px 36px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: linear-gradient(180deg, rgba(13,22,38,.84), rgba(8,13,24,.76));
  box-shadow: 0 24px 70px rgba(0,0,0,.28);
  overflow-wrap: break-word;
}
.doc > :first-child { margin-top: 0; }
.doc > :last-child { margin-bottom: 0; }
.doc h1, .doc h2, .doc h3, .doc h4 {
  color: #f2f8ff;
  line-height: 1.32;
  letter-spacing: -.01em;
  margin: 1.7em 0 .65em;
  scroll-margin-top: 72px;
}
.doc h1 {
  font-size: 27px;
  margin-top: 0;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--line2);
}
.doc h1::after {
  content: "";
  display: block;
  width: 84px;
  height: 2px;
  margin: 14px 0 -15px;
  background: linear-gradient(90deg, var(--cyan), transparent);
  border-radius: 2px;
}
.doc h2 {
  font-size: 20px;
  padding-left: 12px;
  border-left: 3px solid var(--cyan);
}
.doc h3 { font-size: 16px; color: #cfe6f5; }
.doc h4 { font-size: 14.5px; color: #b9d2e7; }
.doc p { margin: .7em 0; }
.doc strong { color: #f8fafc; font-weight: 650; }
.doc ul, .doc ol { margin: .65em 0; padding-left: 1.55em; }
.doc li { margin: .32em 0; }
.doc li::marker { color: var(--cyan); }
.doc hr { border: 0; height: 1px; background: var(--line2); margin: 2em 0; }
.doc blockquote {
  margin: 1.1em 0;
  padding: .7em 1em;
  border-left: 3px solid var(--amber);
  border-radius: 0 8px 8px 0;
  background: rgba(245, 158, 11, .06);
  color: #d7c9b0;
}
.doc blockquote p { margin: .25em 0; }
.doc code {
  font-family: var(--mono);
  font-size: .9em;
  color: #9fd8e8;
  background: rgba(34, 211, 238, .08);
  border: 1px solid rgba(34, 211, 238, .13);
  padding: 1px 5px;
  border-radius: 4px;
  overflow-wrap: anywhere;
}
.doc pre {
  margin: 1em 0;
  padding: 14px 16px;
  background: #070d18;
  border: 1px solid var(--line);
  border-radius: 9px;
  overflow-x: auto;
  line-height: 1.55;
}
.doc pre code {
  display: block;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: #c7d7ea;
  font-size: 12.5px;
  overflow-wrap: normal;
  white-space: pre;
}
.table-wrap {
  margin: 1.05em 0;
  overflow-x: auto;
  border: 1px solid var(--line2);
  border-radius: 9px;
  background: rgba(7, 13, 24, .5);
}
.doc table { width: 100%; border-collapse: collapse; font-size: 12.8px; }
.doc th {
  padding: 9px 12px;
  text-align: left;
  white-space: nowrap;
  color: #d9ecfa;
  font-weight: 600;
  background: rgba(34, 211, 238, .075);
  border-bottom: 1px solid var(--line2);
}
.doc td {
  padding: 8px 12px;
  vertical-align: top;
  color: #c3d3e5;
  border-bottom: 1px solid rgba(27, 42, 68, .72);
}
.doc tr:last-child td { border-bottom: 0; }
.doc tbody tr:nth-child(even) { background: rgba(255, 255, 255, .018); }
.doc tbody tr:hover { background: rgba(34, 211, 238, .045); }
.doc td code { white-space: nowrap; }
.foot {
  width: min(1080px, calc(100% - 40px));
  margin: 0 auto;
  padding: 0 0 34px;
  color: var(--muted2);
  font-size: 11px;
  text-align: center;
}
@media (max-width: 720px) {
  .topbar { padding: 10px 14px; align-items: flex-start; flex-direction: column; gap: 8px; }
  .actions { justify-content: flex-start; }
  main { width: calc(100% - 24px); padding-top: 16px; }
  .doc { padding: 20px 16px 24px; border-radius: 10px; }
  .doc h1 { font-size: 22px; }
  .doc h2 { font-size: 18px; }
  .doc td code { white-space: normal; }
  .foot { width: calc(100% - 24px); }
}
</style>
</head>
<body>
<header class="topbar">
  <div class="brand">
    <span class="logo" aria-hidden="true">M</span>
    <span class="brand-name">MotorScope</span>
    <span class="version">v$version</span>
  </div>
  <nav class="actions" aria-label="文档导航">
    <a class="pill primary" href="/api/docs?format=md">Markdown 原文</a>
    <a class="pill" href="/">返回控制台</a>
  </nav>
</header>
<main>
  <div class="docmeta">
    <span>内容来自服务端 <code>$doc_name</code></span>
    <span class="dot">·</span>
    <span>每次请求实时读取，改文档无需重启</span>
    <span class="dot">·</span>
    <span>当前服务版本 <code>v$version</code></span>
    <a href="/api/docs?format=md">/api/docs?format=md</a>
  </div>
  <article class="doc">
$content
  </article>
</main>
<footer class="foot">
  MotorScope API 文档 · 由 scope_server.py 内建渲染 · 无外部 CDN / 字体 ·
  <a href="/api/docs?format=md">Markdown 源</a>
</footer>
</body>
</html>
""")


def render_page(markdown_text: str, version: str = "", doc_name: str = "API.md") -> str:
    """渲染完整的深色文档页；version 会做 HTML 转义。"""
    safe_version = _escape(str(version or "?"))
    safe_doc_name = _escape(doc_name)
    return _PAGE.substitute(
        version=safe_version,
        doc_name=safe_doc_name,
        content=render_markdown(markdown_text),
    )
