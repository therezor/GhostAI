/**
 * The chat view — Step 17.
 *
 * The route exists now because the shell has to link somewhere and the
 * `?session=` search parameter has to be validated somewhere; the transcript,
 * the composer and the socket are the next step's work.
 */

import { useSearch } from '@tanstack/react-router';
import type { JSX } from 'react';

import { Placeholder } from './placeholder.js';

export function ChatRoute(): JSX.Element {
  const { session } = useSearch({ from: '/' });

  return (
    <Placeholder title="Chat" step="Step 17">
      Streaming markdown, tool cards, the approval prompt and the composer arrive with the WebSocket
      transport.
      {session !== undefined && ` Requested session: ${session}.`}
    </Placeholder>
  );
}
