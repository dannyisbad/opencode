import { Tool } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { EventV2 } from "../event"

export const browserNavigate = Tool.make({
  description: "Navigate the integrated browser to a specific URL.",
  parameters: Schema.Struct({
    url: Schema.String.annotate({ description: "The URL to navigate to" }),
  }),
  success: Schema.Struct({
    status: Schema.String,
  }),
})

export const browserClick = Tool.make({
  description: "Click an element in the integrated browser.",
  parameters: Schema.Struct({
    selector: Schema.String.annotate({ description: "CSS selector of the element to click" }),
  }),
  success: Schema.Struct({
    status: Schema.String,
  }),
})

export const browserType = Tool.make({
  description: "Type text into an input field in the integrated browser.",
  parameters: Schema.Struct({
    selector: Schema.String.annotate({ description: "CSS selector of the input field" }),
    text: Schema.String.annotate({ description: "The text to type" }),
  }),
  success: Schema.Struct({
    status: Schema.String,
  }),
})

export const browserSnapshot = Tool.make({
  description: "Request a snapshot of the current page from the integrated browser. The snapshot will be sent as a message to the session.",
  parameters: Schema.Struct({}),
  success: Schema.Struct({
    status: Schema.String,
  }),
})

export const BrowserControlEvent = EventV2.define({
  type: "tui.browser.control",
  schema: {
    command: Schema.Literals(["navigate", "click", "type", "snapshot"]),
    params: Schema.Record(Schema.String, Schema.Unknown),
  },
})

// NOTE: the integrated-browser tools were registered through the core
// ToolRegistry `contribute`/editor API, which upstream replaced with a new
// `register` mechanism during the tool-registry rewrite. This layer is already
// disabled in builtins.ts; registration is left as a no-op pending a port to
// the new API. The tool definitions and BrowserControlEvent above are retained
// for that port.
export const layer = Layer.effectDiscard(Effect.void)
