/**
 * Which workspace you are working in, and the way to the manager.
 *
 * In the sidebar rather than the header, full width, directly above the nav.
 * It scopes two things below it — the Files page and the session list — and a
 * control in the header would be separated from both by the whole width of the
 * app. The header is also already carrying a wordmark, the resolved model, a
 * connection badge, the context gauge and the theme control; this is not the
 * thing to spend its last slot on.
 *
 * A `DropdownMenu` rather than a `Select`, following `theme-switcher.tsx`'s
 * shape: the list needs a separator and a "Manage workspaces…" item, and a
 * listbox cannot carry either. The radio group is what makes the current
 * workspace announce as selected rather than as one of several buttons.
 *
 * The note about `default` is not decoration. `default` is the folder that
 * *contains* every other workspace, so a turn in it can read and write all of
 * them. A user who has not been told that will reasonably assume the workspaces
 * are isolated from each other, which is only true between the named ones.
 */

import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, Settings2 } from 'lucide-react';
import { useState, type JSX } from 'react';

import { Button } from '@/components/ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.js';
import { api } from '@/lib/api.js';
import { cn } from '@/lib/cn.js';
import { queryKeys } from '@/lib/query.js';
import { WorkspaceManager } from './workspace-manager.js';
import { DEFAULT_WORKSPACE_ID, useWorkspace } from './workspace-context.js';

export function WorkspaceSwitcher({
  onNavigate,
  rowClassName,
}: {
  readonly onNavigate?: () => void;
  /**
   * The host's own row treatment, applied to the trigger.
   *
   * Passed in rather than reproduced here: the switcher is only ever rendered
   * in the sidebar, and it is meant to look like exactly the rows beneath it.
   * Two stylesheets agreeing about what a row looks like is two stylesheets
   * that eventually will not.
   */
  readonly rowClassName?: string;
}): JSX.Element {
  const { workspaceId, select } = useWorkspace();
  const [managing, setManaging] = useState(false);

  const workspaces = useQuery({
    queryKey: queryKeys.workspaces,
    queryFn: ({ signal }) => api.workspaces(signal),
  });

  const rows = workspaces.data?.workspaces ?? [];
  // Named from the fetched row when it has arrived, and from the id until then
  // — a switcher that reads "Loading…" on every mount is a switcher that
  // flickers on every navigation.
  const current = rows.find((row) => row.id === workspaceId);

  return (
    <div className="workspace-switcher">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className={cn('workspace-switcher__trigger', rowClassName)}
            aria-label={`Workspace: ${current?.name ?? workspaceId}`}
          >
            <span className="workspace-switcher__name truncate">
              {current?.name ?? workspaceId}
            </span>
            {/* The chevron is the affordance. The leading folder icon that used
                to be here was saying what the label above now says, and a
                control with an icon at both ends reads as a button rather than
                as the picker it is. */}
            <ChevronDown className="workspace-switcher__caret" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="floating--menu">
          <DropdownMenuRadioGroup
            value={workspaceId}
            onValueChange={(value) => {
              select(value);
              onNavigate?.();
            }}
          >
            {rows.map((workspace) => (
              <DropdownMenuRadioItem key={workspace.id} value={workspace.id}>
                <span className="truncate">{workspace.name}</span>
                {workspace.isDefault && (
                  <span className="workspace-switcher__hint">holds the others</span>
                )}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>

          <DropdownMenuSeparator />

          <DropdownMenuItem
            onSelect={() => {
              setManaging(true);
            }}
          >
            <Settings2 />
            Manage workspaces…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {workspaceId === DEFAULT_WORKSPACE_ID && rows.length > 1 && (
        <p className="workspace-switcher__note">
          <Check aria-hidden="true" />
          Default holds every other workspace, so it can reach their files too.
        </p>
      )}

      <WorkspaceManager open={managing} onOpenChange={setManaging} />
    </div>
  );
}
