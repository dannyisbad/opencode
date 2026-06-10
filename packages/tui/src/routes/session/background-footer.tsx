import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useSDK } from "../../context/sdk"
import { useRouteData } from "../../context/route"
import { useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"
import { DialogBackgroundShell } from "../../component/dialog-background-shell"
import { useCommandShortcut, useOpencodeKeymap } from "../../keymap"
import type { BackgroundCommand } from "./background-data"
import {
  fetchSessionShellCommands,
  formatShellElapsed,
  killShellCommand,
  type ShellCommandInfo,
} from "./background-shell"

const POLL_MS = 2000

// Compact one-line strip for RUNNING background bash commands. A single
// command shows `● label · elapsed` with view/kill targets; multiple collapse
// to `N background commands running` (click → list dialog). Finished commands
// leave the strip (their ▣ completion row lands in scrollback). Part-derived
// entries are reconciled against the server's live registry while visible, so
// a command whose completion bubble never arrived (server restart, lost
// injection) still clears instead of sitting there forever.
export function BackgroundFooter(props: { commands: BackgroundCommand[]; runningForeground: boolean }) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const route = useRouteData("session")
  const dialog = useDialog()
  const toast = useToast()
  const keymap = useOpencodeKeymap()
  const backgroundShortcut = useCommandShortcut("session.background")
  const viewShortcut = useCommandShortcut("session.shell.view")
  const [hover, setHover] = createSignal<"row" | "view" | "kill" | "background" | null>(null)

  const partsRunning = createMemo(() => props.commands.filter((command) => command.status === "running"))

  const [server, setServer] = createSignal<ShellCommandInfo[] | undefined>(undefined)
  const [now, setNow] = createSignal(Date.now())
  createEffect(on(() => route.sessionID, () => setServer(undefined), { defer: true }))
  createEffect(() => {
    if (partsRunning().length === 0) return
    const sessionID = route.sessionID
    const tick = () => {
      setNow(Date.now())
      fetchSessionShellCommands(sdk, sessionID)
        .then((list) => {
          if (route.sessionID === sessionID) setServer(list)
        })
        .catch(() => {})
    }
    tick()
    const interval = setInterval(tick, POLL_MS)
    onCleanup(() => clearInterval(interval))
  })

  const running = createMemo(() => {
    const live = server()
    return partsRunning().flatMap((command) => {
      const remote = live?.find((item) => item.id === command.id)
      // Until the first poll lands, trust the parts; after that the server is
      // authoritative — unknown or settled entries drop from the strip.
      if (live && remote?.status !== "running") return []
      return [{ ...command, started_at: remote?.started_at }]
    })
  })
  const count = createMemo(() => running().length)
  const single = createMemo(() => (count() === 1 ? running()[0] : undefined))

  function openViewer() {
    dialog.replace(() => <DialogBackgroundShell sessionID={route.sessionID} id={single()?.id} />)
  }

  function kill() {
    const command = single()
    if (!command) return
    void killShellCommand(sdk, command.id)
      .then(() => {
        // Optimistic: drop it from the strip now; the next poll (and the
        // completion bubble) confirm.
        setServer((list) => list?.map((item) => (item.id === command.id ? { ...item, status: "killed" } : item)))
        toast.show({ message: `Killed ${command.label}`, variant: "info" })
      })
      .catch(toast.error)
  }

  const label = createMemo(() => {
    const one = single()
    if (one) return one.started_at ? `${one.label} · ${formatShellElapsed(one.started_at, now())}` : one.label
    return `${count()} background commands running`
  })

  return (
    <Show when={count() > 0 || props.runningForeground}>
      <box flexShrink={0} paddingLeft={2} paddingRight={1} paddingTop={1}>
        <box flexDirection="row" justifyContent="space-between" gap={2}>
          <Show when={count() > 0} fallback={<box />}>
            <box
              flexDirection="row"
              gap={1}
              flexShrink={1}
              onMouseOver={() => setHover("row")}
              onMouseOut={() => setHover(null)}
              onMouseUp={openViewer}
              backgroundColor={hover() === "row" ? theme.backgroundElement : undefined}
            >
              <text fg={theme.textMuted} wrapMode="none">
                ●
              </text>
              <text fg={theme.textMuted} wrapMode="none" truncate>
                {label()}
              </text>
            </box>
          </Show>
          <box flexDirection="row" gap={2} flexShrink={0}>
            <Show when={count() > 0 && viewShortcut()}>
              <box
                onMouseOver={() => setHover("view")}
                onMouseOut={() => setHover(null)}
                onMouseUp={() => keymap.dispatchCommand("session.shell.view")}
                backgroundColor={hover() === "view" ? theme.backgroundElement : undefined}
              >
                <text fg={theme.textMuted} wrapMode="none">
                  view <span style={{ fg: theme.textMuted }}>{viewShortcut()}</span>
                </text>
              </box>
            </Show>
            <Show when={single()}>
              <box
                onMouseOver={() => setHover("kill")}
                onMouseOut={() => setHover(null)}
                onMouseUp={kill}
                backgroundColor={hover() === "kill" ? theme.backgroundElement : undefined}
              >
                <text fg={hover() === "kill" ? theme.error : theme.textMuted} wrapMode="none">
                  ✕ kill
                </text>
              </box>
            </Show>
            <Show when={props.runningForeground && backgroundShortcut()}>
              <box
                onMouseOver={() => setHover("background")}
                onMouseOut={() => setHover(null)}
                onMouseUp={() => keymap.dispatchCommand("session.background")}
                backgroundColor={hover() === "background" ? theme.backgroundElement : undefined}
              >
                <text fg={theme.textMuted} wrapMode="none">
                  background <span style={{ fg: theme.textMuted }}>{backgroundShortcut()}</span>
                </text>
              </box>
            </Show>
          </box>
        </box>
      </box>
    </Show>
  )
}
