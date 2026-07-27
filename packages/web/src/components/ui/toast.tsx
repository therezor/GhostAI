/**
 * Toasts — one helper, one viewport.
 *
 * `toast()` is a plain function backed by a Zustand store rather than a hook,
 * and that is the whole design: the things that need to report a failure are
 * not components. Step 17's WebSocket transport raises "reconnecting" from a
 * socket handler, `api.ts` raises "your session expired" from a fetch, and a
 * mutation raises "saved" from a callback. A `useToast()` hook would be
 * unreachable from all three.
 *
 * Radix supplies the part that is genuinely hard: an `aria-live` region that
 * announces without stealing focus, swipe-to-dismiss, and `F6` to jump to the
 * viewport — a toast carrying an action a keyboard user cannot reach is a toast
 * that lied.
 */

import * as ToastPrimitive from '@radix-ui/react-toast';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import type { JSX } from 'react';
import { create } from 'zustand';

import { cn } from '@/lib/cn.js';

export type ToastRole = 'info' | 'success' | 'warning' | 'danger';

export interface ToastInput {
  readonly title: string;
  readonly description?: string;
  readonly role?: ToastRole;
  /** Omitted means the role's default: errors stay until dismissed. */
  readonly durationMs?: number;
  readonly action?: { readonly label: string; readonly onSelect: () => void };
}

interface ToastRecord extends ToastInput {
  readonly id: number;
}

interface ToastStore {
  readonly toasts: readonly ToastRecord[];
  readonly push: (input: ToastInput) => number;
  readonly dismiss: (id: number) => void;
}

/**
 * Ids come from a counter, not `Date.now()` or a random: two toasts raised in
 * the same millisecond would collide, and React would reuse one's DOM node for
 * the other.
 */
let nextId = 0;

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  push: (input) => {
    const id = (nextId += 1);
    set((state) => ({ toasts: [...state.toasts, { ...input, id }] }));
    return id;
  },
  dismiss: (id) => {
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
  },
}));

/** Raise a toast from anywhere — a component, a socket handler, a catch block. */
export function toast(input: ToastInput): number {
  return useToastStore.getState().push(input);
}

toast.success = (title: string, description?: string): number =>
  toast({ title, role: 'success', ...(description === undefined ? {} : { description }) });

toast.error = (title: string, description?: string): number =>
  toast({ title, role: 'danger', ...(description === undefined ? {} : { description }) });

const ICONS: Record<ToastRole, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: AlertTriangle,
};

const ROLE_CLASSES: Record<ToastRole, string> = {
  info: 'text-info-fg',
  success: 'text-success-fg',
  warning: 'text-warning-fg',
  danger: 'text-danger-fg',
};

/**
 * A failure that vanishes in four seconds is a failure the user has to
 * reproduce to read. Errors and warnings wait to be dismissed.
 */
function durationOf({ role = 'info', durationMs }: ToastInput): number {
  if (durationMs !== undefined) return durationMs;
  return role === 'danger' || role === 'warning' ? Infinity : 4500;
}

/** Mounted once, in `providers.tsx`. */
export function Toaster(): JSX.Element {
  const toasts = useToastStore((state) => state.toasts);
  const dismiss = useToastStore((state) => state.dismiss);

  return (
    <ToastPrimitive.Provider swipeDirection="right">
      {toasts.map((record) => {
        const role = record.role ?? 'info';
        const Icon = ICONS[role];

        return (
          <ToastPrimitive.Root
            key={record.id}
            duration={durationOf(record)}
            onOpenChange={(open) => {
              if (!open) dismiss(record.id);
            }}
            className={cn(
              'flex items-start gap-3 rounded-lg border border-line bg-surface-3 p-3 shadow-lg',
              'data-[state=open]:animate-slide-in data-[state=closed]:animate-fade-out',
              'data-[swipe=end]:animate-fade-out',
            )}
          >
            <Icon className={cn('mt-0.5 size-4 shrink-0', ROLE_CLASSES[role])} />

            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <ToastPrimitive.Title className="text-sm font-medium text-fg-1">
                {record.title}
              </ToastPrimitive.Title>
              {record.description !== undefined && (
                <ToastPrimitive.Description className="text-xs break-words text-fg-2">
                  {record.description}
                </ToastPrimitive.Description>
              )}
            </div>

            {record.action !== undefined && (
              <ToastPrimitive.Action
                altText={record.action.label}
                onClick={record.action.onSelect}
                className="rounded-md px-2 py-1 text-xs font-medium text-accent-fg hover:bg-hover"
              >
                {record.action.label}
              </ToastPrimitive.Action>
            )}

            <ToastPrimitive.Close
              aria-label="Dismiss"
              className="rounded-md p-1 text-fg-3 hover:bg-hover hover:text-fg-1"
            >
              <X className="size-3.5" />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        );
      })}

      <ToastPrimitive.Viewport
        className={cn(
          'fixed right-0 bottom-0 z-50 flex w-[min(24rem,100vw)] flex-col gap-2 p-4',
          'max-h-dvh overflow-hidden',
        )}
      />
    </ToastPrimitive.Provider>
  );
}

/** Test seam: the store is module state, and a suite needs it empty per case. */
export function resetToasts(): void {
  useToastStore.setState({ toasts: [] });
}
