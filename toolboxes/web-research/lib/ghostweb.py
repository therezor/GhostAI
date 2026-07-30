"""Fetching and extraction, shared by `fetch` and `search`.

One module rather than two copies because `search --read` and `fetch` want
exactly the same thing — a URL turned into the least text that still contains the
answer — and a research toolbox whose two entry points disagreed about what a
page says would be a bad toolbox.

Three decisions shape everything here:

  * **Markdown, not flattened text.** A model reads structure. Headings tell it
    which section answers the question, fenced code stays copyable, a table stays
    a table, and a link keeps its target so a follow-up fetch is possible. The
    previous implementation joined every text node with newlines, which threw all
    of that away and produced prose that could not be navigated.

  * **Main-content extraction, not tag stripping.** Removing `nav`/`footer`/
    `aside` by name catches the sites that use those elements and nothing else;
    the modern web is `<div class="sidebar">`. `trafilatura` scores the DOM for
    content density instead, which is the difference between 900 tokens of
    documentation and 6,000 tokens of documentation plus navigation.

  * **Every failure says what to do next.** A client-rendered page, a 403 from a
    bot wall, a PDF — each returns a sentence naming the next move rather than
    empty output, because an agent that cannot tell "nothing there" from "wrong
    tool" burns the rest of its turn guessing.
"""

from __future__ import annotations

import hashlib
import os
import re
import subprocess
from dataclasses import dataclass
from html import unescape
from pathlib import Path

import requests

# Long enough for a slow origin, short enough that one hung fetch does not eat
# the turn's whole time budget.
TIMEOUT_S = 20

# Read cap. A 5 MB HTML document is a database dump or a mistake, and either way
# extraction has nothing to gain from the rest of it.
MAX_BYTES = 5_000_000

# A real browser UA. A number of sites serve a challenge page to anything that
# looks automated, and a fetch that returns "please enable JavaScript" has spent
# a turn to learn nothing.
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

# Per-container, so it is per-session: a page fetched while reading, then fetched
# again while writing, costs one request. `/tmp` is a small tmpfs and nothing
# here is worth surviving the session.
CACHE_DIR = Path(os.environ.get("GHOST_FETCH_CACHE", "/tmp/.ghost-fetch"))

# Above this, caching costs more tmpfs than the round trip it saves.
CACHE_MAX_BYTES = 1_000_000


@dataclass(frozen=True)
class Page:
    """A fetched page, extracted."""

    url: str
    """Where it ended up, after redirects — what a relative link resolves against."""
    title: str
    text: str
    """Markdown, or plain text for a source that has no structure to keep."""
    kind: str
    """`html`, `pdf`, `text`, or `empty`. Chooses the caller's next sentence."""
    note: str = ""
    """What went wrong, or what to try instead. Empty on a clean fetch."""

    @property
    def ok(self) -> bool:
        return self.kind != "empty"


class FetchError(Exception):
    """A request that never produced a body. Carries the sentence to print."""


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


def http_get(url: str, *, timeout: int = TIMEOUT_S) -> tuple[bytes, str, str]:
    """Body, final URL and content type, with the read bounded.

    `stream=True` plus an explicit bounded read rather than `response.content`:
    the cap has to apply to what is *read*, not to what is checked after the
    whole thing is already in memory.
    """
    if not re.match(r"^https?://", url, re.IGNORECASE):
        # Bare hostnames are what a model produces when it copies a domain out of
        # a search result, and `requests` raises a MissingSchema that reads like a
        # bug in the tool rather than a fixable argument.
        url = f"https://{url}"

    try:
        response = requests.get(url, timeout=timeout, headers=HEADERS, stream=True)
    except requests.RequestException as error:
        raise FetchError(f"{url}: {error}") from error

    if response.status_code >= 400:
        hint = ""
        if response.status_code in (401, 403, 429):
            hint = (
                " The site is refusing automated requests; try a different source, "
                "or its API if it has one."
            )
        raise FetchError(f"{url}: HTTP {response.status_code}.{hint}")

    try:
        body = response.raw.read(MAX_BYTES, decode_content=True) or b""
    except Exception as error:  # noqa: BLE001 — any transport error, same outcome
        raise FetchError(f"{url}: {error}") from error
    finally:
        response.close()

    return body, response.url, response.headers.get("content-type", "").lower()


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------


def _title_of(body: bytes) -> str:
    match = re.search(rb"<title[^>]*>(.*?)</title>", body[:200_000], re.IGNORECASE | re.DOTALL)
    if match is None:
        return ""
    raw = match.group(1).decode("utf-8", errors="replace")
    # Unescaped, because a raw `<title>` is full of entities and printing
    # `Coroutines and tasks &#8212; Python 3.14` as a heading is both uglier and
    # more tokens than the character it stands for.
    return " ".join(unescape(re.sub(r"<[^>]+>", "", raw)).split())[:200]


def _extract_main(body: bytes, url: str) -> str:
    """The article, as markdown. Empty when there is nothing article-shaped.

    **`favor_recall` is load-bearing, not a preference.** With the defaults,
    `sqlite.org/wal.html` came back containing the line "Advantages include:" and
    then nothing — the `<ol>` under it scored below the content threshold and was
    dropped, in every output format. Measured: recall keeps 33,731 characters
    against 30,327, and the 3,400 it adds are the list items, which on a
    documentation page are usually the answer. A little navigation slipping
    through is a far cheaper mistake than a silently missing list.
    """
    import trafilatura

    for kwargs in (
        # `output_format="markdown"` is the modern spelling; `include_formatting`
        # is what older versions understand. Trying both keeps this working
        # against whatever the image resolved at build time rather than pinning a
        # version for one keyword.
        {"output_format": "markdown", "favor_recall": True},
        {"include_formatting": True, "favor_recall": True},
        {"output_format": "markdown"},
        {},
    ):
        try:
            text = trafilatura.extract(
                body,
                url=url,
                include_links=True,
                include_tables=True,
                include_comments=False,
                **kwargs,
            )
        except TypeError:
            continue
        if text:
            return text.strip()
        # A clean call that found nothing is an answer, not a reason to retry
        # with different keywords.
        return ""
    return ""


# `[¶](url)` and `[#](url)` — the permalink anchor beside every heading on a
# Sphinx or Docusaurus site. Kept by extraction because it is a real link, and
# worthless: its text is a symbol.
_PERMALINK = re.compile(r"\[[¶#§]\]\([^)]*\)")

# A markdown link whose target has no path — `[Coroutines](https://docs.python.org#id2)`.
# The source was `href="#id2"`, an in-page anchor; resolving it against the page
# URL gives the *site root*, which is a real URL pointing at the wrong document.
# Left in place, a model follows it and fetches a front page. The text is kept and
# the link discarded, because the text is the part that carried meaning.
_ROOTED_FRAGMENT = re.compile(r"\[([^\]]*)\]\(https?://[^/)\s]+/?#[^)\s]*\)")

# `Coroutines and tasks — Python 3.14.6 documentation` and `Coroutines and tasks`
# are the `<title>` and the `<h1>`: the same heading, one with the site name
# appended. Splitting on the separators sites use for that suffix is what lets the
# duplicate be recognised.
_TITLE_SUFFIX = re.compile(r"\s+[—–|·:-]\s+")


def _tidy(text: str, title: str) -> str:
    """Three kinds of noise that survive extraction, removed.

    Small individually, and all three cost tokens on every single fetch. Two of
    them also actively mislead: a permalink and an in-page anchor both extract as
    links to a document other than the one they came from.
    """
    text = _PERMALINK.sub("", text)
    text = _ROOTED_FRAGMENT.sub(r"\1", text)

    # The `<h1>` is the `<title>` again, and the caller has already printed the
    # title as the heading. Compared against the title's first segment as well as
    # the whole of it, because `<title>` usually carries a site-name suffix the
    # `<h1>` does not.
    lines = text.lstrip().splitlines()
    if lines and title:
        heading = lines[0].lstrip("# ").strip().casefold()
        candidates = {title.strip().casefold(), _TITLE_SUFFIX.split(title.strip())[0].casefold()}
        if heading and heading in candidates:
            lines = lines[1:]
            while lines and not lines[0].strip():
                lines = lines[1:]

    return "\n".join(line.rstrip() for line in lines).strip()


def _extract_fallback(body: bytes) -> str:
    """Every visible line, for a page `trafilatura` finds no article in.

    Worse output, and still worth having: a bare directory listing, a wiki index
    or a status page has no article to score, and printing its text beats telling
    the agent the page was empty when it plainly is not.
    """
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(body, "lxml")
    for element in soup(("script", "style", "noscript", "svg", "template")):
        element.decompose()

    lines: list[str] = []
    blank = False
    for raw in soup.get_text("\n").splitlines():
        line = " ".join(raw.split())
        if line:
            lines.append(line)
            blank = False
        elif not blank:
            lines.append("")
            blank = True
    return "\n".join(lines).strip()


def _pdf_text(body: bytes) -> str:
    """A PDF as text, layout preserved.

    Research targets are PDFs often enough — standards, papers, datasheets — that
    the alternative is an agent fetching one, getting mojibake, and concluding the
    page is broken. `-layout` because a two-column paper interleaved line by line
    is worse than no text at all.
    """
    try:
        done = subprocess.run(
            ["pdftotext", "-layout", "-nopgbrk", "-", "-"],
            input=body,
            capture_output=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise FetchError(f"pdftotext: {error}") from error
    if done.returncode != 0:
        raise FetchError(f"pdftotext: {done.stderr.decode('utf-8', 'replace').strip()}")
    return done.stdout.decode("utf-8", errors="replace").strip()


def links_in(body: bytes, base_url: str) -> list[tuple[str, str]]:
    """Every distinct absolute link, with its text. For following a page's index."""
    from urllib.parse import urljoin

    from bs4 import BeautifulSoup

    soup = BeautifulSoup(body, "lxml")
    seen: set[str] = set()
    found: list[tuple[str, str]] = []
    for anchor in soup.find_all("a", href=True):
        href = urljoin(base_url, anchor["href"]).split("#", 1)[0]
        if not href.lower().startswith(("http://", "https://")) or href in seen:
            continue
        seen.add(href)
        found.append((href, " ".join(anchor.get_text().split())[:100]))
    return found


# ---------------------------------------------------------------------------
# The cache
# ---------------------------------------------------------------------------


def _cache_file(url: str) -> Path:
    return CACHE_DIR / f"{hashlib.sha256(url.encode()).hexdigest()[:32]}.txt"


def _cached(url: str) -> Page | None:
    path = _cache_file(url)
    try:
        raw = path.read_text("utf-8")
    except OSError:
        return None
    head, _, text = raw.partition("\n\n")
    kind, _, title = head.partition("\t")
    return Page(url=url, title=title, text=text, kind=kind or "html")


def _store(page: Page) -> None:
    if len(page.text) > CACHE_MAX_BYTES or not page.ok:
        return
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        _cache_file(page.url).write_text(
            f"{page.kind}\t{page.title}\n\n{page.text}", encoding="utf-8"
        )
    except OSError:
        # A full tmpfs costs a re-fetch, which is not worth failing a turn over.
        pass


# ---------------------------------------------------------------------------
# The one function callers want
# ---------------------------------------------------------------------------


def fetch_page(url: str, *, use_cache: bool = True) -> Page:
    """A URL as the least text that still answers a question.

    Raises `FetchError` when there was no body to work with — a refused request,
    a timeout, a bad host. Returns a `Page` with `kind == "empty"` when there was
    a body and nothing readable in it, because those need different advice: one is
    "try another source", the other is "this page needs JavaScript".
    """
    if use_cache:
        hit = _cached(url)
        if hit is not None:
            return hit

    body, final_url, content_type = http_get(url)

    if "pdf" in content_type or body[:5] == b"%PDF-":
        text = _pdf_text(body)
        page = Page(
            url=final_url,
            title=_title_of(body),
            text=text,
            kind="pdf" if text else "empty",
            note="" if text else "The PDF has no extractable text — it is probably scanned images.",
        )
        _store(page)
        return page

    looks_like_html = "html" in content_type or body.lstrip()[:1] == b"<"
    if not looks_like_html:
        text = body.decode("utf-8", errors="replace").strip()
        page = Page(url=final_url, title="", text=text, kind="text" if text else "empty")
        _store(page)
        return page

    title = _title_of(body)
    text = _tidy(_extract_main(body, final_url), title)
    note = ""
    if not text:
        text = _extract_fallback(body)
        if text:
            note = "No article found on this page, so this is its whole visible text."

    if not text:
        return Page(
            url=final_url,
            title=title,
            text="",
            kind="empty",
            note=(
                "The page returned markup but no text. It is almost certainly rendered "
                "client-side and there is no JavaScript engine here — look for an API, "
                "an RSS feed, or a <noscript> fallback."
            ),
        )

    page = Page(url=final_url, title=title, text=text, kind="html", note=note)
    _store(page)
    return page


def truncate(text: str, limit: int) -> tuple[str, int]:
    """The head of `text`, cut at a line boundary. Returns it and what was dropped.

    A cut mid-sentence reads as corruption; a cut at a newline reads as an
    ending. `0` means no limit.
    """
    if limit <= 0 or len(text) <= limit:
        return text, 0
    head = text[:limit]
    break_at = head.rfind("\n")
    if break_at > limit // 2:
        head = head[:break_at]
    return head.rstrip(), len(text) - len(head)
