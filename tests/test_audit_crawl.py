"""Unit tests for the pure extraction logic in scripts/audit_crawl.py.

These test the regexes and the schema.org extractor in isolation, with no
network access — the parts of the crawler that are cheap to get wrong and
easy to verify without hitting a real site.
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import Mock, patch

from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import audit_crawl as ac  # noqa: E402


class TestRelativeTime:
    def test_matches_german_seit_mehr_als(self):
        text = "Wir arbeiten seit mehr als 15 Jahren in diesem Markt."
        assert ac.RELATIVE_TIME.search(text)

    def test_matches_german_ueber_jahre(self):
        text = "Mit über 20 Jahren Erfahrung."
        assert ac.RELATIVE_TIME.search(text)

    def test_matches_english_over_years(self):
        assert ac.RELATIVE_TIME.search("We've been doing this for over 10 years.")

    def test_matches_english_more_than_years(self):
        assert ac.RELATIVE_TIME.search("More than 5 years of experience.")

    def test_does_not_match_fixed_year(self):
        text = "Founded in 2011. Serving clients since 2011."
        assert not ac.RELATIVE_TIME.search(text)

    def test_does_not_match_unrelated_number(self):
        assert not ac.RELATIVE_TIME.search("We have 20 employees.")


class TestFigureRegex:
    def test_matches_percentage(self):
        assert ac.FIGURE.findall("Conversion rose by 23%.")

    def test_matches_plain_number(self):
        matches = ac.FIGURE.findall("We ran 42 workshops last year.")
        assert any("42" in m for m in matches)

    def test_matches_plus_suffix(self):
        assert ac.FIGURE.findall("Over 500+ participants.")

    def test_ignores_single_digit(self):
        # \d{2,} requires at least two digits
        assert not ac.FIGURE.findall("We have 5 offices.")


class TestSchemaTypes:
    def test_extracts_single_type(self):
        html = """
        <script type="application/ld+json">{"@type": "FAQPage"}</script>
        """
        soup = BeautifulSoup(html, "lxml")
        assert ac.schema_types(soup) == ["FAQPage"]

    def test_extracts_from_graph(self):
        html = """
        <script type="application/ld+json">
        {"@graph": [{"@type": "Organization"}, {"@type": "WebPage"}]}
        </script>
        """
        soup = BeautifulSoup(html, "lxml")
        assert ac.schema_types(soup) == ["Organization", "WebPage"]

    def test_handles_type_as_list(self):
        html = """
        <script type="application/ld+json">{"@type": ["Article", "FAQPage"]}</script>
        """
        soup = BeautifulSoup(html, "lxml")
        assert ac.schema_types(soup) == ["Article", "FAQPage"]

    def test_ignores_malformed_json(self):
        html = '<script type="application/ld+json">{not valid json}</script>'
        soup = BeautifulSoup(html, "lxml")
        assert ac.schema_types(soup) == []

    def test_no_ld_json_returns_empty(self):
        soup = BeautifulSoup("<html><body><p>hi</p></body></html>", "lxml")
        assert ac.schema_types(soup) == []


class TestDiscoverUrlsViaLinks:
    """Fallback page discovery for sites without a sitemap. Network calls are mocked."""

    def _mock_response(self, html):
        resp = Mock()
        resp.text = html
        return resp

    def test_finds_same_domain_links(self):
        html = """
        <html><body>
          <a href="/pricing">Pricing</a>
          <a href="/about">About</a>
          <a href="https://www.example.com/contact">Contact</a>
        </body></html>
        """
        with patch("audit_crawl.requests.get", return_value=self._mock_response(html)):
            urls = ac.discover_urls_via_links("https://www.example.com")
        assert "https://www.example.com/" in urls
        assert "https://www.example.com/pricing" in urls
        assert "https://www.example.com/about" in urls
        assert "https://www.example.com/contact" in urls

    def test_ignores_external_links(self):
        html = '<a href="https://other-site.example/page">External</a>'
        with patch("audit_crawl.requests.get", return_value=self._mock_response(html)):
            urls = ac.discover_urls_via_links("https://www.example.com")
        assert not any("other-site" in u for u in urls)

    def test_ignores_mailto_and_tel_links(self):
        html = '<a href="mailto:hi@example.com">Mail</a><a href="tel:+123">Call</a>'
        with patch("audit_crawl.requests.get", return_value=self._mock_response(html)):
            urls = ac.discover_urls_via_links("https://www.example.com")
        assert all(u.startswith("http") for u in urls)

    def test_strips_query_and_fragment(self):
        html = '<a href="/page?utm_source=x#section">Page</a>'
        with patch("audit_crawl.requests.get", return_value=self._mock_response(html)):
            urls = ac.discover_urls_via_links("https://www.example.com")
        assert "https://www.example.com/page" in urls
        assert not any("?" in u or "#" in u for u in urls)

    def test_deduplicates_repeated_links(self):
        html = '<a href="/page">A</a><a href="/page">B</a><a href="/page">C</a>'
        with patch("audit_crawl.requests.get", return_value=self._mock_response(html)):
            urls = ac.discover_urls_via_links("https://www.example.com")
        assert urls.count("https://www.example.com/page") == 1

    def test_no_links_still_returns_the_homepage(self):
        with patch("audit_crawl.requests.get", return_value=self._mock_response("<html></html>")):
            urls = ac.discover_urls_via_links("https://www.example.com")
        assert urls == ["https://www.example.com/"]

    def test_request_failure_returns_just_the_homepage_not_an_exception(self):
        import requests
        with patch("audit_crawl.requests.get", side_effect=requests.RequestException("boom")):
            urls = ac.discover_urls_via_links("https://www.example.com")
        assert urls == ["https://www.example.com/"]


class TestInspectPage:
    HTML = """<html><head><title>RAG guide</title>
      <meta name="description" content="How retrieval works.">
      <meta property="article:published_time" content="2024-03-05T10:00:00Z">
      <script type="application/ld+json">{"@type": "FAQPage"}</script></head>
      <body><nav><h1>Menu</h1></nav><main><h1>What is RAG?</h1>
      <h2>Why does it matter?</h2><h2>Setup</h2><h3>Costs?</h3>
      <p>We have shipped 42 pipelines for over 10 years, with 95% uptime.</p></main>
      <footer>Imprint</footer></body></html>"""

    def test_extracts_page_signals(self):
        resp = Mock(status_code=200, text=self.HTML)
        with patch("audit_crawl.requests.get", return_value=resp):
            rec = ac.inspect_page("https://www.example.com/rag")
        assert rec["status"] == 200 and rec["title"] == "RAG guide"
        assert rec["meta_description"] == "How retrieval works."
        assert rec["schema_types"] == ["FAQPage"] and rec["published"] == "2024-03-05"
        assert rec["h1"] == ["What is RAG?"]  # the nav H1 is dropped
        assert rec["h2_count"] == 3 and rec["question_headings"] == 2
        assert rec["figures"] == 3 and rec["relative_time"] == ["over 10 years"]
        assert "Imprint" not in rec["text"]

    def test_request_error_is_recorded_not_raised(self):
        import requests
        with patch("audit_crawl.requests.get", side_effect=requests.RequestException("timeout")):
            rec = ac.inspect_page("https://www.example.com/x")
        assert rec == {"url": "https://www.example.com/x", "error": "timeout"}

    def test_sitemap_index_is_followed_one_level(self):
        index = "<sitemapindex><sitemap><loc>https://www.example.com/s1.xml</loc></sitemap></sitemapindex>"
        child = ("<urlset><url><loc>https://www.example.com/a</loc></url>"
                 "<url><loc>https://www.example.com/a</loc></url></urlset>")
        responses = {"https://www.example.com/sitemap.xml": index, "https://www.example.com/s1.xml": child}
        with patch("audit_crawl.requests.get", side_effect=lambda url, **kw: Mock(text=responses[url])):
            assert ac.urls_from_sitemaps("https://www.example.com", ["/sitemap.xml"]) == ["https://www.example.com/a"]
