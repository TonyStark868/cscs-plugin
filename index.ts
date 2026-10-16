import { existsSync, readFileSync, statSync } from "node:fs"
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin"

const BASE = path.dirname(fileURLToPath(import.meta.url))
const SKILL_MD = path.join(BASE, "skill", "SKILL.md")
const OCR_SCRIPT = path.join(BASE, "skill", "scripts", "ocr_pages.py")

/** 《NSCA-CSCS指南》技能元数据（插件与技能同源，便于 npm 分发） */
const SKILL_META = {
  id: "nsca-cscs",
  name: "NSCA-CSCS 指南助手",
  description:
    "基于本地教材《NSCA-CSCS美国国家体能协会体能教练认证指南（第4版）》的体能训练知识助手。讨论体能训练/力量训练/训练计划设计/测试评估/营养补剂/周期化/康复/CSCS备考时使用。",
}

/** 教材 PDF 路径：options.pdf → 环境变量 → 插件存储 */
function pickBookPath(options?: { pdf?: string }, stored?: string | null): string | undefined {
  return options?.pdf || process.env.NSCA_CSCS_PDF || (stored ?? undefined)
}

function runProcess(
  args: string[],
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const python = process.platform === "win32" ? "python" : "python3"
    const proc = spawn(python, ["-X", "utf8", ...args])
    let stdout = ""
    let stderr = ""
    const onAbort = () => proc.kill()
    signal?.addEventListener("abort", onAbort)
    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8")
    })
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8")
    })
    proc.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort)
      resolve({ code: code ?? -1, stdout, stderr })
    })
    proc.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort)
      resolve({
        code: -2,
        stdout: "",
        stderr: `无法启动 Python: ${err.message}（请确认已安装 Python 并在 PATH 中）`,
      })
    })
  })
}

export default Plugin.define({
  id: "nscaCscs",
  async setup(ctx) {
    const stored = (await ctx.storage.get("bookPath")) as string | null | undefined
    const configured = pickBookPath(ctx.options as { pdf?: string } | undefined, stored)

    if (configured && !existsSync(configured)) {
      console.log(`[nsca-cscs] 配置的书路径不存在，使用工具 nsca_use_book 重新配置: ${configured}`)
    }

    /** 注册技能：插件安装即拥有教材知识说明 */
    await ctx.skill.transform((editor) => {
      editor.add({
        id: SKILL_META.id,
        name: SKILL_META.name,
        description: SKILL_META.description,
        path: SKILL_MD,
        content: readFileSync(SKILL_MD, "utf8"),
      })
    })

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "nsca",
        description: "《NSCA-CSCS体能教练认证指南（第4版）》教材工具：按书页码OCR调取原文。",
      })

      const execOcr = async (
        input: { page?: string; dpi?: number; force?: boolean },
        context: { signal?: AbortSignal; progress?: (o: { status: string }) => Promise<void> },
      ) => {
        const page = String(input?.page ?? "").trim()
        if (!page || !/^[0-9]+(-[0-9]+)?$/.test(page)) {
          return { content: "参数 page 需为书内页码，如 \"47\" 或范围 \"483-500\"。" }
        }
        const pdf = pickBookPath(ctx.options as { pdf?: string } | undefined, await ctx.storage.get("bookPath") as string | null)
        if (!pdf) {
          return {
            content:
              "尚未配置教材 PDF 路径。请询问用户他们本地教材扫描件的完整路径，得到后调用 nsca_use_book 工具配置（支持 --pdf/环境变量 NSCA_CSCS_PDF/存储三种来源）。",
          }
        }
        if (!existsSync(pdf)) {
          return {
            content: `配置的书路径不存在: ${pdf}。请向用户确认文件当前位置后调用 nsca_use_book 更新。`,
          }
        }
        const args = ["--pdf", pdf, page, "--dpi", String(input?.dpi ?? 200)]
        if (input?.force) args.push("--force")
        await context.progress?.({ status: `正在 OCR 书第${page}页...` })
        const { code, stdout, stderr } = await runProcess([OCR_SCRIPT, ...args], context.signal)
        if (code === 0) {
          return { content: stdout }
        }
        if (stderr.includes("缺少依赖 pymupdf") || stdout.includes("缺少依赖")) {
          return {
            content:
              "OCR 依赖未安装。请在用户环境中运行: pip install -r \"" +
              path.join(BASE, "skill", "scripts", "requirements.txt") +
              "\" 然后重试。",
          }
        }
        return { content: `OCR 运行失败(退出码 ${code})。\n${stdout}\n${stderr.slice(-800)}` }
      }

      editor.add({
        name: "ocr_page",
        description:
          "按书内页码 OCR 调取《NSCA-CSCS体能教练认证指南(第4版)》原文文本。page 支持 \"473\" 或 \"483-500\"。自动按 PDF页=书页+14 换算，结果有缓存（约8秒/页，重复调用秒回）。未经配置书路径时返回提示。",
        input: {
          type: "object",
          properties: {
            page: { type: "string", description: "书内页码，单页如 \"473\"，范围如 \"483-500\"" },
            dpi: { type: "number", description: "渲染分辨率，默认 200；识别质量差可提到 220~250" },
            force: { type: "boolean", description: "忽略缓存重新识别" },
          },
          required: ["page"],
          additionalProperties: false,
        },
        options: { namespace: "nsca", codemode: true },
        execute: execOcr,
      })

      editor.add({
        name: "use_book",
        description:
          "配置用户本地《NSCA-CSCS指南(第4版)》PDF 的绝对路径并持久保存（插件存储）。首次使用或书移动位置后调用。",
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "教材 PDF 的完整绝对路径" },
          },
          required: ["path"],
          additionalProperties: false,
        },
        options: { namespace: "nsca", codemode: true },
        execute: async (input: { path?: string }) => {
          const raw = String(input?.path ?? "").trim().replace(/^["']|["']$/g, "")
          if (!raw || !existsSync(raw)) {
            return { content: `路径不存在: ${raw ?? "(空)"}。请让用户提供教材 PDF 的完整路径。` }
          }
          if (!statSync(raw).isFile()) {
            return { content: `这不是一个文件: ${raw}` }
          }
          const abs = path.resolve(raw)
          await ctx.storage.set("bookPath", abs)
          return {
            content: `教材路径已配置并持久保存: ${abs}\n可用 nsca_ocr_page 调取书页内容（书页码直接传，如 "473"）。`,
          }
        },
      })
    })

    return () => {
      bookPathCleanup()
    }
  },
})

function bookPathCleanup() {
  /* 插件卸载清理（当前无需特殊处理） */
}
