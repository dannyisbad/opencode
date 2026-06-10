// Raw-fetch client for the experimental background-shell observation routes
// (list / output / kill). These are typed HttpApi endpoints server-side but are
// called raw here (same pattern as /workflow/generate in prompt/index.tsx) so
// the generated SDK doesn't need a regen to pick them up.

export type ShellCommandStatus = "running" | "completed" | "error" | "killed"

export type ShellCommandInfo = {
  id: string
  description: string
  command: string
  status: ShellCommandStatus
  exit: number | null
  started_at: number
  completed_at?: number
}

export type ShellCommandOutput = ShellCommandInfo & { text: string }

type SDKLike = { fetch: typeof fetch; url: string; directory?: string }

function withDirectory(path: string, sdk: SDKLike) {
  return new URL(`${path}?directory=${encodeURIComponent(sdk.directory ?? "")}`, sdk.url)
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await res.text())
  return (await res.json()) as T
}

export function fetchSessionShellCommands(sdk: SDKLike, sessionID: string) {
  return sdk
    .fetch(withDirectory(`/experimental/session/${encodeURIComponent(sessionID)}/shell`, sdk))
    .then((res) => json<ShellCommandInfo[]>(res))
}

export function fetchShellCommandOutput(sdk: SDKLike, id: string) {
  return sdk
    .fetch(withDirectory(`/experimental/shell/${encodeURIComponent(id)}/output`, sdk))
    .then((res) => json<ShellCommandOutput>(res))
}

export function killShellCommand(sdk: SDKLike, id: string) {
  return sdk
    .fetch(withDirectory(`/experimental/shell/${encodeURIComponent(id)}/kill`, sdk), { method: "POST" })
    .then((res) => json<boolean>(res))
}

export function formatShellElapsed(started_at: number, completed_at?: number) {
  const seconds = Math.max(0, Math.floor(((completed_at ?? Date.now()) - started_at) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${(seconds % 60).toString().padStart(2, "0")}s`
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)
    .toString()
    .padStart(2, "0")}m`
}
