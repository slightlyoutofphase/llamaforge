/**
 * @packageDocumentation
 * Tests for query hooks and server data handling in the client.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ChatSession } from "../../src/shared/types";

let queryClient: QueryClient;
let fetchChats: ReturnType<typeof mock>;
let createChat: ReturnType<typeof mock>;
let useInfiniteChats: any;
let useCreateChat: any;
const capturedCreate = {
  mutate: undefined as ((variables: Partial<ChatSession>) => Promise<unknown>) | undefined,
};

/**
 * Renders the infinite chat list for an empty search string.
 *
 * @returns The loading text or the first chat name.
 */
function ChatListProbe() {
  const { data, isLoading } = useInfiniteChats("");
  return <div>{isLoading ? "loading" : data?.pages?.[0]?.[0]?.name}</div>;
}

/**
 * Captures `useCreateChat().mutateAsync` for the cache-invalidation test.
 *
 * @returns Nothing visible.
 */
function CreateChatProbe() {
  const { mutateAsync } = useCreateChat();
  capturedCreate.mutate = mutateAsync;
  return null;
}

/**
 * Reads the mutate function captured by {@link CreateChatProbe}.
 *
 * @returns The captured mutate function.
 */
function requireCapturedCreateMutate(): (variables: Partial<ChatSession>) => Promise<unknown> {
  const mutate = capturedCreate.mutate;
  if (typeof mutate !== "function") {
    throw new Error("useCreateChat did not expose mutateAsync");
  }
  return mutate;
}

beforeEach(async () => {
  mock.restore();

  queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  fetchChats = mock(async () => []);
  createChat = mock(async (data: any) => ({
    id: "chat-2",
    name: data?.name ?? "New Chat",
    createdAt: Date.now(),
  }));

  await mock.module("../../src/client/api", () => ({
    fetchChats,
    createChat,
  }));

  const queries = await import(`../../src/client/queries.ts?cachebust=${Date.now()}`);
  useInfiniteChats = queries.useInfiniteChats;
  useCreateChat = queries.useCreateChat;
});

afterEach(() => {
  cleanup();
  mock.restore();
});

describe("Chat query hooks", () => {
  it("normalizes empty search to undefined when fetching chat list", async () => {
    fetchChats.mockResolvedValue([{ id: "chat-1", name: "First Chat", createdAt: 1000 }]);

    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <ChatListProbe />
        </QueryClientProvider>,
      );
    });

    await waitFor(() => expect(fetchChats).toHaveBeenCalledWith(undefined, 300, 0));
    await waitFor(() =>
      expect(queryClient.getQueryData(["chats", { q: undefined }])).toBeDefined(),
    );
  });

  it("invalidates the global chat list cache after creating a new chat", async () => {
    createChat.mockResolvedValue({
      id: "chat-2",
      name: "Test Chat",
      createdAt: Date.now(),
    });

    const originalInvalidate = queryClient.invalidateQueries.bind(queryClient);
    const invalidateQueries = mock((...args: any[]) => originalInvalidate(...args));
    queryClient.invalidateQueries = invalidateQueries as any;

    capturedCreate.mutate = undefined;

    await act(async () => {
      render(
        <QueryClientProvider client={queryClient}>
          <CreateChatProbe />
        </QueryClientProvider>,
      );
    });

    await waitFor(() => expect(typeof capturedCreate.mutate).toBe("function"));
    const createChatMutate = requireCapturedCreateMutate();
    await act(async () => {
      await createChatMutate({ name: "Test Chat" });
    });

    expect(createChat).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Test Chat" }),
      expect.anything(),
    );
    expect(invalidateQueries).toHaveBeenCalled();
    expect(invalidateQueries.mock.calls[0]?.[0]).toEqual({ queryKey: ["chats"] });
  });
});
