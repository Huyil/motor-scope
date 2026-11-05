#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""api_docs 的 Markdown 渲染 / HTML 转义单元测试（不启动 HTTP 服务）。"""
from __future__ import annotations

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from api_docs import render_markdown, render_page  # noqa: E402


class ApiDocsTest(unittest.TestCase):
    def test_headings_paragraph_bold_and_escape(self) -> None:
        html = render_markdown(
            "# 标题\n\n## 二级\n\n文本 <script>alert(1)</script> & **粗体**。")
        self.assertIn("<h1>标题</h1>", html)
        self.assertIn("<h2>二级</h2>", html)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt; &amp;", html)
        self.assertIn("<strong>粗体</strong>", html)
        self.assertNotIn("<script>", html)

    def test_inline_and_fenced_code_escape_once(self) -> None:
        html = render_markdown(
            "行内 `<b>x</b>`\n\n```html\n<script>a & b</script>\n```\n")
        self.assertIn("<code>&lt;b&gt;x&lt;/b&gt;</code>", html)
        self.assertIn(
            '<pre><code class="language-html">&lt;script&gt;a &amp; b&lt;/script&gt;</code></pre>',
            html)
        self.assertNotIn("&amp;lt;", html)

    def test_table_with_escaped_pipe_and_alignment(self) -> None:
        html = render_markdown(
            "| 接口 | 说明 |\n| --- | ---: |\n| `1\\|2\\|4` | **x** |\n")
        self.assertIn("<thead>", html)
        self.assertIn("<th>接口</th>", html)
        self.assertIn('<th style="text-align:right">说明</th>', html)
        self.assertIn("<td><code>1|2|4</code></td>", html)
        self.assertIn('<td style="text-align:right"><strong>x</strong></td>', html)

    def test_unordered_and_ordered_lists(self) -> None:
        html = render_markdown("- 一\n- 二\n\n1. 甲\n2. 乙\n")
        self.assertIn("<ul>", html)
        self.assertIn("<li>一</li>", html)
        self.assertIn("<ol>", html)
        self.assertIn("<li>乙</li>", html)

    def test_page_has_version_link_and_escaped_content(self) -> None:
        page = render_page("# 文档\n\n<script>bad()</script>\n", version="9.9.9")
        self.assertIn("<!doctype html>", page)
        self.assertIn("<span class=\"version\">v9.9.9</span>", page)
        self.assertIn('href="/api/docs?format=md"', page)
        self.assertIn("<h1>文档</h1>", page)
        self.assertIn("&lt;script&gt;bad()&lt;/script&gt;", page)
        self.assertNotIn("<script>bad()</script>", page)
        self.assertNotIn("http://", page)  # 不加载外部资源


if __name__ == "__main__":
    unittest.main()
