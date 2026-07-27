/**
 * A route that does not exist.
 *
 * Reachable in one realistic way: a bookmark to a panel that moved. So it
 * offers the way back rather than an apology.
 */

import { Link } from '@tanstack/react-router';
import type { JSX } from 'react';

import { buttonVariants } from '@/components/ui/button.js';

export function NotFoundRoute(): JSX.Element {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-start gap-3 p-8">
      <h1 className="text-xl font-medium">Not found</h1>
      <p className="text-sm text-fg-2">There is nothing at this address.</p>
      <Link to="/" className={buttonVariants({ variant: 'secondary' })}>
        Back to chat
      </Link>
    </div>
  );
}
