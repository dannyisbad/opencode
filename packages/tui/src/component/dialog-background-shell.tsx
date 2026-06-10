import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useSDK } from "../context/sdk"
import { selectedForeground, useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useBindings } from "../keymap"
import { getScrollAcceleration } from "../util/scroll"
import { Spinner } from "./spinner"
import {
  fetchSessionShellCommands,
  fetchShellCommandOutput,
  formatShellElapsed,
  killShellCommand,
  type ShellCommandInfo,
  type ShellCommandStatus,
} from "../routes/session/background-shell"

function statusIcon(status: ShellCommandStatus) {
  if (status === "running") return "●"
  if (status === "completed") return "✔"
  return "✖"
}

function statusLabel(info: { status: ShellCommandStatus; exit: number | null }) {
  const exit = info.exit !== null ? ` · exit ${info.exit}` : ""
  return `${info.status}${exit}`
}

// Live viewer for the bash tool's background commands: a Claude Code-style
// shell view. Opens straight into the output tail when an id is given (strip
// row click / single running command), otherwise shows the session's command
// list first. The tail polls the server's capture window and follows the
// bottom via stickyScroll.
export function DialogBackgroundShell(props: { sessionID: string; id?: string }) {
  const [selected, setSelected] = createSignal<string | undefined>(props.id)
  return (
    <Show when={selected()} fallback={<ShellList sessionID={props.sessionID} onOpen={setSelected} />} keyed>
      {(id) => <ShellTail id={id} canGoBack={props.id === undefined} onBack={() => setSelected(undefined)} />}
    </Show>
  )
}

function ShellList(props: { sessionID: string; onOpen: (id: string) => void }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  dialog.setSize("fullscreen")

  const [index, setIndex] = createSignal(0)
  let scroll: ScrollBoxRenderable | undefined

  const [data, { refetch }] = createResource(async () => {
    const list = await fetchSessionShellCommands(sdk, props.sessionID)
    return list.toSorted((a, b) => {
      const aRunning = a.status === "running" ? 1 : 0
      const bRunning = b.status === "running" ? 1 : 0
      if (aRunning !== bRunning) return bRunning - aRunning
      return b.started_at - a.started_at
    })
  })
  const commands = createMemo(() => data() ?? [])
  const current = createMemo(() => commands()[Math.min(index(), Math.max(0, commands().length - 1))])

  onMount(() => {
    const interval = setInterval(() => void refetch(), 1000)
    onCleanup(() => clearInterval(interval))
  })

  function move(direction: number) {
    if (commands().length === 0) return
    const next = Math.max(0, Math.min(commands().length - 1, index() + direction))
    setIndex(next)
    if (!scroll) return
    if (next < scroll.scrollTop) scroll.scrollBy(next - scroll.scrollTop)
    if (next >= scroll.scrollTop + scroll.height) scroll.scrollBy(next - scroll.scrollTop - scroll.height + 1)
  }

  function killCurrent() {
    const command = current()
    if (!command || command.status !== "running") return
    void killShellCommand(sdk, command.id)
      .then(() => {
        toast.show({ message: `Killed ${command.description}`, variant: "info" })
        void refetch()
      })
      .catch(toast.error)
  }

  useBindings(() => ({
    bindings: [
      { key: "up,k", desc: "Previous command", group: "Background shell", cmd: () => move(-1) },
      { key: "down,j", desc: "Next command", group: "Background shell", cmd: () => move(1) },
      {
        key: "return",
        desc: "View output",
        group: "Background shell",
        cmd: () => {
          const command = current()
          if (command) props.onOpen(command.id)
        },
      },
      { key: "x", desc: "Kill command", group: "Background shell", cmd: killCurrent },
    ],
  }))

  return (
    <box flexDirection="column" height={dimensions().height - 1} paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Background commands
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <scrollbox
        ref={(element: ScrollBoxRenderable) => (scroll = element)}
        flexGrow={1}
        minHeight={0}
        verticalScrollbarOptions={{ visible: true }}
        horizontalScrollbarOptions={{ visible: false }}
        scrollAcceleration={getScrollAcceleration()}
      >
        <For
          each={commands()}
          fallback={
            <text fg={theme.textMuted}>No background commands in this session yet.</text>
          }
        >
          {(command, itemIndex) => {
            const active = createMemo(() => itemIndex() === index())
            return (
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={active() ? theme.primary : undefined}
                onMouseDown={() => setIndex(itemIndex())}
                onMouseUp={() => props.onOpen(command.id)}
              >
                <text fg={active() ? selectedForeground(theme) : theme.text} wrapMode="none" overflow="hidden">
                  {statusIcon(command.status)} {command.description}
                  <span style={{ fg: active() ? selectedForeground(theme) : theme.textMuted }}>
                    {"  "}
                    {statusLabel(command)} · {formatShellElapsed(command.started_at, command.completed_at)}
                  </span>
                </text>
              </box>
            )
          }}
        </For>
      </scrollbox>
      <text fg={theme.textMuted}>[Enter] View output | [X] Kill | [Esc] Close</text>
    </box>
  )
}

function ShellTail(props: { id: string; canGoBack: boolean; onBack: () => void }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  dialog.setSize("fullscreen")

  const [data, { refetch }] = createResource(() =>
    fetchShellCommandOutput(sdk, props.id).catch(() => undefined),
  )
  const info = createMemo((): ShellCommandInfo | undefined => data())
  const text = createMemo(() => data()?.text ?? "")

  onMount(() => {
    // Keep polling while running; one final fetch after settle picks up the
    // closing output, then the interval keeps no-oping cheaply until close.
    const interval = setInterval(() => {
      if (data() && data()!.status !== "running") return
      void refetch()
    }, 700)
    onCleanup(() => clearInterval(interval))
  })

  function kill() {
    const current = info()
    if (!current || current.status !== "running") return
    void killShellCommand(sdk, current.id)
      .then(() => {
        toast.show({ message: `Killed ${current.description}`, variant: "info" })
        void refetch()
      })
      .catch(toast.error)
  }

  function back() {
    if (props.canGoBack) props.onBack()
    else dialog.clear()
  }

  useBindings(() => ({
    bindings: [
      { key: "x", desc: "Kill command", group: "Background shell", cmd: kill },
      { key: "b", desc: "Back", group: "Background shell", cmd: back },
    ],
  }))

  return (
    <box flexDirection="column" height={dimensions().height - 1} paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between" gap={2}>
        <box flexDirection="row" gap={1} flexShrink={1}>
          <Show
            when={info()?.status === "running"}
            fallback={
              <text fg={info()?.status === "completed" ? theme.success : theme.error} wrapMode="none">
                {statusIcon(info()?.status ?? "error")}
              </text>
            }
          >
            <Spinner color={theme.textMuted} />
          </Show>
          <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none" truncate>
            {info()?.description ?? props.id}
          </text>
        </box>
        <text fg={theme.textMuted} wrapMode="none">
          {(() => {
            const item = info()
            if (!item) return "esc"
            return `${statusLabel(item)} · ${formatShellElapsed(item.started_at, item.completed_at)}  esc`
          })()}
        </text>
      </box>
      <Show when={info()?.command}>
        <text fg={theme.textMuted} wrapMode="none" overflow="hidden">
          $ {info()?.command}
        </text>
      </Show>
      <scrollbox
        flexGrow={1}
        minHeight={0}
        stickyScroll={true}
        stickyStart="bottom"
        verticalScrollbarOptions={{ visible: true }}
        horizontalScrollbarOptions={{ visible: false }}
        scrollAcceleration={getScrollAcceleration()}
      >
        <text fg={theme.text}>{text() || "(no output yet)"}</text>
      </scrollbox>
      <text fg={theme.textMuted}>
        {info()?.status === "running" ? "[X] Kill | " : ""}
        {props.canGoBack ? "[B] Back | " : ""}[Esc] Close
      </text>
    </box>
  )
}
