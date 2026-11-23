// long-source.ts — checkpoint persistence + chunked long-source analysis.
// Split from src/lib/ingest/ingest.ts (M2 of refactor-web-app).

import {
  createDirectory,
  deleteFile,
  fileExists,
  getFileModifiedTime,
  getFileSize,
  readFile,
  writeFile,
} from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import type { LlmConfig, ReasoningConfig } from "@/stores/wiki-store"
import { useActivityStore } from "@/stores/activity-store"
import { normalizePath } from "@/lib/path-utils"
import { computeIngestAnalysisMaxTokens, INGEST_ANALYSIS_TOKENS_MAX } from "./prompt"
import {
  type LongSourceCheckpoint,
  type LongSourcePlan,
  buildChunkAnalysisSystemPrompt,
  buildChunkAnalysisUserPrompt,
  splitSourceIntoSemanticChunks,
  hashTextHex,
  trimLongText,
} from "./prompt"
import { isSafeIngestPath, uniqueNormalizedPaths } from "./parse"
import { resolveIngestReasoning } from "@/lib/reasoning-capabilities"

const LONG_SOURCE_CHUNK_MIN = 12_000
const LONG_SOURCE_CHUNK_MAX = 60_000
const LONG_SOURCE_DIGEST_MAX = 15_000
const LONG_SOURCE_CHUNK_ANALYSIS_MAX = 40_000

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function ingestAnalysisRequest(config: LlmConfig): {
  maxTokens: number
  reasoning: ReasoningConfig
} {
  const contentTokens = computeIngestAnalysisMaxTokens(config.maxContextSize)
  const requested = resolveIngestReasoning(config)
  const reasoning = requested.mode === "custom"
    ? {
        ...requested,
        budgetTokens: Math.max(
          1_024,
          Math.min(requested.budgetTokens ?? 0, INGEST_ANALYSIS_TOKENS_MAX),
        ),
      }
    : requested
  const reasoningTokens = reasoning.mode === "low"
    ? 1_024
    : reasoning.mode === "medium"
      ? 4_096
      : reasoning.mode === "high" || reasoning.mode === "max"
        ? 8_192
        : reasoning.mode === "custom"
          ? reasoning.budgetTokens ?? 0
          : 0
  return { maxTokens: contentTokens + reasoningTokens, reasoning }
}

function throwIfIngestAborted(signal: AbortSignal | undefined, activityId?: string): void {
  if (!signal?.aborted) return
  if (activityId) {
    useActivityStore.getState().updateItem(activityId, {
      status: "error",
      detail: "Ingest cancelled",
    })
  }
  throw new Error("Ingest cancelled")
}

interface GenerationCheckpoint {
  version: 1
  sourceIdentity: string
  sourceFingerprint: string
  completedPaths: string[]
  updatedAt: number
}

function longSourceCheckpointPath(
  projectPath: string,
  sourceSummarySlug: string,
  sourceHash: string,
): string {
  return `${normalizePath(projectPath)}/.llm-wiki/ingest-progress/${sourceSummarySlug}-${sourceHash}.json`
}

export function generationCheckpointPath(
  projectPath: string,
  sourceSummarySlug: string,
  sourceFingerprint: string,
): string {
  return `${normalizePath(projectPath)}/.llm-wiki/ingest-generation/${sourceSummarySlug}-${sourceFingerprint}.json`
}

export async function sourceGenerationFingerprint(sourcePath: string, sourceContent: string): Promise<string> {
  const [modified, size] = await Promise.all([
    getFileModifiedTime(sourcePath).catch(() => 0),
    getFileSize(sourcePath).catch(() => 0),
  ])
  return hashTextHex(`${sourceContent}\0${modified}\0${size}`)
}

export async function loadGenerationCheckpoint(
  checkpointPath: string,
  sourceIdentity: string,
  sourceFingerprint: string,
  projectPath: string,
): Promise<GenerationCheckpoint | null> {
  try {
    const parsed = JSON.parse(await readFile(checkpointPath)) as GenerationCheckpoint
    if (
      parsed.version !== 1 ||
      parsed.sourceIdentity !== sourceIdentity ||
      parsed.sourceFingerprint !== sourceFingerprint ||
      !Array.isArray(parsed.completedPaths)
    ) return null
    const completedPaths: string[] = []
    for (const path of uniqueNormalizedPaths(parsed.completedPaths)) {
      if (isSafeIngestPath(path) && await fileExists(`${projectPath}/${path}`)) {
        completedPaths.push(path)
      }
    }
    return { ...parsed, completedPaths }
  } catch {
    return null
  }
}

export async function saveGenerationCheckpoint(
  checkpointPath: string,
  checkpoint: GenerationCheckpoint,
): Promise<void> {
  await createDirectory(checkpointPath.split("/").slice(0, -1).join("/"))
  await writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2))
}

export async function clearGenerationCheckpoint(checkpointPath: string): Promise<void> {
  try {
    if (await fileExists(checkpointPath)) await deleteFile(checkpointPath)
  } catch {
    // Best-effort cleanup; a completed checkpoint is harmless because the
    // ingest cache short-circuits subsequent unchanged-source runs.
  }
}

function isCompatibleLongSourceCheckpoint(
  checkpoint: LongSourceCheckpoint,
  params: {
    sourceIdentity: string
    sourceHash: string
    sourceLength: number
    sourceBudget: number
    targetChars: number
    overlapChars: number
    chunkTotal: number
  },
): boolean {
  return checkpoint.version === 1
    && checkpoint.sourceIdentity === params.sourceIdentity
    && checkpoint.sourceHash === params.sourceHash
    && checkpoint.sourceLength === params.sourceLength
    && checkpoint.sourceBudget === params.sourceBudget
    && checkpoint.targetChars === params.targetChars
    && checkpoint.overlapChars === params.overlapChars
    && checkpoint.chunkTotal === params.chunkTotal
    && checkpoint.completedThrough >= 0
    && checkpoint.completedThrough <= params.chunkTotal
    && Array.isArray(checkpoint.analyses)
    && checkpoint.analyses.length === checkpoint.completedThrough
}

export async function loadLongSourceCheckpoint(
  checkpointPath: string,
  params: Parameters<typeof isCompatibleLongSourceCheckpoint>[1],
): Promise<LongSourceCheckpoint | null> {
  try {
    const raw = await readFile(checkpointPath)
    const parsed = JSON.parse(raw) as LongSourceCheckpoint
    if (!isCompatibleLongSourceCheckpoint(parsed, params)) return null
    return parsed
  } catch {
    return null
  }
}

export async function saveLongSourceCheckpoint(
  checkpointPath: string,
  checkpoint: LongSourceCheckpoint,
): Promise<void> {
  const dir = checkpointPath.split("/").slice(0, -1).join("/")
  await createDirectory(dir)
  await writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2))
}

export async function clearLongSourceCheckpoint(checkpointPath: string): Promise<void> {
  try {
    if (await fileExists(checkpointPath)) {
      await deleteFile(checkpointPath)
    }
  } catch {
    // Best-effort cleanup. A stale checkpoint is ignored if source
    // hash / chunk shape no longer matches.
  }
}

function extractMarkedSection(raw: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const re = new RegExp(`(?:^|\\n)##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "i")
  return re.exec(raw)?.[1]?.trim() ?? ""
}

export async function analyzeLongSourceInChunks(
  projectPath: string,
  llmConfig: LlmConfig,
  purpose: string,
  schema: string,
  index: string,
  sourceIdentity: string,
  sourceSummarySlug: string,
  folderContext: string | undefined,
  sourceContent: string,
  sourceBudget: number,
  activityId: string,
  signal?: AbortSignal,
): Promise<LongSourcePlan> {
  const targetChars = clampNumber(Math.floor(sourceBudget * 0.55), LONG_SOURCE_CHUNK_MIN, LONG_SOURCE_CHUNK_MAX)
  const overlapChars = clampNumber(Math.floor(targetChars * 0.08), 800, 3_000)
  const chunks = splitSourceIntoSemanticChunks(sourceContent, targetChars, overlapChars)
  if (chunks.length <= 1) {
    return { chunked: false, analysis: "", sourceContext: sourceContent }
  }

  const activity = useActivityStore.getState()
  const systemPrompt = buildChunkAnalysisSystemPrompt(purpose, schema, index, sourceContent)
  const sourceHash = hashTextHex(sourceContent)
  const checkpointPath = longSourceCheckpointPath(projectPath, sourceSummarySlug, sourceHash)
  const checkpointParams = {
    sourceIdentity,
    sourceHash,
    sourceLength: sourceContent.length,
    sourceBudget,
    targetChars,
    overlapChars,
    chunkTotal: chunks.length,
  }
  const checkpoint = await loadLongSourceCheckpoint(checkpointPath, checkpointParams)
  let globalDigest = checkpoint?.globalDigest ?? ""
  const analyses: string[] = checkpoint?.analyses ? [...checkpoint.analyses] : []
  let completedThrough = checkpoint?.completedThrough ?? 0

  if (completedThrough > 0) {
    activity.updateItem(activityId, {
      detail: `Resuming long source analysis from chunk ${completedThrough + 1}/${chunks.length}...`,
    })
  }

  const analysisRequest = ingestAnalysisRequest(llmConfig)
  for (const chunk of chunks) {
    if (chunk.index <= completedThrough) continue
    throwIfIngestAborted(signal, activityId)
    activity.updateItem(activityId, {
      detail: `Analyzing long source chunk ${chunk.index}/${chunk.total}...`,
    })

    let raw = ""
    let hadError = false
    let analysisTruncated = false
    await streamChat(
      llmConfig,
      [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: buildChunkAnalysisUserPrompt(
            sourceIdentity,
            folderContext,
            chunk,
            trimLongText(globalDigest, LONG_SOURCE_DIGEST_MAX),
          ),
        },
      ],
      {
        onToken: (token) => { raw += token },
        onDone: (completion) => { analysisTruncated = completion?.truncated === true },
        onError: (err) => {
          hadError = true
          activity.updateItem(activityId, { status: "error", detail: `Chunk analysis failed: ${err.message}` })
        },
      },
      signal,
      { temperature: 0.1, reasoning: analysisRequest.reasoning, max_tokens: analysisRequest.maxTokens },
    )

    throwIfIngestAborted(signal, activityId)
    if (hadError) throw new Error("Chunk analysis stream failed")
    if (analysisTruncated) {
      const message =
        `Chunk ${chunk.index}/${chunk.total} analysis was truncated after reaching the ` +
        `${analysisRequest.maxTokens.toLocaleString()} token output limit; the saved checkpoint will be retried`
      activity.updateItem(activityId, { status: "error", detail: message })
      throw new Error(message)
    }

    const chunkAnalysis = extractMarkedSection(raw, "Chunk Analysis") || raw.trim()
    const nextDigest = extractMarkedSection(raw, "Updated Global Digest")
    analyses.push([
      `## Chunk ${chunk.index}/${chunk.total}${chunk.headingPath ? ` — ${chunk.headingPath}` : ""}`,
      trimLongText(chunkAnalysis, LONG_SOURCE_CHUNK_ANALYSIS_MAX),
    ].join("\n"))

    globalDigest = trimLongText(
      nextDigest || [globalDigest, chunkAnalysis].filter(Boolean).join("\n\n"),
      LONG_SOURCE_DIGEST_MAX,
    )
    completedThrough = chunk.index
    await saveLongSourceCheckpoint(checkpointPath, {
      version: 1,
      ...checkpointParams,
      completedThrough,
      globalDigest,
      analyses,
      updatedAt: Date.now(),
    })
  }

  const analysis = [
    "# Consolidated Long-Document Analysis",
    "",
    "## Final Global Digest",
    globalDigest || "(No digest produced.)",
    "",
    "## Per-Chunk Analyses",
    analyses.join("\n\n"),
  ].join("\n")

  const sourceContext = [
    `# Long Source Context: ${sourceIdentity}`,
    "",
    `The original source was analyzed in ${chunks.length} semantic chunks with paragraph/section boundaries and overlap. Use this consolidated context instead of assuming the raw document ended early.`,
    "",
    "## Final Global Digest",
    globalDigest || "(No digest produced.)",
    "",
    "## Chunk Analysis Notes",
    trimLongText(analyses.join("\n\n"), Math.max(sourceBudget, LONG_SOURCE_CHUNK_ANALYSIS_MAX)),
  ].join("\n")

  return { chunked: true, analysis, sourceContext, checkpointPath }
}
