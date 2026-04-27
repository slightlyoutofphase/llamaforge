/**
 * @packageDocumentation
 * Tests for sidebar component behavior and navigation.
 */

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

  it("disables the New Chat button while a creation request is pending", () => {
    const mutateSpy = mock();
    mock.module("../../src/client/queries", () => ({
      useInfiniteChats: () => ({
        data: {
          pages: [[{ id: "chat-1", name: "First Chat", createdAt: 1000 }]],
        },
        isLoading: false,
        fetchNextPage: mock(),
        hasNextPage: false,
        isFetchingNextPage: false,
      }),
      useCreateChat: () => ({ mutate: mutateSpy, isPending: true }),
      useUpdateChat: () => ({ mutate: mock() }),
    }));

    render(
      <QueryClientProvider client={queryClient}>
        <ChatSidebar />
      </QueryClientProvider>,
    );

    const newChatButton = screen.getByRole("button", { name: /new chat/i });
    expect(newChatButton).toBeTruthy();
    expect((newChatButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(newChatButton);
    expect(mutateSpy).not.toHaveBeenCalled();
  });

  it("does not trigger navigation when renaming a chat row", () => {
    const linkClickSpy = mock();
    mock.module("@tanstack/react-router", () => ({
      useParams: () => ({ chatId: "chat-1" }),
      useNavigate: () => mock(),
      Link: ({ children, to, onClick }: any) => (
        <a href={to} onClick={onClick ?? linkClickSpy}>
          {children}
        </a>
      ),
      useRouter: () => ({ buildLocation: () => ({}) }),
    }));

    mock.module("../../src/client/queries", () => ({
      useInfiniteChats: () => ({
        data: {
          pages: [[{ id: "chat-1", name: "First Chat", createdAt: 1000 }]],
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

    const renameButton = screen.getByTitle("Rename");
    fireEvent.click(renameButton);
    expect(linkClickSpy).not.toHaveBeenCalled();
    const renameInputs = screen.getAllByRole("textbox");
    const renameInput = renameInputs[renameInputs.length - 1];
    expect(renameInput).toBeTruthy();
    fireEvent.click(renameInput);
    expect(linkClickSpy).not.toHaveBeenCalled();
  });

  it("shows empty sidebar state when there are no chats", () => {
    mock.module("../../src/client/queries", () => ({
      useInfiniteChats: () => ({
        data: { pages: [] },
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

    expect(screen.getByText("Your transmission log is empty.")).toBeTruthy();
  });

  it("filters chat history by search query", () => {
    mock.module("../../src/client/queries", () => ({
      useInfiniteChats: () => ({
        data: {
          pages: [
            [
              { id: "chat-1", name: "General Chat", createdAt: 1000 },
              { id: "chat-2", name: "Shopping List", createdAt: 2000 },
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

    fireEvent.change(screen.getByPlaceholderText("Search activity..."), {
      target: { value: "shop" },
    });

    expect(screen.queryByText("General Chat")).toBeNull();
    expect(screen.getByText("Shopping List")).toBeTruthy();
  });

  it("renders sort control and export current chat button", () => {
    useAppStore.setState({ currentChatId: "chat-1" });
    mock.module("../../src/client/queries", () => ({
      useInfiniteChats: () => ({
        data: {
          pages: [[{ id: "chat-1", name: "Current Chat", createdAt: 1000 }]],
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

    expect(screen.getByLabelText("Sort chats")).toBeTruthy();
    const exportButton = screen.getByRole("button", { name: /Export Chat/i });
    expect(exportButton).toBeTruthy();
    expect((exportButton as HTMLButtonElement).disabled).toBe(false);
  });

  it("sorts chats by name when the sort order changes", () => {
    mock.module("../../src/client/queries", () => ({
      useInfiniteChats: () => ({
        data: {
          pages: [
            [
              { id: "chat-1", name: "Alpha Chat", createdAt: 1000 },
              { id: "chat-2", name: "Beta Chat", createdAt: 2000 },
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

    const sortSelect = screen.getByLabelText("Sort chats") as HTMLSelectElement;
    expect(sortSelect.value).toBe("date");

    const chatLinksBefore = screen.getAllByRole("link");
    expect(chatLinksBefore[0].textContent).toContain("Beta Chat");
    expect(chatLinksBefore[1].textContent).toContain("Alpha Chat");

    fireEvent.change(sortSelect, { target: { value: "name" } });

    const chatLinksAfter = screen.getAllByRole("link");
    expect(chatLinksAfter[0].textContent).toContain("Alpha Chat");
    expect(chatLinksAfter[1].textContent).toContain("Beta Chat");
  });

  it("renders branch history indicator for branch chats", () => {
    mock.module("../../src/client/queries", () => ({
      useInfiniteChats: () => ({
        data: {
          pages: [
            [
              { id: "chat-1", name: "Main Chat", createdAt: 1000 },
              { id: "chat-2", name: "Branch Chat", createdAt: 2000, isBranch: true },
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

    expect(screen.getByText("Main Chat")).toBeTruthy();
    expect(screen.getByText("🌿 Branch Chat")).toBeTruthy();
  });
});
