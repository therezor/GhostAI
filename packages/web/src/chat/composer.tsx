/**
 * The composer.
 *
 * Three things that are each slightly harder than they look:
 *
 *  - **It grows with the text without measuring anything.** The usual
 *    implementation reads `scrollHeight` and writes a pixel height, which is a
 *    layout thrash per keystroke and a hard-coded `px` in a UI whose whole type
 *    scale is rem. Instead the textarea and an invisible mirror of its own
 *    content occupy the same grid cell: the mirror sizes the cell, the textarea
 *    stretches to fill it. No measurement, no `px`, and it reflows at 200% zoom
 *    for free.
 *  - **Send ⇄ Stop follows `session.status.busy`.** Enter still sends while a
 *    turn is running — the hub queues it — so the composer says so rather than
 *    disabling itself, which would lose the sentence the user is mid-way
 *    through typing.
 *  - **Attachments upload on selection, not on send.** A 4 MB image uploaded
 *    when Send is pressed is four seconds of a button that appears to have done
 *    nothing. Uploading on selection puts the wait where the user chose to
 *    cause it, and Send is instant afterwards.
 */

import { ArrowUp, Paperclip, Square, X } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import {
  useCallback,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { newUuid, type Attachment } from '@ghostai/protocol';

import { cn } from '@/lib/cn.js';
import { api } from '@/lib/api.js';
import { useWorkspace } from '@/workspaces/workspace-context.js';
import { formatBytes } from '@/lib/format.js';
import { Button } from '@/components/ui/button.js';
import { toast } from '@/components/ui/toast.js';

interface ComposerProps {
  /**
   * A control at the start of the meta row — in practice the agent picker.
   *
   * Separate from `meta` because it is a *control* rather than a readout: what
   * the turn will run on is chosen, and what it will cost is only read.
   */
  readonly lead?: ReactNode;
  /** The readout at the end of the meta row. The context budget, in the app. */
  readonly meta?: ReactNode;
  readonly busy: boolean;
  readonly queueDepth: number;
  /** False while the socket is down — Send would only buffer. */
  readonly connected: boolean;
  /**
   * False until a provider and a model exist.
   *
   * Disabling the composer rather than hiding the route: every other screen
   * works on a fresh install, and a nav that changes shape underneath the user
   * is a worse answer than a control that says why it is off and where to go.
   */
  readonly configured: boolean;
  readonly onSend: (text: string, attachments: readonly Attachment[]) => void;
  readonly onStop: () => void;
}

/** An attachment that is on its way up, or has arrived. */
interface StagedFile {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly type: string;
  /** Set once the upload returns; absent while it is in flight. */
  readonly attachment: Attachment | undefined;
  readonly failed: boolean;
}

/**
 * The largest upload the server will take.
 *
 * Mirrored from `MAX_UPLOAD_BYTES` in `packages/server/src/routes/files.ts`,
 * where it is a Fastify `bodyLimit` — enforced as the body arrives rather than
 * after it is all in memory. The copy is deliberate: the browser bundle cannot
 * import from the server, and a value that only exists there means the user
 * finds out by waiting for a 413.
 */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function Composer({
  lead,
  meta,
  busy,
  queueDepth,
  connected,
  configured,
  onSend,
  onStop,
}: ComposerProps): JSX.Element {
  const { t } = useTranslation();
  const { workspaceId } = useWorkspace();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<readonly StagedFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const ready = files.every(
    (file) => file.attachment !== undefined || file.failed,
  );
  const attachments = files.flatMap((file) =>
    file.attachment ? [file.attachment] : [],
  );
  const canSend =
    configured && ready && (text.trim() !== '' || attachments.length > 0);

  const submit = useCallback(() => {
    if (!canSend) return;
    onSend(text.trim(), attachments);
    setText('');
    setFiles([]);
  }, [attachments, canSend, onSend, text]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Shift+Enter is a newline; Enter sends. The other way round is what chat
    // apps that are also editors do, and this is a chat app.
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submit();
    }
  };

  /**
   * The one way a file becomes an attachment, whichever gesture chose it.
   *
   * The size check is here rather than at the server's `bodyLimit` because
   * that one fires *after* the whole body has been pushed up the wire: a 60 MB
   * video spends a minute uploading to earn a 413 and a chip that says
   * "failed". Refusing locally costs nothing and can say why.
   */
  const addFiles = useCallback(
    (picked: readonly File[]): void => {
      for (const file of picked) {
        if (file.size > MAX_UPLOAD_BYTES) {
          toast.error(
            t('chat.attachTooLarge', {
              name: file.name,
              limit: formatBytes(MAX_UPLOAD_BYTES),
            }),
          );
          continue;
        }
        // The workspace the conversation is in, so an attachment lands beside
        // the files the turn can already see rather than in the default tree.
        void stage(file, workspaceId, setFiles);
      }
    },
    [t, workspaceId],
  );

  const onPickFiles = (event: ChangeEvent<HTMLInputElement>): void => {
    const picked = [...(event.target.files ?? [])];
    // Cleared so picking the same file twice in a row still fires `change`.
    event.target.value = '';
    addFiles(picked);
  };

  /**
   * Pasting a screenshot attaches it; pasting text stays ordinary text.
   *
   * The guard is what makes that true. `preventDefault` unconditionally would
   * break pasting a URL into the message, which is the far more common gesture
   * — so the event is only claimed when the clipboard actually carries files.
   */
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const picked = [...event.clipboardData.files];
    if (picked.length === 0) return;
    event.preventDefault();
    addFiles(picked);
  };

  /**
   * What is happening to this conversation right now, or nothing.
   *
   * `undefined` rather than an empty element: an idle composer should render no
   * line at all, and a `<p>` with nothing in it still takes the row's height
   * and still announces itself as a live region on every state change.
   */
  const status = composerStatus({ configured, connected, busy, queueDepth, t });

  return (
    <div className="composer">
      <div className="stack composer__inner">
        {files.length > 0 && (
          <ul className="cluster composer__files">
            {files.map((file) => (
              <li
                key={file.id}
                className={cn(
                  'composer__file',
                  file.failed && 'composer__file--failed',
                )}
              >
                <span className="composer__file-name truncate">
                  {file.name}
                </span>
                <span className="composer__file-state">
                  {file.failed
                    ? 'failed'
                    : file.attachment === undefined
                      ? 'uploading…'
                      : formatBytes(file.sizeBytes)}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => {
                    setFiles((current) =>
                      current.filter((entry) => entry.id !== file.id),
                    );
                  }}
                  className="composer__file-remove"
                >
                  <X />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="composer__box">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('chat.attachFile')}
            onClick={() => {
              fileInputRef.current?.click();
            }}
          >
            <Paperclip />
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={onPickFiles}
            aria-hidden="true"
            tabIndex={-1}
          />

          {/* The trailing newline in the mirror is what keeps the last line
              from being clipped as it is typed — see `.composer__grow`. */}
          <div className="composer__grow">
            <div aria-hidden="true" className="composer__mirror">
              {`${text}\n`}
            </div>
            <textarea
              value={text}
              rows={1}
              onChange={(event) => {
                setText(event.target.value);
              }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              disabled={!configured}
              placeholder={
                configured
                  ? busy
                    ? 'Queue another message…'
                    : 'Send a message…'
                  : t('chat.noModel')
              }
              aria-label={t('chat.message')}
              className="composer__input"
            />
          </div>

          {busy ? (
            <Button
              variant="danger"
              size="icon"
              aria-label={t('chat.stopTurn')}
              onClick={onStop}
            >
              <Square />
            </Button>
          ) : (
            <Button
              variant="primary"
              size="icon"
              aria-label={t('chat.send')}
              disabled={!canSend}
              onClick={submit}
            >
              <ArrowUp />
            </Button>
          )}
        </div>

        {/* The row under the box: what the turn runs on, anything happening to
            it right now, and what it will cost.

            **The keyboard hint is not here.** "Enter to send · Shift+Enter for a
            new line" is true forever and worth reading once, and it sat in the
            most valuable line of the screen — directly under the box being
            typed into — pushing the context budget to a corner. It is on the
            welcome screen now, where somebody who has never sent a message is
            already reading. What is left in this row is state that changes:
            offline, a turn running, messages queued. */}
        <div className="composer__meta">
          {lead}

          {/* No `role="status"`. The header's connection badge is already the
              live region for the socket, and a second one repeating it
              announces the same fact twice on every reconnect. */}
          {status !== undefined && <p className="composer__hint">{status}</p>}

          {/* The context budget. It arrives as a node rather than being built
              here because it needs the Query client and a session key, and this
              component is a leaf that its own tests mount without either. */}
          {meta}
        </div>
      </div>
    </div>
  );
}

/**
 * The one sentence the meta row has to say, if there is one.
 *
 * Only *transient* state qualifies. The rule this row is now written to: if a
 * line would be identical on every render for the life of the install, it is
 * documentation and belongs where somebody reads documentation — not under the
 * box, where it costs the width that the thing which actually changes needs.
 *
 * Offline comes first because it is the one that changes what pressing Send
 * does. A queue depth is appended to whatever else is true, since "a turn is
 * running" and "two messages are waiting" are both worth knowing at once.
 */
function composerStatus({
  configured,
  connected,
  busy,
  queueDepth,
  t,
}: {
  readonly t: TFunction;
  readonly configured: boolean;
  readonly connected: boolean;
  readonly busy: boolean;
  readonly queueDepth: number;
}): ReactNode | undefined {
  const parts: ReactNode[] = [];

  if (configured && !connected) {
    parts.push(
      <span key="offline" className="composer__hint--offline">
        {t('chat.offline')}
      </span>,
    );
  } else if (configured && busy) {
    parts.push(<span key="busy">{t('chat.turnRunning')}</span>);
  }

  if (queueDepth > 0) {
    parts.push(
      <span key="queued">{t('chat.queued', { count: queueDepth })}</span>,
    );
  }

  return parts.length === 0 ? undefined : parts;
}

/**
 * Uploads one file into the workspace and stages it.
 *
 * The path is prefixed with a short random segment rather than the file's own
 * name alone: two screenshots called `Screenshot.png` are the common case, and
 * the second silently overwriting the first is a data loss the user cannot see.
 */
async function stage(
  file: File,
  workspace: string,
  setFiles: (
    update: (current: readonly StagedFile[]) => readonly StagedFile[],
  ) => void,
): Promise<void> {
  const id = newUuid();
  const entry: StagedFile = {
    id,
    name: file.name,
    sizeBytes: file.size,
    type: file.type === '' ? 'application/octet-stream' : file.type,
    attachment: undefined,
    failed: false,
  };
  setFiles((current) => [...current, entry]);

  try {
    const path = `uploads/${id.slice(0, 8)}-${safeName(file.name)}`;
    const uploaded = await api.upload(workspace, path, file);

    setFiles((current) =>
      current.map((staged) =>
        staged.id === id
          ? {
              ...staged,
              attachment: {
                mimeType: uploaded.mimeType,
                // The workspace path, never a signed URL. The server reads the
                // bytes off disk when it builds the request, so this has to
                // survive longer than a ten-minute token — and the file tools
                // address the same path, which is what lets the model open a
                // file it cannot be shown.
                path: uploaded.path,
                // The name the user knows it by. `path` is mangled by
                // `safeName` and prefixed, so the two deliberately differ: this
                // one is for the chip, that one is for the model.
                name: file.name,
                sizeBytes: uploaded.sizeBytes,
              },
            }
          : staged,
      ),
    );
  } catch (error) {
    setFiles((current) =>
      current.map((staged) =>
        staged.id === id ? { ...staged, failed: true } : staged,
      ),
    );
    toast.error(
      `Could not upload ${file.name}`,
      error instanceof Error ? error.message : undefined,
    );
  }
}

/** Whatever the OS allowed in a filename, reduced to what a workspace path allows. */
function safeName(name: string): string {
  return name.replace(/[^\w.-]+/g, '-').slice(0, 64) || 'file';
}
