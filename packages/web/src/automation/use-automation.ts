/**
 * The Automation panel's reads and writes.
 *
 * Its own file rather than more of `use-settings.ts`, for the reason
 * `use-provider.ts` is: a job is not in the settings tree. It has its own
 * routes, its own cache key and its own invalidations, and folding it into the
 * settings hooks would make every job edit refetch the provider list.
 *
 * One toast per press, everywhere. `runNow` is the one that needs saying out
 * loud, because what it starts is invisible: the route answers 202 the instant
 * the run is queued, and the answer arrives minutes later as a notification. A
 * press with no feedback would read as a button that does nothing.
 */

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  AutomationJob,
  AutomationJobListResponse,
  AutomationRun,
  AutomationRunListResponse,
  CreateAutomationJob,
  UpdateAutomationJob,
} from '@ghostai/protocol';

import { api } from '@/lib/api.js';
import { queryKeys } from '@/lib/query.js';
import { toast } from '@/components/ui/toast.js';

/**
 * `onSuccess` receives what the server returned, not nothing.
 *
 * The create dialog navigates into the editor for the job it just made, and
 * the id is assigned server-side — without the result there is nothing to
 * navigate to.
 */
export interface MutationHandle<T, R = void> {
  readonly mutate: (input: T, options?: { readonly onSuccess?: (result: R) => void }) => void;
  readonly pending: boolean;
}

export function useAutomationJobs(): UseQueryResult<AutomationJobListResponse> {
  return useQuery({
    queryKey: queryKeys.automation,
    queryFn: ({ signal }) => api.automationJobs(signal),
  });
}

/**
 * One job's runs.
 *
 * `enabled` is what lets the editor call this unconditionally: hooks cannot be
 * conditional, and a job being created has no id to ask about — without the
 * flag the create page would request `/api/automation/jobs//runs`.
 */
export function useAutomationRuns(jobId: string): UseQueryResult<AutomationRunListResponse> {
  return useQuery({
    queryKey: queryKeys.automationRuns(jobId),
    queryFn: ({ signal }) => api.automationRuns(jobId, { signal }),
    enabled: jobId !== '',
  });
}

export function useCreateJob(): MutationHandle<CreateAutomationJob, AutomationJob> {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (body: CreateAutomationJob) => api.createAutomationJob(body),
    onSuccess: (job: AutomationJob) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.automation });
      toast.success('Job created', job.name);
    },
    // The server's own words, never a generic replacement: a 422 here says
    // which field of the cron expression was wrong, and that sentence is the
    // whole value of the response.
    onError: (error: Error) => {
      toast.error('Could not create the job', error.message);
    },
  });
  return { mutate: mutation.mutate, pending: mutation.isPending };
}

export function useSaveJob(jobId: string): MutationHandle<UpdateAutomationJob, AutomationJob> {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (body: UpdateAutomationJob) => api.updateAutomationJob(jobId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.automation });
      toast.success('Job saved');
    },
    onError: (error: Error) => {
      toast.error('Could not save the job', error.message);
    },
  });
  return { mutate: mutation.mutate, pending: mutation.isPending };
}

export function useRemoveJob(): MutationHandle<string> {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (id: string) => api.deleteAutomationJob(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.automation });
      toast.success('Job deleted');
    },
    onError: (error: Error) => {
      toast.error('Could not delete the job', error.message);
    },
  });
  return { mutate: mutation.mutate, pending: mutation.isPending };
}

// `AutomationRun`, because that is what the route answers with. Typed as the
// job here, it agreed with a client that was parsing the wrong schema — so the
// two halves of one mistake type-checked against each other.
export function useRunJob(): MutationHandle<string, AutomationRun> {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (id: string) => api.runAutomationJob(id),
    onSuccess: (_run, id: string) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.automation });
      void queryClient.invalidateQueries({ queryKey: queryKeys.automationRuns(id) });
      // Said out loud because the run is invisible: the route answered the
      // moment it queued, and the result lands minutes later as a notification.
      toast.success('Run started', 'The result will arrive in your notifications.');
    },
    onError: (error: Error) => {
      toast.error('Could not start the run', error.message);
    },
  });
  return { mutate: mutation.mutate, pending: mutation.isPending };
}
