#!/usr/bin/env python3
"""Build the theme in a fresh example site without site-level overrides."""

import os
import json
import re
import shutil
import subprocess
import tempfile
import unittest
from html.parser import HTMLParser
from pathlib import Path


THEME = Path(__file__).resolve().parents[1]
HUGO = os.environ.get("HUGO_BIN", "hugo")


class TimelineParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.groups = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "section" and attributes.get("data-group-key", "").startswith("time:"):
            self.groups.append((attributes["data-group-key"], attributes["data-default-collapsed"]))


class ThemeBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hugo-deepseek-test-")
        self.root = Path(self.temp.name)
        self.site = self.root / "site"
        shutil.copytree(THEME / "exampleSite", self.site)
        themes = self.site / "themes"
        themes.mkdir()
        (themes / "hugo-deepseek-theme").symlink_to(THEME, target_is_directory=True)
        self.output = self.root / "public"

    def tearDown(self):
        self.temp.cleanup()

    def build(self, *options):
        command = [HUGO, "--source", str(self.site), "--destination", str(self.output),
                   "--cacheDir", str(self.root / "cache"), "--noBuildLock", *options]
        result = subprocess.run(command, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def html(self, relative):
        return (self.output / relative).read_text(encoding="utf-8")

    def reader_config(self, relative):
        match = re.search(r'<script type="application/json" id="site-config">(.*?)</script>',
                          self.html(relative), re.DOTALL)
        self.assertIsNotNone(match)
        return json.loads(match.group(1))["reader"]

    def test_fresh_site_and_subpath(self):
        self.build("--baseURL", "https://example.org/blog/")
        home = self.html("index.html")
        article = self.html("p/hello-world/index.html")
        self.assertIn("A conversation with the page", home)
        self.assertIn('href="/blog/about/"', home)
        self.assertIn('data-article-key="/blog/p/hello-world/"', home)
        self.assertIn("A little example", article)
        self.assertIn("<math", article)
        self.assertIn("Hello! This is an example page", self.html("about/index.html"))
        self.assertTrue((self.output / "links/index.html").exists())
        self.assertTrue((self.output / "images/favicon.svg").exists())
        self.assertIn('data-comments-configured="false"', home)
        self.assertEqual(self.reader_config("index.html")["mode"], "constant")
        parser = TimelineParser()
        parser.feed(home)
        self.assertEqual(parser.groups, [("time:2025-05", "false"), ("time:2025-04", "true")])

    def test_comments_configured_and_page_opt_out(self):
        overlay = self.site / "comments.toml"
        overlay.write_text('[params.comments]\nbackendURL = "https://comments.example.org"\n'
                           'repository = "example/comments"\n', encoding="utf-8")
        article = self.site / "content/post/2025/05/hello-world.md"
        article.write_text(article.read_text(encoding="utf-8").replace(
            'tags = ["writing", "hugo"]', 'tags = ["writing", "hugo"]\ncomments = false'),
            encoding="utf-8")
        self.build("--config", "hugo.toml,comments.toml")
        home = self.html("index.html")
        enabled = self.html("p/a-small-note/index.html")
        disabled = self.html("p/hello-world/index.html")
        self.assertIn('data-comments-panel-toggle', home)
        self.assertIn('data-comments-configured="true"', home)
        self.assertIn('data-comment-id="example-small-note"', enabled)
        self.assertIn('data-comments-configured="true"', enabled)
        self.assertNotIn('data-comment-dock', disabled)
        self.assertNotIn('data-comments-panel-toggle', disabled)

    def test_simplified_chinese_locale(self):
        overlay = self.site / "chinese.toml"
        overlay.write_text('defaultContentLanguage = "zh-cn"\n'
                           '[languages.zh-cn]\nlocale = "zh-CN"\n', encoding="utf-8")
        self.build("--config", "hugo.toml,chinese.toml")
        home = self.html("index.html")
        self.assertIn('data-search-result-label="文章"', home)
        self.assertIn('>首页</span>', home)
        self.assertIn('>关于</span>', home)

    def test_reader_mode_is_site_wide(self):
        overlay = self.site / "reader.toml"
        for mode in ("constant", "capped", "instant"):
            with self.subTest(mode=mode):
                overlay.write_text(f'[params.reader]\nmode = "{mode}"\n', encoding="utf-8")
                self.build("--config", "hugo.toml,reader.toml")
                self.assertEqual(self.reader_config("index.html")["mode"], mode)
                self.assertEqual(self.reader_config("p/hello-world/index.html")["mode"], mode)

    def test_invalid_reader_mode_fails_build(self):
        overlay = self.site / "reader.toml"
        overlay.write_text('[params.reader]\nmode = "typo"\n', encoding="utf-8")
        result = subprocess.run([HUGO, "--source", str(self.site), "--destination", str(self.output),
                                 "--cacheDir", str(self.root / "cache"), "--noBuildLock",
                                 "--config", "hugo.toml,reader.toml"], text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("params.reader.mode must be constant, capped, or instant", result.stderr)

    def test_legacy_disable_without_mode(self):
        config = self.site / "hugo.toml"
        text = config.read_text(encoding="utf-8")
        text = text.replace('mode = "constant" # constant | capped | instant', 'typing = false')
        config.write_text(text, encoding="utf-8")
        self.build()
        self.assertEqual(self.reader_config("p/hello-world/index.html")["mode"], "instant")


if __name__ == "__main__":
    unittest.main(verbosity=2)
