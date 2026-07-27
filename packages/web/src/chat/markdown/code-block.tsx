/**
 * A fenced code block.
 *
 * Three things happen here, in this order of importance:
 *
 *  1. **The code is on screen immediately, unhighlighted.** Plain monospace is
 *     already readable; colour is an improvement on something that works, not a
 *     precondition for it. Nothing here ever renders a spinner in place of code.
 *  2. **Highlighting waits for two conditions.** The block has to have stopped
 *     growing — a half-written fence re-tokenises on every delta and flickers
 *     between two colourings — and the browser has to be idle, because the main
 *     thread during a stream belongs to the stream.
 *  3. **Shiki arrives through a dynamic `import()`.** The grammar engine, the
 *     theme and the language are all behind it, so a conversation with no code
 *     in it never downloads any of them. `highlight.ts` explains the rest.
 *
 * The theme comes from the shared context rather than a local `useTheme`, which
 * is what lets flipping to light re-highlight every block on the page instead of
 * only the ones that happen to remount.
 */

import { Check, Copy } from 'lucide-react';
import { useEffect, useState, type JSX } from 'react';

import { cn } from '@/lib/cn.js';
import { onIdle } from '@/lib/idle.js';
import { useAppTheme } from '@/theme/theme-context.js';
import type { HighlightedLines } from './highlight.js';

export interface CodeBlockProps {
  readonly code: string;
  /** The fence's language, already normalised. Empty means none was given. */
  readonly lang: string;
  /** False while the fence is still being written. */
  readonly complete: boolean;
}

export function CodeBlock({ code, lang, complete }: CodeBlockProps): JSX.Element {
  const { resolved } = useAppTheme();
  const [lines, setLines] = useState<HighlightedLines | undefined>(undefined);

  useEffect(() => {
    if (!complete || lang === '') return undefined;

    let cancelled = false;
    const idle = onIdle(() => {
      void (async () => {
        try {
          const { highlight } = await import('./highlight.js');
          const result = await highlight(code, lang, resolved);
          if (!cancelled && result !== undefined) setLines(result);
        } catch {
          // A grammar that failed to load, or an engine the browser refused.
          // The block is already rendered and readable; colour is what is lost.
        }
      })();
    });

    return () => {
      cancelled = true;
      idle.cancel();
    };
  }, [code, lang, complete, resolved]);

  // The highlight belongs to the code that produced it. Without this, a delta
  // that changes the last line would leave the previous colouring on screen
  // over new text for as long as the next idle callback takes to arrive.
  const highlighted = complete ? lines : undefined;

  return (
    <figure className="overflow-hidden rounded-md border border-line bg-surface-1">
      <figcaption className="flex items-center justify-between border-b border-line px-3 py-1">
        <span className="font-mono text-2xs tracking-wide text-fg-3 uppercase">
          {lang === '' ? 'text' : lang}
        </span>
        <CopyButton text={code} />
      </figcaption>

      <pre className="overflow-x-auto p-3 text-sm leading-relaxed">
        <code className="font-mono">
          {highlighted === undefined
            ? code
            : highlighted.map((line, index) => (
                <span key={index} className="block min-h-[1lh]">
                  {line.map((token, tokenIndex) => (
                    // The colour is the theme's, applied inline. It is the one
                    // place a raw colour is correct: a syntax theme is not part
                    // of the design system and cannot be expressed in its tokens.
                    <span key={tokenIndex} style={{ color: token.color }}>
                      {token.content}
                    </span>
                  ))}
                </span>
              ))}
        </code>
      </pre>
    </figure>
  );
}

/**
 * Copy, with the confirmation on the button rather than in a toast.
 *
 * A toast for "copied" is a notification about something the user just did and
 * is already looking at. The check mark is where their eye already is.
 */
function CopyButton({ text }: { readonly text: string }): JSX.Element {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => {
      setCopied(false);
    }, 1500);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);

  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : 'Copy code'}
      onClick={() => {
        void copyToClipboard(text).then((ok) => {
          if (ok) setCopied(true);
        });
      }}
      className={cn(
        'flex items-center gap-1 rounded-xs px-1.5 py-0.5 text-2xs',
        'text-fg-3 hover:bg-hover hover:text-fg-1',
        copied && 'text-success-fg',
      )}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/**
 * Copies, and says whether it worked.
 *
 * `navigator.clipboard` is typed as always present and is absent on an insecure
 * origin and in jsdom, where reading `.writeText` off it throws synchronously —
 * so the whole call is inside the `try`, not just the promise. A refusal is a
 * button that does not claim success, not an error the user has to dismiss.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
