/**
 * Reading and writing the settings tree.
 *
 * Three hooks, and the interesting one is `useSaveSettings`. What it invalidates
 * is not bookkeeping — it is the client half of the step's acceptance test. A
 * settings save rebuilds the provider, the workspace jail and the tool registry
 * on the server, so the header's resolved model, the provider list's credential
 * dots, the model catalogue and the registered tool list are all potentially
 * stale the moment a save succeeds. A panel that invalidated only its own query
 * would leave the header naming the model the operator just changed away from,
 * which reads as a save that did not take.
 *
 * The response is written straight into the cache rather than triggering a
 * refetch: `PATCH /api/settings` answers with the same `SettingsResponse` a GET
 * would, so a second round trip would ask a question the server already
 * answered.
 */

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { ConfigPatch, SetCredentialRequest, SettingsResponse } from '@ghostai/protocol';

import { api } from '@/lib/api.js';
import { queryKeys } from '@/lib/query.js';
import { toast } from '@/components/ui/toast.js';

export function useSettings(): UseQueryResult<SettingsResponse> {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: ({ signal }) => api.settings(signal),
  });
}

export interface SaveHandle<T> {
  readonly save: (input: T) => void;
  readonly saving: boolean;
}

export function useSaveSettings(): SaveHandle<ConfigPatch> {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (patch: ConfigPatch) => api.patchSettings(patch),
    onSuccess: (response) => {
      queryClient.setQueryData(queryKeys.settings, response);
      for (const key of [
        queryKeys.status,
        queryKeys.providers,
        queryKeys.models,
        queryKeys.tools,
      ]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      toast.success('Settings saved');
    },
    onError: (error: Error) => {
      // The server's message, not a generic one: a refused patch says *which*
      // field could not be served — "auth cannot be disabled on a LAN bind" is
      // the whole answer, and "could not save" is none of it.
      toast.error('Could not save settings', error.message);
    },
  });

  return { save: mutation.mutate, saving: mutation.isPending };
}

/**
 * Storing one credential.
 *
 * Separate from `useSaveSettings` because it is a different route with a
 * different rule: the vault is write-only over HTTP, so this returns nothing and
 * the only observable effect is `credentialsPresent` flipping in the settings
 * response it invalidates. That flip is the acceptance test for the step — a key
 * saved here is in the vault, and the runtime re-reads the vault on every
 * provider build, so the next turn uses it without a restart.
 */
export function useSaveCredential(): SaveHandle<SetCredentialRequest> {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (input: SetCredentialRequest) => api.setCredential(input),
    onSuccess: (_result, input) => {
      for (const key of [queryKeys.settings, queryKeys.providers, queryKeys.status]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      toast.success(
        input.value === null ? 'Key removed' : 'Key saved',
        'The next turn will use it.',
      );
    },
    onError: (error: Error) => {
      toast.error('Could not save the key', error.message);
    },
  });

  return { save: mutation.mutate, saving: mutation.isPending };
}
