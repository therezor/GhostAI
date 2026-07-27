/**
 * The notification centre — Step 18.
 */

import type { JSX } from 'react';

import { Placeholder } from './placeholder.js';

export function NotificationsRoute(): JSX.Element {
  return (
    <Placeholder title="Notifications" step="Step 18">
      The server already records these; this is the panel that reads and dismisses them.
    </Placeholder>
  );
}
