import { createMemo, createSignal, For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { SplitBorder } from "../../ui/border"
import { Spinner } from "../../component/spinner"
import { useCommandShortcut, useOpencodeKeymap } from "../../keymap"
import type { BackgroundCommand } from "./background-data"

const MAX_ROWS = 4

// Persistent strip for background bash commands — the opencode-native
// counterpart to subagent task tabs. Running commands spin; finished ones
// persist (✔/✖ + exit/elapsed, the same status idiom as dialog-workflow) for
// the life of the session instead of scrolling away as inline history rows.
export function BackgroundFooter(props: { commands: BackgroundCommand[]; runningForeground: boolean }) {
  const { theme } = useTheme()
  const keymap = useOpencodeKeymap()
  const backgroundShortcut = useCommandShortcut("session.background")
  const [hover, setHover] = createSignal(false)

  const visible = createMemo(() => props.commands.slice(0, MAX_ROWS))
  const overflow = createMemo(() => props.commands.length - visible().length)

  const detail = (command: BackgroundCommand) => {
    if (command.status === "running") return "running in background"
    const verb = command.status === "completed" ? "completed" : "failed"
    const exit = command.exit !== undefined ? ` · exit ${command.exit}` : ""
    const elapsed = command.elapsed ? ` · ${command.elapsed}` : ""
    return `${verb}${exit}${elapsed}`
  }

  return (
    <box flexShrink={0}>
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        {...SplitBorder}
        border={["left"]}
        borderColor={theme.border}
        flexShrink={0}
        backgroundColor={theme.backgroundPanel}
      >
        <box flexDirection="row" justifyContent="space-between" gap={1}>
          <text fg={theme.text}>
            <b>Background commands</b>
          </text>
          <Show when={props.runningForeground && backgroundShortcut()}>
            <box
              onMouseOver={() => setHover(true)}
              onMouseOut={() => setHover(false)}
              onMouseUp={() => keymap.dispatchCommand("session.background")}
              backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text fg={theme.text} wrapMode="none">
                Background <span style={{ fg: theme.textMuted }}>{backgroundShortcut()}</span>
              </text>
            </box>
          </Show>
        </box>
        <For each={visible()}>
          {(command) => (
            <box flexDirection="row" gap={1} marginTop={command === visible()[0] ? 1 : 0}>
              <Show
                when={command.status === "running"}
                fallback={
                  <text fg={command.status === "error" ? theme.error : theme.success} wrapMode="none">
                    {command.status === "error" ? "✖" : "✔"}
                  </text>
                }
              >
                <Spinner color={theme.textMuted} />
              </Show>
              <text fg={theme.text} wrapMode="none" truncate>
                {command.label}
                <span style={{ fg: theme.textMuted }}> · {detail(command)}</span>
              </text>
            </box>
          )}
        </For>
        <Show when={overflow() > 0}>
          <text fg={theme.textMuted}>+{overflow()} more</text>
        </Show>
      </box>
    </box>
  )
}
