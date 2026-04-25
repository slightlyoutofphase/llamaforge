import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { ChatSidebar } from "../../src/client/components/sidebar/ChatSidebar";
import { useAppStore } from "../../src/client/store";

// Mock the router hooks
mock.module("@tanstack/react-router", () => ({
  useParams: () => ({ chatId: "chat-1" }),
  useNavigate: () => mock(),
  Link: ({ children, to, onClick }: any) => (
    <a href={to} onClick={onClick}>
      {children}
    </a>
  ),
  useRouter: () => ({ buildLocation: () => ({}) }),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const queryClient = new QueryClient();

describe("ChatSidebar Component", () => {
  beforeEach(() => {
    mock.restore();
    useAppStore.setState({ unreadChatIds: [] });
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ unreadChatIds: [] });
  });

  it("renders a list of chats when available", () => {
    // Override queries
    mock.module("../../src/client/queries", () => ({
      useInfiniteChats: () => ({
        data: {
          pages: [
            [
              { id: "chat-1", name: "First Chat", createdAt: 1000 },
              { id: "chat-2", name: "Second Chat", createdAt: 2000 },
            ],
          ],
        },
        isLoading: false,
        fetchNextPage: mock(),
        hasNextPage: false,
        isFetchingNextPage: false,
      }),
      useCreateChat: () => ({ mutate: mock(), isPending: false }),
      useUpdateChat: () => ({ mutate: mock() }),
    }));

    render(
      <QueryClientProvider client={queryClient}>
        <ChatSidebar />
      </QueryClientProvider>,
    );

    expect(screen.getByText("First Chat")).toBeTruthy();
    expect(screen.getByText("Second Chat")).toBeTruthy();
    expect(screen.getByText("New Chat")).toBeTruthy();
  });

  it("shows a new badge for unread chats", () => {
    useAppStore.setState({ unreadChatIds: ["chat-2"] });
    mock.module("../../src/client/queries", () => ({
      useInfiniteChats: () => ({
        data: {
          pages: [
            [
              { id: "chat-1", name: "First Chat", createdAt: 1000 },
              { id: "chat-2", name: "Second Chat", createdAt: 2000 },
            ],
          ],
        },
        isLoading: false,
        fetchNextPage: mock(),
        hasNextPage: false,
        isFetchingNextPage: false,
      }),
      useCreateChat: () => ({ mutate: mock(), isPending: false }),
      useUpdateChat: () => ({ mutate: mock() }),
    }));

    render(
      <QueryClientProvider client={queryClient}>
        <ChatSidebar />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Second Chat")).toBeTruthy();
    expect(screen.getByText("New")).toBeTruthy();
  });

  it("clears unread chat state when a chat is selected", () => {
    useAppStore.setState({ unreadChatIds: ["chat-2"] });
    mock.module("../../src/client/queries", () => ({
      useInfiniteChats: () => ({
        data: {
          pages: [
            [
              { id: "chat-1", name: "First Chat", createdAt: 1000 },
              { id: "chat-2", name: "Second Chat", createdAt: 2000 },
            ],
          ],
        },
        isLoading: false,
        fetchNextPage: mock(),
        hasNextPage: false,
        isFetchingNextPage: false,
      }),
      useCreateChat: () => ({ mutate: mock(), isPending: false }),
      useUpdateChat: () => ({ mutate: mock() }),
    }));

    render(
      <QueryClientProvider client={queryClient}>
        <ChatSidebar />
      </QueryClientProvider>,
    );

    const secondChatLink = screen.getByText("Second Chat").closest("a");
    expect(secondChatLink).toBeTruthy();
    if (secondChatLink) fireEvent.click(secondChatLink);

    expect(useAppStore.getState().unreadChatIds).not.toContain("chat-2");
  });
});
