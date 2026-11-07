/**
 * @packageDocumentation
 * Tests for sidebar component behavior and navigation.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatSidebar } from "../../src/client/components/sidebar/ChatSidebar";
import { useAppStore } from "../../src/client/store";

let sidebarLinkFallbackClick: ((event: unknown) => void) | undefined;

/**
 * Router link stand-in for the sidebar tests.
 *
 * @param children - Link contents.
 * @param to - Destination href.
 * @param onClick - Click handler from the row, when the row provides one.
 * @returns An anchor with the same click behavior the tests assert.
 */
function SidebarLink({
  children,
  to,
  onClick,
}: {
  children?: any;
  to?: string;
  onClick?: (event: unknown) => void;
}) {
  return (
    <a href={to} onClick={onClick ?? sidebarLinkFallbackClick}>
      {children}
    </a>
  );
}

// Mock the router hooks
mock.module("@tanstack/react-router", () => ({
  useParams: () => ({ chatId: "chat-1" }),
  useNavigate: () => mock(),
  Link: SidebarLink,
  useRouter: () => ({ buildLocation: () => ({}) }),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const queryClient = new QueryClient();

describe("ChatSidebar Component", () => {
  beforeEach(() => {
    mock.restore();
    sidebarLinkFallbackClick = undefined;
    mock.module("@tanstack/react-router", () => ({
      useParams: () => ({ chatId: "chat-1" }),
      useNavigate: () => mock(),
      Link: SidebarLink,
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
    sidebarLinkFallbackClick = linkClickSpy;
    mock.module("@tanstack/react-router", () => ({
      useParams: () => ({ chatId: "chat-1" }),
      useNavigate: () => mock(),
      Link: SidebarLink,
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
    if (!renameInput) {
      throw new Error("expected a rename input");
    }
    fireEvent.click(renameInput);
    expect(linkClickSpy).not.toHaveBeenCalled();
  });

  it("shows a notification and stays in edit mode when rename fails", async () => {
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
      useCreateChat: () => ({ mutate: mock(), mutateAsync: mock(), isPending: false }),
      useDeleteChat: () => ({ mutate: mock(), mutateAsync: mock(), isPending: false }),
      useUpdateChat: () => ({
        mutate: mock(),
        mutateAsync: mock().mockRejectedValue(new Error("rename failed")),
        isPending: false,
      }),
    }));
    useAppStore.setState({ notifications: [], unreadChatIds: [] });

    render(
      <QueryClientProvider client={queryClient}>
        <ChatSidebar />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTitle("Rename"));
    const renameInput = screen.getAllByRole("textbox").at(-1);
    if (!renameInput) throw new Error("expected a rename input");
    fireEvent.change(renameInput, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rename" }));
    await waitFor(() => {
      expect(
        useAppStore.getState().notifications.some((note) => note.message.includes("rename failed")),
      ).toBe(true);
    });
    expect(screen.getByDisplayValue("Renamed")).toBeTruthy();
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

  it("keeps the search box mounted while the chat list is loading", () => {
    mock.module("../../src/client/queries", () => ({
      useInfiniteChats: () => ({
        data: undefined,
        isLoading: true,
        fetchNextPage: mock(),
        hasNextPage: false,
        isFetchingNextPage: false,
      }),
      useCreateChat: () => ({ mutate: mock(), mutateAsync: mock(), isPending: false }),
      useDeleteChat: () => ({ mutateAsync: mock(), isPending: false }),
      useUpdateChat: () => ({ mutate: mock(), mutateAsync: mock() }),
    }));

    render(
      <QueryClientProvider client={queryClient}>
        <ChatSidebar />
      </QueryClientProvider>,
    );

    const search = screen.getByPlaceholderText("Search activity...");
    search.focus();
    fireEvent.change(search, { target: { value: "a" } });
    expect(document.activeElement).toBe(screen.getByPlaceholderText("Search activity..."));
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
    expect(chatLinksBefore[0]?.textContent).toContain("Beta Chat");
    expect(chatLinksBefore[1]?.textContent).toContain("Alpha Chat");

    fireEvent.change(sortSelect, { target: { value: "name" } });

    const chatLinksAfter = screen.getAllByRole("link");
    expect(chatLinksAfter[0]?.textContent).toContain("Alpha Chat");
    expect(chatLinksAfter[1]?.textContent).toContain("Beta Chat");
  });

  it("creates only one chat on rapid New Chat clicks", async () => {
    const createMutateAsync = mock(async () => ({ id: "new-chat", name: "New Chat" }));
    const navigateSpy = mock();

    mock.module("@tanstack/react-router", () => ({
      useParams: () => ({ chatId: "chat-1" }),
      useNavigate: () => navigateSpy,
      Link: SidebarLink,
      useRouter: () => ({ buildLocation: () => ({}) }),
    }));

    mock.module("../../src/client/queries", () => ({
      useInfiniteChats: () => ({
        data: { pages: [[]] },
        isLoading: false,
        fetchNextPage: mock(),
        hasNextPage: false,
        isFetchingNextPage: false,
      }),
      useCreateChat: () => ({ mutateAsync: createMutateAsync, isPending: false }),
      useDeleteChat: () => ({ mutateAsync: mock(async () => undefined), isPending: false }),
      useUpdateChat: () => ({ mutateAsync: mock(async () => undefined) }),
    }));

    render(
      <QueryClientProvider client={queryClient}>
        <ChatSidebar />
      </QueryClientProvider>,
    );

    const newChatButton = screen.getByRole("button", { name: /new chat/i });
    fireEvent.click(newChatButton);
    fireEvent.click(newChatButton);

    await waitFor(() => {
      expect(createMutateAsync).toHaveBeenCalledTimes(1);
      expect(navigateSpy).toHaveBeenCalledWith({
        to: "/chat/$chatId",
        params: { chatId: "new-chat" },
      });
    });
  });

  it("deletes only the targeted chat once on rapid delete clicks", async () => {
    const deleteMutateAsync = mock(async () => undefined);
    const navigateSpy = mock();
    const unloadChatSpy = mock();
    useAppStore.setState({ currentChatId: "chat-1", unloadChat: unloadChatSpy });
    globalThis.confirm = mock(() => true) as typeof globalThis.confirm;

    mock.module("@tanstack/react-router", () => ({
      useParams: () => ({ chatId: "chat-1" }),
      useNavigate: () => navigateSpy,
      Link: SidebarLink,
      useRouter: () => ({ buildLocation: () => ({}) }),
    }));

    mock.module("../../src/client/queries", () => ({
      useInfiniteChats: () => ({
        data: {
          pages: [
            [
              { id: "chat-1", name: "First Chat", createdAt: 3000, updatedAt: 3000 },
              { id: "chat-2", name: "Second Chat", createdAt: 2000, updatedAt: 4000 },
            ],
          ],
        },
        isLoading: false,
        fetchNextPage: mock(),
        hasNextPage: false,
        isFetchingNextPage: false,
      }),
      useCreateChat: () => ({ mutateAsync: mock(async () => undefined), isPending: false }),
      useDeleteChat: () => ({ mutateAsync: deleteMutateAsync, isPending: false }),
      useUpdateChat: () => ({ mutateAsync: mock(async () => undefined) }),
    }));

    render(
      <QueryClientProvider client={queryClient}>
        <ChatSidebar />
      </QueryClientProvider>,
    );

    const deleteButtons = screen.getAllByTitle("Delete");
    const deleteButton = deleteButtons[0];
    expect(deleteButton).toBeDefined();
    if (!deleteButton) {
      throw new Error("expected a delete button");
    }
    fireEvent.click(deleteButton);
    fireEvent.click(deleteButton);

    await waitFor(() => {
      expect(deleteMutateAsync).toHaveBeenCalledTimes(1);
      expect(deleteMutateAsync).toHaveBeenCalledWith("chat-2");
      expect(unloadChatSpy).toHaveBeenCalledTimes(0);
      expect(navigateSpy).not.toHaveBeenCalled();
    });
  });

  it("does not allow deleting the chat that is currently open", () => {
    const deleteMutateAsync = mock(async () => undefined);
    globalThis.confirm = mock(() => true) as typeof globalThis.confirm;

    mock.module("../../src/client/queries", () => ({
      useInfiniteChats: () => ({
        data: {
          pages: [
            [
              { id: "chat-1", name: "First Chat", createdAt: 3000, updatedAt: 3000 },
              { id: "chat-2", name: "Second Chat", createdAt: 2000, updatedAt: 4000 },
            ],
          ],
        },
        isLoading: false,
        fetchNextPage: mock(),
        hasNextPage: false,
        isFetchingNextPage: false,
      }),
      useCreateChat: () => ({ mutateAsync: mock(async () => undefined), isPending: false }),
      useDeleteChat: () => ({ mutateAsync: deleteMutateAsync, isPending: false }),
      useUpdateChat: () => ({ mutateAsync: mock(async () => undefined) }),
    }));

    render(
      <QueryClientProvider client={queryClient}>
        <ChatSidebar />
      </QueryClientProvider>,
    );

    const openChatDelete = screen.getByTitle("Cannot delete the open chat");
    expect((openChatDelete as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(openChatDelete);
    expect(deleteMutateAsync).not.toHaveBeenCalled();
    expect(globalThis.confirm).not.toHaveBeenCalled();
  });

  it("keeps default date sorting ordered by creation time instead of recent updates", () => {
    mock.module("../../src/client/queries", () => ({
      useInfiniteChats: () => ({
        data: {
          pages: [
            [
              {
                id: "chat-1",
                name: "Older but recently active",
                createdAt: 1000,
                updatedAt: 9000,
              },
              { id: "chat-2", name: "Newer Chat", createdAt: 2000, updatedAt: 2000 },
            ],
          ],
        },
        isLoading: false,
        fetchNextPage: mock(),
        hasNextPage: false,
        isFetchingNextPage: false,
      }),
      useCreateChat: () => ({ mutateAsync: mock(async () => undefined), isPending: false }),
      useDeleteChat: () => ({ mutateAsync: mock(async () => undefined), isPending: false }),
      useUpdateChat: () => ({ mutateAsync: mock(async () => undefined) }),
    }));

    render(
      <QueryClientProvider client={queryClient}>
        <ChatSidebar />
      </QueryClientProvider>,
    );

    const chatLinks = screen.getAllByRole("link");
    expect(chatLinks[0]?.textContent).toContain("Newer Chat");
    expect(chatLinks[1]?.textContent).toContain("Older but recently active");
  });

  it("renders branch history indicator for branch chats", () => {
    mock.module("../../src/client/queries", () => ({
      useInfiniteChats: () => ({
        data: {
          pages: [
            [
              { id: "chat-1", name: "Main Chat", createdAt: 1000 },
              {
                id: "chat-2",
                name: "Branch Chat",
                createdAt: 2000,
                isBranch: true,
                parentId: "chat-1",
              },
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

    expect(screen.getAllByText("Main Chat").length).toBeGreaterThan(0);
    expect(screen.getByText("🌿 Branch Chat")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Open parent chat: Main Chat/i })).toBeTruthy();
  });

  it("navigates to the parent chat from a branch row action", () => {
    const navigateSpy = mock();
    mock.module("@tanstack/react-router", () => ({
      useParams: () => ({ chatId: "chat-2" }),
      useNavigate: () => navigateSpy,
      Link: SidebarLink,
      useRouter: () => ({ buildLocation: () => ({}) }),
    }));

    mock.module("../../src/client/queries", () => ({
      useInfiniteChats: () => ({
        data: {
          pages: [
            [
              { id: "chat-1", name: "Main Chat", createdAt: 1000 },
              {
                id: "chat-2",
                name: "Branch Chat",
                createdAt: 2000,
                isBranch: true,
                parentId: "chat-1",
              },
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

    fireEvent.click(screen.getByRole("button", { name: /Open parent chat: Main Chat/i }));

    expect(navigateSpy).toHaveBeenCalledWith({
      to: "/chat/$chatId",
      params: { chatId: "chat-1" },
    });
  });
});
