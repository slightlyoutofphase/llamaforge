import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { render, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let queryClient: QueryClient;
let fetchChats: ReturnType<typeof mock>;
let createChat: ReturnType<typeof mock>;
let useInfiniteChats: any;
let useCreateChat: any;

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

  const queries = await import("../../src/client/queries");
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

    function TestComponent() {
      const { data, isLoading } = useInfiniteChats("");
      return <div>{isLoading ? "loading" : data?.pages?.[0]?.[0]?.name}</div>;
    }

    render(
      <QueryClientProvider client={queryClient}>
        <TestComponent />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(fetchChats).toHaveBeenCalledWith(undefined, 150, 0));
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

    let mutateAsync: ((variables: unknown) => Promise<unknown>) | null = null;

    function TestComponent() {
      const { mutateAsync: mutate } = useCreateChat();
      mutateAsync = mutate;
      return null;
    }

    render(
      <QueryClientProvider client={queryClient}>
        <TestComponent />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(typeof mutateAsync).toBe("function"));
    if (mutateAsync) {
      await mutateAsync({ name: "Test Chat" });
    }

    expect(createChat).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Test Chat" }),
      expect.anything(),
    );
    expect(invalidateQueries).toHaveBeenCalled();
    expect(invalidateQueries.mock.calls[0][0]).toEqual({ queryKey: ["chats"] });
  });
});
