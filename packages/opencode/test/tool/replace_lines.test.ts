import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { ReplaceLinesTool } from "../../src/tool/replace_lines"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import * as Tool from "../../src/tool/tool"
import { testEffect } from "../lib/effect"

const ctx = {
  sessionID: SessionID.make("ses_test-replace-lines-session"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const layer = LayerNode.compile(
  LayerNode.group([LSP.node, FSUtil.node, Format.node, EventV2Bridge.node, Truncate.node, Agent.node]),
)

const it = testEffect(layer)

const init = Effect.fn("ReplaceLinesToolTest.init")(function* () {
  const info = yield* ReplaceLinesTool
  return yield* info.init()
})

const run = Effect.fn("ReplaceLinesToolTest.run")(function* (
  args: Tool.InferParameters<typeof ReplaceLinesTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

describe("tool.replace_lines", () => {
  it.instance("replaces range of lines [start, end) exclusive", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "test.txt")
      yield* Effect.promise(() => fs.writeFile(filepath, "line 1\nline 2\nline 3\nline 4\n"))

      const result = yield* run({ filePath: filepath, start: 2, end: 4, content: "new 2\nnew 3" })
      expect(result.output).toContain("Lines replaced successfully")

      const updated = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
      expect(updated).toBe("line 1\nnew 2\nnew 3\nline 4\n")
    }),
  )

  it.instance("handles trailing newline in content without creating extra blank line", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "test.txt")
      yield* Effect.promise(() => fs.writeFile(filepath, "line 1\nline 2\nline 3\nline 4\n"))

      yield* run({ filePath: filepath, start: 2, end: 4, content: "new 2\nnew 3\n" })

      const updated = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
      expect(updated).toBe("line 1\nnew 2\nnew 3\nline 4\n")
    }),
  )

  it.instance("inserts content when start equals end", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "test.txt")
      yield* Effect.promise(() => fs.writeFile(filepath, "line 1\nline 2\nline 3\n"))

      yield* run({ filePath: filepath, start: 2, end: 2, content: "inserted line" })

      const updated = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
      expect(updated).toBe("line 1\ninserted line\nline 2\nline 3\n")
    }),
  )

  it.instance("deletes lines when content is empty", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "test.txt")
      yield* Effect.promise(() => fs.writeFile(filepath, "line 1\nline 2\nline 3\n"))

      yield* run({ filePath: filepath, start: 2, end: 3, content: "" })

      const updated = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
      expect(updated).toBe("line 1\nline 3\n")
    }),
  )

  it.instance("appends content verbatim when start is out-of-bounds and preserves file trailing newline", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "test.txt")
      yield* Effect.promise(() => fs.writeFile(filepath, "line 1\nline 2\nline 3\n"))

      const result = yield* run({ filePath: filepath, start: 100, end: 100, content: "appended line" })
      expect(result.output).toContain("Content appended to end of file (start line 100 exceeded total lines 3)")

      const updated = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
      expect(updated).toBe("line 1\nline 2\nline 3\nappended line\n")
    }),
  )

  it.instance("appends content verbatim when start is out-of-bounds on file without trailing newline", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "test.txt")
      yield* Effect.promise(() => fs.writeFile(filepath, "line 1\nline 2\nline 3"))

      yield* run({ filePath: filepath, start: 100, end: 100, content: "appended line\n" })

      const updated = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
      expect(updated).toBe("line 1\nline 2\nline 3\nappended line\n")
    }),
  )

  it.instance("appends content verbatim on empty file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "test.txt")
      yield* Effect.promise(() => fs.writeFile(filepath, ""))

      yield* run({ filePath: filepath, start: 100, end: 100, content: "first line\n" })

      const updated = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
      expect(updated).toBe("first line\n")
    }),
  )
})
