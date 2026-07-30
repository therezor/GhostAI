# web-research toolbox

You are running commands inside a Linux container with internet access. This file
is the reference for what is in it. Run `tools` for all of it, or `tools <topic>`
for one section: `start`, `search`, `fetch`, `files`, `pdf`, `limits`, `recipes`.

## Start here

```
search does sqlite wal work over nfs    search, and read the top 3 pages
fetch https://sqlite.org/wal.html       read one page you already have a URL for
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
fetch --save /workspace <url>                      also write it to a .md file
fetch --links <url>                                the page's links, URL<TAB>text
fetch <url1> <url2> <url3>                         several pages in one call
fetch --no-cache <url>                             re-request instead of reusing
```

What it does that `curl` does not: it discards navigation, sidebars, cookie
banners and markup, and keeps headings, lists, tables, code blocks and links.
A documentation page is typically 80–95% of that boilerplate, so this is the
difference between a page fitting in your context and not.

Default cap is 24,000 characters per page. When it bites, the output says how much
was dropped — add `--save /workspace` and the whole thing is written to a file you
can `rg` instead.

## pdf

A URL that returns a PDF needs no special handling — `fetch` detects it and prints
it as text with the page layout preserved, so a standard, a paper or a datasheet
reads the same way a web page does.

```
fetch --save /workspace https://example.org/rfc9110.pdf
rg -n -i 'idempotent' /workspace/example.org-rfc9110.pdf.md
```

A PDF that comes back empty is a scan — page images with no text layer — and
`fetch` says so. There is no OCR here.

## files

Only `/workspace` exists outside this container. It is shared with the host, so
anything written there is readable with `read_file` and visible in the Files UI.
Everything else on this filesystem disappears when the session ends.

```
rg -n 'rate limit' /workspace/spec.md      search saved pages
jq -r '.items[].name' /workspace/api.json  filter JSON
python3 -c '...'                           lxml, requests, bs4, trafilatura
w3m -dump <url>                            a different text renderer, if fetch fails
curl -sSL <url>                             raw bytes — for an API, not for reading
```

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
fetch --save /workspace/sources <url1> <url2> <url3>
rg -n -i 'limitation|caveat|not supported' /workspace/sources
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
