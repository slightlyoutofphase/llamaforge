/**
 * @packageDocumentation
 * TanStack Query hooks for asynchronous state management and backend API interaction.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "./api";

/**
 * Cache keys for TanStack Query.
 */
export const queryKeys = {
  presetsLoad: () => ["presets", "load"] as const,
  presetsInference: () => ["presets", "inference"] as const,
  presetsSystem: () => ["presets", "system"] as const,
  chats: (q?: string) => ["chats", { q }] as const,
  chat: (id: string) => ["chat", id] as const,
  settings: () => ["settings"] as const,
};

// --- Chats ---

/**
 * Hook to retrieve all chat sessions, optionally filtered by a search query.
 *
 * @param q - Optional search string to filter chat names.
 * @returns A query object containing the list of {@link ChatSession} summaries.
 */
export function useChats(q?: string) {
  return useQuery({
    queryKey: queryKeys.chats(q),
    queryFn: () => api.fetchChats(q),
  });
}

/**
 * Custom React Query hook to perform infinite querying of chats with support for a search string.
 *
 * @param q - Search query string to filter chats by name.
 * @returns The React Query infinite query result.
 */
export function useInfiniteChats(q?: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.chats(q),
    queryFn: ({ pageParam = 0 }) => api.fetchChats(q, 150, pageParam),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      // If the last page is empty, we are definitively at the end
      if (lastPage.length === 0) return undefined;
      // If the last page has less than the requested limit, we are also at the end
      if (lastPage.length < 150) return undefined;
      // the next offset is the sum of items loaded so far
      return allPages.reduce((acc, page) => acc + page.length, 0);
    },
  });
}

/**
 * Hook to retrieve a single chat session with its full message history.
 *
 * @param id - The unique UUID of the chat session.
 * @returns A query object containing the full {@link ChatSession}.
 */
export function useChat(id: string) {
  return useQuery({
    queryKey: queryKeys.chat(id),
    queryFn: () => api.fetchChat(id),
    enabled: !!id,
  });
}

/**
 * Hook to create a new chat session.
 *
 * @returns A mutation object for creating a chat.
 */
export function useCreateChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createChat,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.chats() }),
  });
}

/**
 * Hook to update an existing chat session's metadata.
 *
 * @returns A mutation object for updating a chat.
 */
export function useUpdateChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: Parameters<typeof api.updateChat>[1] }) =>
      api.updateChat(id, updates),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: queryKeys.chat(id) });
      qc.invalidateQueries({ queryKey: queryKeys.chats() });
    },
  });
}

/**
 * Hook to update a specific message's content in a chat session.
 *
 * @returns A mutation object for updating a message.
 */
export function useUpdateMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      chatId,
      messageId,
      content,
      thinkingContent,
    }: {
      chatId: string;
      messageId: string;
      content: string;
      thinkingContent?: string;
    }) => api.updateMessage(chatId, messageId, content, thinkingContent),
    onSuccess: (_, { chatId }) => {
      qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
    },
  });
}

/**
 * Hook to delete a specific message and all subsequent messages in a chat.
 *
 * @returns A mutation object for deleting a message.
 */
export function useDeleteMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ chatId, messageId }: { chatId: string; messageId: string }) =>
      api.deleteMessage(chatId, messageId),
    onSuccess: (_, { chatId }) => {
      qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
    },
  });
}

/**
 * Hook to delete a chat session and its associated data.
 *
 * @returns A mutation object for deleting a chat.
 */
export function useDeleteChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.deleteChat,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.chats() }),
  });
}

/**
 * Hook to create a new branch from a specific message in a chat history.
 *
 * @returns A mutation object for branching a chat.
 */
export function useBranchChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, messageId }: { id: string; messageId: string }) =>
      api.branchChat(id, messageId),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.chats() }),
  });
}

/**
 * Hook to trigger a re-generation of the last assistant message or a specific turn.
 *
 * @returns A mutation object for regenerating.
 */
export function useRegenerateChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.regenerateChat,
    onSuccess: (_, id) => qc.invalidateQueries({ queryKey: queryKeys.chat(id) }),
  });
}

/**
 * Hook to continue a partial assistant response.
 *
 * @returns A mutation object for continuing a response.
 */
export function useContinueChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.continueChat,
    onSuccess: (_, id) => qc.invalidateQueries({ queryKey: queryKeys.chat(id) }),
  });
}

// --- Inference Presets ---

/**
 * Hook to retrieve all inference presets (sampling configurations).
 *
 * @returns A query object containing the list of {@link InferencePreset} objects.
 */
export function useInferencePresets() {
  return useQuery({
    queryKey: queryKeys.presetsInference(),
    queryFn: api.fetchInferencePresets,
  });
}

/**
 * Hook to create a new inference preset.
 *
 * @returns A mutation object for creation.
 */
export function useCreateInferencePreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createInferencePreset,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.presetsInference() }),
  });
}

/**
 * Hook to update an existing inference preset.
 *
 * @returns A mutation object for update.
 */
export function useUpdateInferencePreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      updates,
    }: {
      id: string;
      updates: Parameters<typeof api.updateInferencePreset>[1];
    }) => api.updateInferencePreset(id, updates),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.presetsInference() }),
  });
}

/**
 * Hook to delete an inference preset.
 *
 * @returns A mutation object for deletion.
 */
export function useDeleteInferencePreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.deleteInferencePreset,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.presetsInference() }),
  });
}

// --- Load Presets ---

/**
 * Hook to retrieve all model load presets (llama-server spawn configs).
 *
 * @returns A query object containing the list of {@link LoadPreset} objects.
 */
export function useLoadPresets() {
  return useQuery({
    queryKey: queryKeys.presetsLoad(),
    queryFn: api.fetchLoadPresets,
  });
}

/**
 * Hook to create a new model load preset.
 *
 * @returns A mutation object for creation.
 */
export function useCreateLoadPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createLoadPreset,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.presetsLoad() }),
  });
}

/**
 * Hook to update an existing model load preset.
 *
 * @returns A mutation object for update.
 */
export function useUpdateLoadPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      updates,
    }: {
      id: string;
      updates: Parameters<typeof api.updateLoadPreset>[1];
    }) => api.updateLoadPreset(id, updates),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.presetsLoad() }),
  });
}

/**
 * Hook to delete a model load preset.
 *
 * @returns A mutation object for deletion.
 */
export function useDeleteLoadPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.deleteLoadPreset,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.presetsLoad() }),
  });
}

// --- System Presets ---

/**
 * Hook to retrieve all system prompt presets.
 *
 * @returns A query object containing the list of {@link SystemPromptPreset} objects.
 */
export function useSystemPresets() {
  return useQuery({
    queryKey: queryKeys.presetsSystem(),
    queryFn: api.fetchSystemPresets,
  });
}

/**
 * Hook to create a new system prompt preset.
 *
 * @returns A mutation object for creation.
 */
export function useCreateSystemPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.createSystemPreset,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.presetsSystem() }),
  });
}

/**
 * Hook to update an existing system prompt preset.
 *
 * @returns A mutation object for update.
 */
export function useUpdateSystemPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      updates,
    }: {
      id: string;
      updates: Parameters<typeof api.updateSystemPreset>[1];
    }) => api.updateSystemPreset(id, updates),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.presetsSystem() }),
  });
}

/**
 * Hook to delete a system prompt preset.
 *
 * @returns A mutation object for deletion.
 */
export function useDeleteSystemPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.deleteSystemPreset,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.presetsSystem() }),
  });
}

// --- Settings ---

/**
 * Hook to retrieve full application settings.
 *
 * @returns A query object containing {@link AppSettings}.
 */
export function useSettings() {
  return useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.fetchSettings,
  });
}

/**
 * Hook to update application settings.
 *
 * @returns A mutation object for update.
 */
export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.updateSettings,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.settings() }),
  });
}

/**
 * Hook to trigger hardware optimisation logic (VRAM splitting calculation).
 *
 * @returns A mutation object for the optimisation call.
 */
export function useOptimizeHardware() {
  return useMutation({
    mutationFn: api.optimizeHardware,
  });
}
