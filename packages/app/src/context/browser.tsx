import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { persisted } from "@/utils/persist"

export interface Bookmark {
  id: string
  title: string
  url: string
}

export interface BrowserTab {
  id: string
  url: string
  title: string
}

export const { use: useBrowser, provider: BrowserProvider } = createSimpleContext({
  name: "Browser",
  init: () => {
    const [store, setStore] = createStore({
      tabs: [] as BrowserTab[],
      activeTabId: null as string | null,
    })

    const [bookmarks, setBookmarks] = persisted<Bookmark[]>(
      "browser.bookmarks",
      createStore([] as Bookmark[])
    )

    const [isOpenState, setIsOpenState] = persisted<{ value: boolean }>(
      "browser.isOpen",
      createStore({ value: false as boolean })
    )

    const openBrowser = (url: string = "https://google.com") => {
      if (store.tabs.length === 0) {
        const id = Math.random().toString(36).substring(7)
        setStore("tabs", [{ id, url, title: "New Tab" }])
        setStore("activeTabId", id)
      } else if (url !== "https://google.com") {
        setStore("tabs", 0, "url", url)
      }
      setIsOpenState("value", true)
    }

    const toggleBrowser = () => {
      if (isOpenState.value) {
        setIsOpenState("value", false)
      } else {
        openBrowser()
      }
    }

    const closeBrowser = () => {
      setIsOpenState("value", false)
    }

    const addBookmark = (title: string, url: string) => {
      const id = Math.random().toString(36).substring(7)
      setBookmarks((prev) => [...prev, { id, title, url }])
    }

    const removeBookmark = (id: string) => {
      setBookmarks((prev) => prev.filter((b) => b.id !== id))
    }

    const navigateTo = (id: string, url: string) => {
      setStore("tabs", (t) => t.id === id, "url", url)
    }

    const updateTitle = (id: string, title: string) => {
      setStore("tabs", (t) => t.id === id, "title", title)
    }

    return {
      store: {
        get tabs() { return store.tabs },
        get activeTabId() { return store.activeTabId },
        get bookmarks() { return bookmarks },
        get isOpen() { return isOpenState.value },
      },
      openBrowser,
      toggleBrowser,
      closeBrowser,
      addBookmark,
      removeBookmark,
      navigateTo,
      updateTitle,
    }
  },
})
