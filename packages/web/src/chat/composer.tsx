/**
 * The composer.
 *
 * Four things that are each slightly harder than they look:
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
 *  - **The `@` autocomplete is a listbox, not a div.** It is the one popover
 *    here a keyboard user has to drive, and `role="listbox"` with
 *    `aria-activedescendant` is what makes the arrow keys mean something to a
 *    screen reader while focus stays in the textarea where the typing is.
 */

import { ArrowUp, Paperclip, Square, X } from 'lucide-react';
import {
  useCallback,
  useRef,
  useState,
  type ChangeEvent,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import type { Attachment } from '@ghostai/protocol';

import { cn } from '@/lib/cn.js';
import { api } from '@/lib/api.js';
import { useWorkspace } from '@/workspaces/workspace-context.js';
import { formatBytes } from '@/lib/format.js';
import { Button } from '@/components/ui/button.js';
import { toast } from '@/components/ui/toast.js';
import {
  applyMention,
  mentionAtCaret,
  mentionSuggestions,
  type MentionSuggestion,
} from './mentions.js';

export interface ComposerProps {
  /**
   * A starting point, not a message.
   *
   * The welcome screen's prompts fill the composer rather than sending, because
   * the useful version of "Run the test suite" almost always has a clause added
   * to it. The route remounts this component on a new value, which is what makes
   * a plain `useState` initialiser the whole implementation.
   */
  readonly initialText?: string | undefined;
  /** Rendered on the right of the hint line. The context strip, in the app. */
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

export function Composer({
  initialText,
  meta,
  busy,
  queueDepth,
  connected,
  configured,
  onSend,
  onStop,
}: ComposerProps): JSX.Element {
  const { workspaceId } = useWorkspace();
  const [text, setText] = useState(initialText ?? '');
  const [files, setFiles] = useState<readonly StagedFile[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listboxId = 'composer-mentions';

  const caret = textareaRef.current?.selectionStart ?? text.length;
  const query = dismissed ? undefined : mentionAtCaret(text, caret);
  const suggestions = query === undefined ? [] : mentionSuggestions(query);
  const open = suggestions.length > 0;

  const ready = files.every((file) => file.attachment !== undefined || file.failed);
  const attachments = files.flatMap((file) => (file.attachment ? [file.attachment] : []));
  const canSend = configured && ready && (text.trim() !== '' || attachments.length > 0);

  const submit = useCallback(() => {
    if (!canSend) return;
    onSend(text.trim(), attachments);
    setText('');
    setFiles([]);
    setDismissed(false);
  }, [attachments, canSend, onSend, text]);

  const accept = useCallback(
    (suggestion: MentionSuggestion) => {
      if (query === undefined) return;
      const next = applyMention(text, query, suggestion);
      setText(next.text);
      setHighlight(0);
      // The caret has to be restored after React writes the value, or it lands
      // at the end of the text rather than after the namespace just inserted.
      requestAnimationFrame(() => {
        textareaRef.current?.setSelectionRange(next.caret, next.caret);
      });
    },
    [query, text],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setHighlight((value) => (value + step + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const suggestion = suggestions[highlight];
        if (suggestion !== undefined) {
          event.preventDefault();
          accept(suggestion);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(true);
        return;
      }
    }

    // Shift+Enter is a newline; Enter sends. The other way round is what chat
    // apps that are also editors do, and this is a chat app.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const onPickFiles = (event: ChangeEvent<HTMLInputElement>): void => {
    const picked = [...(event.target.files ?? [])];
    // Cleared so picking the same file twice in a row still fires `change`.
    event.target.value = '';
    // The workspace the conversation is in, so an attachment lands beside
    // the files the turn can already see rather than in the default tree.
    for (const file of picked) void stage(file, workspaceId, setFiles);
  };

  return (
    <div className="composer">
      <div className="stack composer__inner">
        {files.length > 0 && (
          <ul className="cluster composer__files">
            {files.map((file) => (
              <li
                key={file.id}
                className={cn('composer__file', file.failed && 'composer__file--failed')}
              >
                <span className="composer__file-name truncate">{file.name}</span>
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
                    setFiles((current) => current.filter((entry) => entry.id !== file.id));
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
          {open && (
            <ul id={listboxId} role="listbox" aria-label="Mentions" className="composer__mentions">
              {suggestions.map((suggestion, index) => (
                <li
                  key={suggestion.insert}
                  id={`${listboxId}-${String(index)}`}
                  role="option"
                  aria-selected={index === highlight}
                  onMouseDown={(event) => {
                    // `mousedown`, not `click`: `click` fires after the blur
                    // that closes the popover, so the suggestion is gone by then.
                    event.preventDefault();
                    accept(suggestion);
                  }}
                  className={cn(
                    'composer__mention',
                    index === highlight && 'composer__mention--active',
                  )}
                >
                  <span className="composer__mention-label">{suggestion.label}</span>
                  <span className="composer__mention-hint truncate">{suggestion.hint}</span>
                </li>
              ))}
            </ul>
          )}

          <Button
            variant="ghost"
            size="icon"
            aria-label="Attach a file"
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
              ref={textareaRef}
              value={text}
              rows={1}
              onChange={(event) => {
                setText(event.target.value);
                setDismissed(false);
                setHighlight(0);
              }}
              onKeyDown={onKeyDown}
              disabled={!configured}
              placeholder={
                configured
                  ? busy
                    ? 'Queue another message…'
                    : 'Send a message…'
                  : 'No model configured yet'
              }
              aria-label="Message"
              // `aria-expanded` and `aria-activedescendant`, but deliberately
              // *not* `role="combobox"`. The role would have to be present
              // whether the popover is open or not — a control whose role
              // changes as you type is a control a screen reader re-announces
              // mid-sentence — and a permanent combobox is the wrong promise
              // for a box whose main job is multi-line prose.
              aria-expanded={open}
              {...(open
                ? {
                    'aria-controls': listboxId,
                    'aria-activedescendant': `${listboxId}-${String(highlight)}`,
                  }
                : {})}
              className="composer__input"
            />
          </div>

          {busy ? (
            <Button
              variant="danger"
              size="icon"
              aria-label="Stop the current turn"
              onClick={onStop}
            >
              <Square />
            </Button>
          ) : (
            <Button
              variant="primary"
              size="icon"
              aria-label="Send"
              disabled={!canSend}
              onClick={submit}
            >
              <ArrowUp />
            </Button>
          )}
        </div>

        <div className="composer__meta">
          <p className="composer__hint">
            {configured && !connected && (
              <span className="composer__hint--offline">
                Offline — messages will be sent when the connection returns.
              </span>
            )}
            {configured && connected && busy && (
              <span>A turn is running. Enter queues your message.</span>
            )}
            {queueDepth > 0 && (
              <span>
                {queueDepth} message{queueDepth === 1 ? '' : 's'} waiting.
              </span>
            )}
            {configured && connected && !busy && queueDepth === 0 && (
              <span>Enter to send · Shift+Enter for a new line · @ to scope the turn</span>
            )}
          </p>

          {/* Whatever the route wants beside the hint — in practice the context
              budget. It arrives as a node rather than being built here because
              it needs the Query client and a session key, and this component is
              a leaf that its own tests mount without either. */}
          {meta}
        </div>
      </div>
    </div>
  );
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
  setFiles: (update: (current: readonly StagedFile[]) => readonly StagedFile[]) => void,
): Promise<void> {
  const id = crypto.randomUUID();
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
                type: uploaded.mimeType,
                // The signed URL, not the workspace path: a provider fetching
                // an image needs something it can resolve, and the path means
                // nothing outside this machine.
                url: uploaded.signedUrl?.url ?? uploaded.path,
                name: file.name,
                sizeBytes: uploaded.sizeBytes,
              },
            }
          : staged,
      ),
    );
  } catch (error) {
    setFiles((current) =>
      current.map((staged) => (staged.id === id ? { ...staged, failed: true } : staged)),
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
