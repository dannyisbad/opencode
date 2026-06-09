import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { Show } from "solid-js"
import { useSync } from "../../context/sync"
import path from "path"

const id = "internal:sidebar-editor"

function View(props: { api: TuiPluginApi }) {
  const sync = useSync()
  const theme = () => props.api.theme.current

  return (
    <Show when={sync.data.ide_context.uri}>
      {(uri) => (
        <box flexDirection="column" gap={0}>
          <text fg={theme().text}>
            <b>Editor</b>
          </text>
          <text fg={theme().textMuted}>{path.basename(uri())}</text>
          <Show when={sync.data.ide_context.selection}>
            {(sel) => (
              <text fg={theme().textMuted}>
                Lines {sel().start.line + 1}-{sel().end.line + 1} selected
              </text>
            )}
          </Show>
        </box>
      )}
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 350,
    slots: {
      sidebar_content() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
