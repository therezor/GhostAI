# web-research toolbox

You are running commands inside a Linux container with internet access. This file
is the reference for what is in it. Run `tools` for all of it, or `tools <topic>`
for one section: `start`, `search`, `fetch`, `doc`, `files`, `pdf`, `limits`,
`recipes`.

## Start here

```
search does sqlite wal work over nfs    search, and read the top 3 pages
fetch https://sqlite.org/wal.html       read one page you already have a URL for
doc uploads/ab12-spec.pdf               read a file the user attached
```

`search <question>` answers most research questions in a single command: it returns
the numbered results _and_ the text of the top three pages. Reach for it first.

Write the question as plain words. No quote characters — there is no shell here,
so they end up inside the query.

Answer from the page text, not from the snippets. **One search is usually enough**
— if it did not answer the question, `fetch` one of the URLs it gave you for the
full page rather than searching again with different words.

## search

```
search sqlite wal mode                       6 results, and the text of the top 3
search --read 5 sqlite wal mode              read more of them
search --read 0 sqlite wal mode              just the links, no page text
search -n 10 sqlite wal mode                 more results in the list
search --site docs.python.org taskgroup      restrict to one domain
search --recent day latest UK news           only the last day — use this for news
search --recent week --region us-en tariffs  recency plus a regional bias
```

Give the query as plain words. Do not wrap it in quote characters — there is no
shell here, so they become part of the query and make it an exact-phrase search
that usually matches nothing.

**Reading is the default.** Every search prints the numbered list _and_ the text of
the top three results, each under a `===== [n] url =====` header. You do not need to
ask for it, and you should not answer from the snippets alone — a snippet is one
line chosen by a search engine, not by whoever wrote the page.

The extracts share a fixed output budget, so asking for more pages gives you less of
each. When an extract stops early it says so and names the URL: `fetch` that for the
whole page. That is the cheaper next move than another search.

Pages that cannot be read are skipped and named at the end, and the next result
down is read in place of each one, so three extracts means three that worked. The
header line is the URL to `fetch` when 3,000 characters was not enough.

**Use `--recent day` for anything about now.** A plain search for "latest news"
returns the _front pages_ of news sites, because that is what matches those words
best; `--recent day` returns what was published today.

Nine search backends sit behind this and it moves between them, so a result comes
back even when several are blocking. Identical queries are cached. A result tagged
`[hn]` came from Hacker News rather than the web, which happens when every web
backend failed — treat it as discussion, not documentation.

If it says nothing was found: when the reason is a block or a rate limit the query
was fine, so do not re-ask it — `fetch` a likely URL directly instead. When there
is no such reason, rephrase with fewer or more common words, or drop `--site`.

## fetch

```
fetch https://sqlite.org/wal.html                  main content, as markdown
fetch --max-chars 0 <url>                          no cap: print all of it
fetch --save . <url>                               also write it to a .md file
fetch --links <url>                                the page's links, URL<TAB>text
fetch <url1> <url2> <url3>                         several pages in one call
fetch --no-cache <url>                             re-request instead of reusing
```

What it does that `curl` does not: it discards navigation, sidebars, cookie
banners and markup, and keeps headings, lists, tables, code blocks and links.
A documentation page is typically 80–95% of that boilerplate, so this is the
difference between a page fitting in your context and not.

Default cap is 24,000 characters per page. When it bites, the output says how much
was dropped — add `--save .` and the whole thing is written to a file you
can `rg` instead.

## doc

Reads a file that is already on disk, the way `fetch` reads a URL.

```
doc uploads/ab12cd34-report.pdf                a PDF, as text
doc uploads/cd34ef56-books.xlsx                a spreadsheet, one CSV per sheet
doc notes.docx deck.pptx                       several files in one call
doc --lang deu uploads/scan.pdf                a scan that is not in English
doc --max-chars 0 --save out.txt <path>
```

**Write paths the way the file tools do.** Commands start in the workspace, so
`uploads/report.pdf` names the same file here that `read_file` calls
`uploads/report.pdf`. There is no need to spell out the mount point, and no
second naming scheme to keep straight.

**This is how you open an attachment.** A file someone attaches to a message
lands in `uploads/` and you are given its path. For a PDF, a spreadsheet or a
scan the path is _all_ you are given — the contents are not in the conversation,
so a question about "the document I sent" is answered by running `doc` on it,
not by asking what it says.

Reads `.pdf`, `.docx`, `.xlsx`, `.pptx`, images, and anything that is text —
including `.py`, `.ts`, `.csv`, `.json` and files with no extension, which are
decided by their bytes rather than their name.

Same 24,000-character cap as `fetch`, and the same escape: `--max-chars 0` for
all of it, or `--save` it and `rg` the result.

## pdf

A URL that returns a PDF needs no special handling — `fetch` detects it and prints
it as text with the page layout preserved, so a standard, a paper or a datasheet
reads the same way a web page does. For a PDF on disk, `doc` does the same.

```
fetch --save . https://example.org/rfc9110.pdf
rg -n -i 'idempotent' example.org-rfc9110.pdf.md
doc uploads/ab12cd34-rfc9110.pdf
```

A PDF with no text layer is a scan — page images — and `doc` runs OCR on it
automatically, says that it did, and names the language it used.

```
doc uploads/scan.pdf                  OCR in English, up to 40 pages
doc --lang deu uploads/vertrag.pdf    a German contract
doc --lang rus+ukr uploads/akt.pdf    either of two languages
doc --ocr-pages 120 uploads/long.pdf  a longer scan
doc --no-ocr uploads/scan.pdf         just tell me if it has text
```

Installed languages: `eng` `deu` `fra` `spa` `ita` `por` `nld` `rus` `ukr` `swe`
`nor` `dan` `fin`. Name only the ones the document actually uses — tesseract
scores against every language it is given, so a long list is slower _and_ less
accurate.

OCR is much slower than reading a text layer: seconds per page against
milliseconds. If the answer is on one page of a long scan, `--ocr-pages` keeps it
from reading the rest.

`fetch` on a PDF URL does not OCR. Save it first, then `doc` it:

```
fetch --save . https://example.org/scanned.pdf
doc example.org-scanned.pdf
```

## files

Commands start in the workspace, and it is the only thing here that is shared
with the host — so write paths relative (`notes.md`, `uploads/report.pdf`),
exactly as the file tools do. Anything written there is readable with
`read_file` and visible in the Files UI. Everything else on this filesystem
disappears when the session ends.

(The workspace is mounted at `/workspace`, so the absolute form works too. There
is just no reason to type it.)

```
doc uploads/report.pdf                     read a document, whatever its format
rg -n 'rate limit' spec.md                 search saved pages
jq -r '.items[].name' api.json             filter JSON
python3 -c '...'                           lxml, requests, bs4, trafilatura,
                                           python-docx, openpyxl, python-pptx, PIL
w3m -dump <url>                            a different text renderer, if fetch fails
curl -sSL <url>                             raw bytes — for an API, not for reading
```

Files someone attached to the conversation are under `uploads/`, named
with a short prefix and their original filename.

## limits

There is **no browser and no JavaScript engine**. A page that renders entirely
client-side comes back empty, and `fetch` says so rather than looking like an
empty article. When that happens, look for:

- an API endpoint (often visible in the page's `--links` output),
- an RSS or Atom feed,
- a `<noscript>` fallback,
- the same content on another site — `search` again with different terms.

Output too large to return inline is kept in full under `/run/ghost-runs/<id>/`.
That path is read-only and outside `/workspace`, so reach it with a shell command
(`rg pattern /run/ghost-runs/...`), not with the file tools.

## recipes

Answer a question about a file the user attached:

```
doc uploads/ab12cd34-contract.pdf
```

Pull one figure out of a long scanned document without OCR-ing all of it:

```
doc --ocr-pages 4 uploads/scan.pdf
doc --max-chars 0 --save scan.txt uploads/scan.pdf
rg -n -i 'total|amount due' scan.txt
```

Answer a question from the web, in one call:

```
search does sqlite wal work over nfs
```

Go deeper than the 3,000-character extracts on one of the results:

```
search postgres logical replication limits
fetch --max-chars 0 https://www.postgresql.org/docs/current/logical-replication-restrictions.html
```

Research something properly, keeping the sources:

```
search -n 8 --read 5 postgres logical replication limits
fetch --save sources <url1> <url2> <url3>
rg -n -i 'limitation|caveat|not supported' sources
```

Read an API instead of a page:

```
curl -sSL https://api.github.com/repos/sqlite/sqlite | jq '{stars: .stargazers_count}'
```

Work through a documentation site:

```
fetch --links https://docs.example.com/ | rg -i 'auth'
fetch https://docs.example.com/auth/tokens
```
