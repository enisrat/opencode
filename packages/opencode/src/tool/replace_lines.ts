import { Schema } from "effect"
import * as path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./replace_lines.txt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Format } from "../format"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { trimDiff } from "./edit"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Bom from "@/util/bom"

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file to modify" }),
  start: Schema.Number.annotate({ description: "The starting line number (1-indexed, inclusive)" }),
  end: Schema.Number.annotate({ description: "The ending line number (1-indexed, exclusive)" }),
  content: Schema.String.annotate({ description: "The new content to replace the range with" }),
})

export const ReplaceLinesTool = Tool.define(
  "replace_lines",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service
    const format = yield* Format.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          yield* assertExternalDirectoryEffect(ctx, filepath)

          const info = yield* fs.stat(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!info) throw new Error(`File ${filepath} not found`)
          if (info.type === "Directory") throw new Error(`Path is a directory, not a file: ${filepath}`)

          const source = yield* Bom.readFile(fs, filepath)
          const contentOld = source.text
          const lines = contentOld.split("\n")

          const start = Math.max(1, Math.min(params.start, lines.length + 1))
          const end = Math.max(start, Math.min(params.end, lines.length + 1))

          const beforeLines = lines.slice(0, start - 1)
          const afterLines = lines.slice(end - 1)
          const newLines = params.content === "" ? [] : params.content.split("\n")
          const contentNew = [...beforeLines, ...newLines, ...afterLines].join("\n")

          const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, contentNew))
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, filepath)],
            always: ["*"],
            metadata: {
              filepath,
              diff,
            },
          })

          const next = Bom.split(contentNew)
          const desiredBom = source.bom || next.bom
          yield* fs.writeWithDirs(filepath, Bom.join(next.text, desiredBom))
          if (yield* format.file(filepath)) {
            yield* Bom.syncFile(fs, filepath, desiredBom)
          }
          yield* events.publish(FileSystem.Event.Edited, { file: filepath })
          yield* events.publish(Watcher.Event.Updated, {
            file: filepath,
            event: "change",
          })

          let output = "Lines replaced successfully."
          yield* lsp.touchFile(filepath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilepath = FSUtil.normalizePath(filepath)
          const block = LSP.Diagnostic.report(filepath, diagnostics[normalizedFilepath] ?? [])
          if (block) output += `\n\nLSP errors detected in this file, please fix:\n${block}`

          return {
            title: path.relative(instance.worktree, filepath),
            metadata: {
              diagnostics,
              filepath,
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)