/**
 * Looking at one workspace file.
 *
 * Everything here goes through a signed URL, and that is the whole design.
 * `<img src>` cannot carry an `Authorization` header and cannot be relied on to
 * carry a `SameSite=Strict` cookie, so the tempting fix is to make the file
 * endpoint public — which is anonymous read access to a tree a language model
 * writes to. `POST /api/files/signed-url` mints a short-lived HMAC token naming
 * one path instead, and the endpoint stays authenticated.
 *
 * Two consequences show up in this component rather than on the server:
 *
 *  - **The kind comes from the server's MIME type**, not from the extension.
 *    `/api/media/:token` serves anything it does not recognise as an
 *    attachment with `nosniff`, so an `<img>` built from a guess would render a
 *    broken image over a response the browser was never going to display.
 *  - **A text preview is fetched and read as text**, not put in an `<iframe>`.
 *    The workspace holds model-authored files; an iframe would execute one.
 */

import { useQuery } from '@tanstack/react-query';
import { Download, FileWarning } from 'lucide-react';
import type { JSX } from 'react';

import type { FileEntry } from '@ghostai/protocol';

import { api } from '@/lib/api.js';
import { formatBytes } from '@/lib/format.js';
import { Button } from '@/components/ui/button.js';
import { MAX_TEXT_PREVIEW_BYTES, previewKind } from './paths.js';

export function FilePreview({ entry }: { readonly entry: FileEntry }): JSX.Element {
  const kind = previewKind(entry.mimeType);

  const signed = useQuery({
    queryKey: ['files', 'signed', entry.path],
    queryFn: () => api.signUrl(entry.path),
    // A URL that expired while the dialog was open is not a cached answer worth
    // keeping: the next open mints a fresh one.
    gcTime: 0,
  });

  const tooBig = entry.sizeBytes > MAX_TEXT_PREVIEW_BYTES;

  const text = useQuery({
    queryKey: ['files', 'text', entry.path, signed.data?.url],
    queryFn: async () => {
      const url = signed.data?.url ?? '';
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`Could not read the file (${String(response.status)})`);
      return await response.text();
    },
    enabled: kind === 'text' && !tooBig && signed.data !== undefined,
  });

  if (signed.isPending) return <p className="file-preview__note">Preparing a link…</p>;
  if (signed.isError) {
    return (
      <p role="alert" className="page__error">
        {signed.error.message}
      </p>
    );
  }

  const { url } = signed.data;

  return (
    <div className="stack file-preview">
      {kind === 'image' && (
        // Constrained by the viewport rather than by the image, so a very large
        // screenshot from a tool call does not push the dialog off the screen.
        <img src={url} alt={entry.name} className="file-preview__image" />
      )}

      {kind === 'text' &&
        (tooBig ? (
          <Unpreviewable
            reason={`This file is ${formatBytes(entry.sizeBytes)}, past the ${formatBytes(
              MAX_TEXT_PREVIEW_BYTES,
            )} preview limit.`}
          />
        ) : text.isPending ? (
          <p className="file-preview__note">Reading…</p>
        ) : text.isError ? (
          <p role="alert" className="page__error">
            {text.error.message}
          </p>
        ) : (
          <pre className="file-preview__body">{text.data}</pre>
        ))}

      {kind === 'other' && (
        <Unpreviewable reason="This type is served as a download rather than rendered in the page." />
      )}

      <div className="cluster">
        <Button asChild variant="secondary">
          {/* `rel` on a `_blank` link: without it the opened tab gets a handle
              on this one through `window.opener`. */}
          <a href={url} target="_blank" rel="noreferrer noopener" download={entry.name}>
            <Download />
            Download
          </a>
        </Button>
        <span className="file-preview__meta">
          {formatBytes(entry.sizeBytes)} · {entry.mimeType ?? 'unknown type'}
        </span>
      </div>
    </div>
  );
}

function Unpreviewable({ reason }: { readonly reason: string }): JSX.Element {
  return (
    <p className="notice">
      <FileWarning />
      <span>{reason}</span>
    </p>
  );
}
