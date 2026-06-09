import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { createMemo, createSignal, onMount } from "solid-js"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"

export type DialogSkillProps = {
  onSelect: (skill: string) => void
}

export function DialogSkill(props: DialogSkillProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const { theme } = useTheme()
  const toast = useToast()
  dialog.setSize("large")

  const [skills, setSkills] = createSignal<any[]>([])

  const fetchSkills = async () => {
    const result = await sdk.client.app.skills()
    setSkills(result.data ?? [])
  }

  onMount(() => {
    fetchSkills()
  })

  const toggleSkill = async (name: string) => {
    await sdk.client.skill.toggle({ name })
    const result = await sdk.client.app.skills()
    setSkills(result.data ?? [])
    const skill = result.data?.find((s) => s.name === name)
  }

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const list = skills() ?? []
    const maxWidth = Math.max(0, ...list.map((s) => s.name.length))
    return list.map((skill) => {
      const enabled = !skill.disabled
      return {
        title: skill.name.padEnd(maxWidth),
        description: skill.description?.replace(/\s+/g, " ").trim(),
        value: skill.name,
        category: "Skills",
        gutter: () => (
          <text fg={enabled ? theme.success : theme.textMuted}>✓</text>
        ),
        onSelect: () => {
          if (!enabled) return
          props.onSelect(skill.name)
          dialog.clear()
        },
      }
    })
  })

  return (
    <DialogSelect
      title="Skills"
      placeholder="Search skills..."
      options={options()}
      actions={[
        {
          command: "dialog.skill.toggle",
          title: "Toggle skill",
          side: "left",
          onTrigger: (option) => {
            toggleSkill(option.value)
          },
        },
      ]}
    />
  )
}
