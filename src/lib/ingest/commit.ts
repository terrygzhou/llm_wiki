// commit.ts — disk-write / state-commit (the autoIngest pipeline).
// Split from src/lib/ingest/ingest.ts (M2 of refactor-web-app).

import {
  createDirectory,
  deleteFile,
  fileExists,
  readFile,
  writeFile,
  listDirectory,
} from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import type { LlmConfig, ReasoningConfig } from "@/stores/wiki-store"
import { useWikiStore } from "@/stores/wiki-store"
import { parseWithMineruResult } from "@/lib/mineru"
import { useChatStore } from "@/stores/chat-store"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore } from "@/stores/review-store"
import { getFileName, normalizePath } from "@/lib/path-utils"
import {
  sourceIdentityForPath,
  sourceReferenceIdentity,
  sourceSummarySlugCandidatesFromIdentity,
  sourceSummarySlugFromIdentity,
} from "@/lib/source-identity"
import { parseSources, writeSources } from "@/lib/sources-merge"
import { checkIngestCache, saveIngestCache } from "@/lib/ingest-cache"
import { sanitizeIngestedFileContent } from "@/lib/ingest-sanitize"
import { mergePageContent } from "@/lib/page-merge"
import { withProjectLock } from "@/lib/project-mutex"
import { parseFrontmatter } from "@/lib/frontmatter"
import type { FileNode } from "@/types/wiki"
import {
  extractAndSaveSourceImages,
  extractAndSaveMarkdownImages,
  buildImageMarkdownSection,
  type SavedImage,
} from "@/lib/extract-source-images"
import {
  captionMarkdownImages,
  loadCaptionCache,
  stripMarkdownImageReferences,
} from "@/lib/image-caption-pipeline"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { persistParsedMarkdown } from "@/lib/parsed-source-output"
import { getOutputLanguage } from "@/lib/output-language"
import { loadProjectWikiSchemaRouting } from "@/lib/wiki-schema"
import {
  languageRule,
  buildDeterministicIngestLog,
  buildAnalysisPrompt,
  buildGenerationPrompt,
  buildReviewSuggestionPrompt,
  buildTruncatedFileRepairPrompt,
  computeIngestSourceBudget,
  computeIngestGenerationMaxTokens,
  computeIngestReviewMaxTokens,
  computeIngestAnalysisMaxTokens,
  INGEST_ANALYSIS_TOKENS_MAX,
  trimInlineStatus,
  buildPageMerger,
} from "./prompt"
import {
  imageExtractionKey,
  rememberImageExtractionByKey,
  savedImagesFromMineruMarkdown,
  resolveCaptionConfig,
  toSourceSummaryImageRef,
  appendSavedImageRefsForCaption,
  isSavedImagePromptUrl,
  promptImageUrlToAbs,
  stripWikiMediaAbsPaths,
  extractSourceImagesOnce,
  extractSourceImagesOnceByKey,
  ingestImageExtractionPromises,
} from "./image-extraction"
import {
  isLogPath,
  isListingPath,
  isAppManagedAggregatePath,
  parseFileBlocks,
  sourceSummaryMediaRefsForExternalMarkdown,
  hasMineruImageRefs,
  FILE_BLOCK_REGEX,
  isSafeIngestPath,
  rewriteIngestPathFromTitleForTargetLanguage,
  filterTruncatedFileRepairOutput,
  parseReviewBlocks,
  contentMatchesTargetLanguage,
  shouldRunDedicatedReviewStage,
} from "./parse"
import {
  clearGenerationCheckpoint,
  clearLongSourceCheckpoint,
  analyzeLongSourceInChunks,
  generationCheckpointPath,
  sourceGenerationFingerprint,
  saveGenerationCheckpoint,
  loadGenerationCheckpoint,
} from "./long-source"
import { correctWikiPageRouting, validateWikiPageRouting } from "@/lib/graph/wiki-schema"
import { getLanguagePromptName } from "@/lib/i18n-support/language-metadata"
import { resolveIngestReasoning } from "@/lib/reasoning-capabilities"


const AGGREGATE_WIKI_PATHS = ["wiki/index.md", "wiki/overview.md", "wiki/log.md"] as const

export class NonRetryableIngestError extends Error {
  readonly nonRetryable = true

  constructor(message: string) {
    super(message)
    this.name = "NonRetryableIngestError"
  }
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

export type IngestCommitRunner = <T>(operation: () => Promise<T>) => Promise<T>

export interface AutoIngestOptions {
  /**
   * Adds queue ordering around a commit. The supplied runner must not acquire
   * the project mutex; autoIngest always acquires it inside this callback.
   */
  runCommit?: IngestCommitRunner
}

export async function autoIngest(
  projectPath: string,
  sourcePath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
  folderContext?: string,
  onFileWritten?: (relativePath: string) => void,
  options?: AutoIngestOptions,
): Promise<string[]> {
  const pp = normalizePath(projectPath)
  const sp = normalizePath(sourcePath)
  return withProjectLock(
    `ingest-source\0${pp}\0${sp}`,
    () => autoIngestImpl(
      projectPath,
      sourcePath,
      llmConfig,
      signal,
      folderContext,
      onFileWritten,
      options,
    ),
  )
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

export function formatIngestWarningLogEntry(
  sourceIdentity: string,
  warnings: readonly string[],
  at = new Date(),
): string {
  return [
    `## ${at.toISOString()} | ${sourceIdentity}`,
    "",
    ...warnings.map((warning, index) => `${index + 1}. ${warning}`),
    "",
  ].join("\n")
}

async function appendIngestWarningLog(
  projectPath: string,
  sourceIdentity: string,
  warnings: readonly string[],
): Promise<void> {
  if (warnings.length === 0) return
  const logPath = `${projectPath}/.llm-wiki/ingest-warnings.log`
  try {
    await createDirectory(`${projectPath}/.llm-wiki`)
    const existing = await tryReadFile(logPath)
    const next = `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${formatIngestWarningLogEntry(sourceIdentity, warnings).trimEnd()}\n`
    await writeFile(logPath, next)
  } catch (err) {
    console.warn(
      `[ingest] Failed to write ingest warning log for "${sourceIdentity}":`,
      err instanceof Error ? err.message : err,
    )
  }
}

async function autoIngestImpl(
  projectPath: string,
  sourcePath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
  folderContext?: string,
  onFileWritten?: (relativePath: string) => void,
  options?: AutoIngestOptions,
): Promise<string[]> {
  const pp = normalizePath(projectPath)
  const sp = normalizePath(sourcePath)
  const activity = useActivityStore.getState()
  const fileName = getFileName(sp)
  const sourceIdentity = sourceIdentityForPath(pp, sp)
  const sourceSummarySlug = sourceSummarySlugFromIdentity(sourceIdentity)
  const sourceSummaryPath = `wiki/sources/${sourceSummarySlug}.md`
  const queueCommit = options?.runCommit
  const runCommit: IngestCommitRunner = queueCommit
    ? ((operation) => queueCommit(() => withProjectLock(pp, operation)))
    : ((operation) => withProjectLock(pp, operation))
  console.log(`[ingest:diag] autoIngestImpl ENTRY for "${fileName}" (project="${pp}", source="${sp}")`)
  const activityId = activity.addItem({
    type: "ingest",
    title: fileName,
    status: "running",
    detail: "Reading source...",
    filesWritten: [],
  })

  // ── MinerU preprocessing for PDF files ──
  const lowerExt = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() : ""
  const isPdf = lowerExt === "pdf"
  const mineruCfg = useWikiStore.getState().mineruConfig
  let mineruSucceeded = false
  let mineruSavedImages: SavedImage[] = []
  const mineruConfigured = mineruCfg.backend === "local" || Boolean(mineruCfg.token)
  if (isPdf && mineruCfg.enabled && mineruConfigured) {
    try {
      const cacheDir = sp.substring(0, sp.lastIndexOf("/"))
      const cachePath = `${cacheDir}/.cache/${fileName}.txt`
      activity.updateItem(activityId, { detail: "MinerU: parsing PDF..." })
      console.log(`[ingest:mineru] submitting "${fileName}" to MinerU API`)
      const mineruResult = await parseWithMineruResult(mineruCfg, sp, undefined, (msg) => {
        activity.updateItem(activityId, { detail: `MinerU: ${msg}` })
      }, signal, {
        projectPath: pp,
        sourceSummarySlug,
      })
      await createDirectory(`${cacheDir}/.cache`)
      await writeFile(cachePath, mineruResult.markdown)
      mineruSavedImages = mineruResult.savedImages
      if (mineruSavedImages.length > 0) {
        const extractionKey = await imageExtractionKey(pp, sp, sourceSummarySlug)
        rememberImageExtractionByKey(extractionKey, Promise.resolve(mineruSavedImages))
      }
      mineruSucceeded = true
      console.log(
        `[ingest:mineru] cached MinerU output for "${fileName}" (${mineruResult.markdown.length} chars, images=${mineruSavedImages.length})`,
      )
    } catch (err) {
      throwIfIngestAborted(signal, activityId)
      const msg = trimInlineStatus(err instanceof Error ? err.message : String(err))
      console.warn(`[ingest:mineru] MinerU parsing failed, falling back to pdfium: ${msg}`)
      activity.updateItem(activityId, {
        detail: `MinerU failed, falling back to built-in PDF extraction: ${msg}`,
      })
    }
    if (mineruSucceeded && !signal?.aborted) {
      activity.updateItem(activityId, { detail: "Reading source..." })
    }
  }

  const [sourceContent, schema, purpose, index, overview] = await Promise.all([
    tryReadSourceTextFile(sp),
    tryReadFile(`${pp}/schema.md`),
    tryReadFile(`${pp}/purpose.md`),
    tryReadFile(`${pp}/wiki/index.md`),
    tryReadFile(`${pp}/wiki/overview.md`),
  ])
  if (useWikiStore.getState().sourceWatchConfig.persistExtractedMarkdown) {
    try {
      await persistParsedMarkdown(pp, sp, sourceContent)
    } catch (err) {
      // The visible copy is optional and must never turn a successful parse
      // into a failed ingest. The internal extraction/cache remains usable.
      console.warn(
        `[ingest] Failed to keep parsed Markdown for "${sourceIdentity}":`,
        err instanceof Error ? err.message : err,
      )
    }
  }
  if (isPdf && mineruSavedImages.length === 0 && hasMineruImageRefs(sourceContent, sourceSummarySlug)) {
    mineruSavedImages = await savedImagesFromMineruMarkdown(pp, sourceSummarySlug, sourceContent)
    if (mineruSavedImages.length > 0) {
      const extractionKey = await imageExtractionKey(pp, sp, sourceSummarySlug)
      rememberImageExtractionByKey(extractionKey, Promise.resolve(mineruSavedImages))
    }
  }

  // ── Cache check: skip re-ingest if source content hasn't changed ──
  //
  // Image cascade still runs on cache hits. Reason: a user may have
  // ingested this source on a previous app version that didn't extract
  // images yet, or the media dir may have been deleted out from under
  // us. `extractAndSaveSourceImages` + injection are both idempotent
  // (deterministic output paths, marker-bracketed replacement), so
  // re-running them costs only the extraction time and converges the
  // source-summary page on the current pipeline's contract regardless
  // of when the file was first ingested.
  const cachedFiles = await checkIngestCache(pp, sourceIdentity, sourceContent)
  console.log(`[ingest:diag] cache check for "${sourceIdentity}":`, cachedFiles === null ? "MISS (full pipeline)" : `HIT (${cachedFiles.length} cached files)`)
  if (cachedFiles !== null) {
    return runCommit(async () => {
      throwIfIngestAborted(signal, activityId)
      try {
      console.log(`[ingest:diag] cache-hit branch: starting image extraction for ${sp}`)
      const skipNativePdfImageExtraction = isPdf && hasMineruImageRefs(sourceContent, sourceSummarySlug)
      let savedImages = skipNativePdfImageExtraction
        ? mineruSavedImages
        : await extractAndSaveSourceImages(pp, sp, sourceSummarySlug)
      const markdownImages = await extractAndSaveMarkdownImages(pp, sp, sourceContent, sourceSummarySlug)
      savedImages = [...savedImages, ...markdownImages]
      console.log(`[ingest:diag] cache-hit branch: got ${savedImages.length} image(s)`)
      if (savedImages.length > 0) {
        // Caption first (populates the cache), THEN inject — the
        // safety-net section uses the cache to populate alt text.
        // Doing them in this order means cache-hit re-runs (e.g.
        // user re-imports an old PDF after captioning was added)
        // converge: first run grows the cache, second run uses it.
        //
        // Master-toggle gate: when multimodal is OFF the entire
        // image-cascade is skipped here. This matches the
        // full-pipeline branch's strip-and-skip behavior for the
        // cache-hit path, so a user re-importing an old file
        // after disabling captioning sees images disappear from
        // the wiki side. (If a previous ingest had already written
        // a `## Embedded Images` block, it stays — re-import
        // doesn't proactively scrub old wiki content. The user
        // would need to delete the wiki/sources/<slug>.md page
        // to start clean.)
        const mmCfg = useWikiStore.getState().multimodalConfig
        if (!mmCfg.enabled) {
          console.log(
            `[ingest:caption] cache-hit + disabled — skipping caption + safety-net inject (${savedImages.length} image(s) untouched on disk)`,
          )
        } else {
          const captionLlm = resolveCaptionConfig(mmCfg, llmConfig)
          if (captionLlm) {
            try {
              await withProjectLock(`${pp}\0image-caption-cache`, () =>
                captionMarkdownImages(pp, appendSavedImageRefsForCaption(sourceContent, savedImages), captionLlm, {
                  signal,
                  shouldCaption: (url) =>
                    isSavedImagePromptUrl(pp, sourceSummarySlug, url),
                  urlToAbsPath: (url) => promptImageUrlToAbs(pp, url),
                  concurrency: mmCfg.concurrency,
                  outputLanguage: getLanguagePromptName(getOutputLanguage(sourceContent)),
                  onProgress: (done, total) =>
                    activity.updateItem(activityId, {
                      detail: `Captioning images... ${done}/${total}`,
                    }),
                }),
              )
            } catch (err) {
              console.warn(
                `[ingest:caption] cache-hit caption pass failed:`,
                err instanceof Error ? err.message : err,
              )
            }
          }
          await injectImagesIntoSourceSummary(
            pp,
            sourceIdentity,
            sourceSummarySlug,
            savedImages,
            getLanguagePromptName(getOutputLanguage(sourceContent)),
          )
          // Re-embed the source-summary page so caption text lands
          // in the search index. Without this step, search by image
          // content stays empty for files ingested before captioning
          // was added — the safety-net section was just rewritten
          // with captions, but the embeddings still reflect the old
          // empty-alt content.
          await reembedSourceSummary(pp, sourceIdentity, sourceSummarySlug)
        }
      } else {
        console.log(`[ingest:diag] cache-hit branch: skipping injection (no images returned from extraction)`)
      }
      } catch (err) {
        console.warn(
          `[ingest:images] cache-hit injection failed for "${fileName}":`,
          err instanceof Error ? err.message : err,
        )
      }
      activity.updateItem(activityId, {
        status: "done",
        detail: `Skipped (unchanged) — ${cachedFiles.length} files from previous ingest`,
        filesWritten: cachedFiles,
      })
      return cachedFiles
    })
  }

  // ── Step 0.5: Extract embedded images ─────────────────────────
  // Pulls every embedded image out of PDF / PPTX / DOCX into
  // `wiki/media/<source-slug>/`. We DON'T inject the markdown
  // references into sourceContent here — without VLM captions
  // (Phase 3a) the alt text is empty, which gives the LLM no
  // semantic signal to preserve them. The LLM tends to silently
  // strip empty-alt images when summarizing.
  //
  // Instead, the markdown section is appended to the source-summary
  // page on disk AFTER writeFileBlocks (see Step 5b below). That
  // guarantees images appear in `wiki/sources/<slug>.md` regardless
  // of LLM behavior. Once Phase 3a lands, we'll re-introduce the
  // sourceContent injection because the captioned alt-text gives
  // the LLM something meaningful to work with.
  //
  // Failure here is never fatal — extractAndSaveSourceImages logs
  // and returns [] on any error.
  activity.updateItem(activityId, { detail: "Extracting embedded images..." })
  console.log(`[ingest:diag] full-pipeline branch: starting image extraction for ${sp}`)
  const skipNativePdfImageExtraction = isPdf && (
    hasMineruImageRefs(sourceContent, sourceSummarySlug)
  )
  let savedImages = skipNativePdfImageExtraction
    ? mineruSavedImages
    : await extractAndSaveSourceImages(pp, sp, sourceSummarySlug)
  const markdownImages = await extractAndSaveMarkdownImages(pp, sp, sourceContent, sourceSummarySlug)
  savedImages = [...savedImages, ...markdownImages]
  console.log(`[ingest:diag] full-pipeline branch: got ${savedImages.length} image(s)`)
  if (savedImages.length > 0) {
    console.log(
      `[ingest:images] saved ${savedImages.length} image(s) for "${sourceIdentity}" → wiki/media/${sourceSummarySlug}/`,
    )
  }

  // ── Step 0.6: Caption embedded images ─────────────────────────
  // Now that read_file's combined extraction has put `![](abs_path)`
  // markers inline in `sourceContent`, walk them and replace the
  // empty alt text with a vision-model-generated factual caption.
  // SHA-256-keyed cache (`<project>/.llm-wiki/image-caption-cache.json`)
  // dedupes across runs and across documents (shared logos / chart
  // templates caption once, not once per document).
  //
  // Why this matters: an empty-alt image gets paraphrased away by
  // text summarization. With a caption, the alt text carries enough
  // semantic load that the generation LLM tends to preserve the
  // image reference inline at the right paragraph.
  //
  // Scope: we only caption images whose absolute path lives under
  // <project>/wiki/media/<source-slug>/ — i.e. images the current
  // ingest produced. User-typed external URLs in markdown source
  // documents are passed through untouched.
  //
  // Master-toggle behavior: when `multimodalConfig.enabled` is
  // false, we don't just skip the caption LLM call — we ALSO
  // strip `![](url)` references from sourceContent before the LLM
  // sees it, AND skip the post-write safety-net injection further
  // down. Net effect: the wiki-side pipeline never references
  // images at all. Without the strip + skip, image references
  // would leak via two paths:
  //   1. The LLM-generation prompt sees them in sourceContent and
  //      can preserve them in the generated wiki pages
  //   2. injectImagesIntoSourceSummary unconditionally appends a
  //      `## Embedded Images` section to wiki/sources/<slug>.md
  // Both paths land image refs into wiki pages, which then get
  // embedded → searchable → visible in the search image grid even
  // though the user disabled captioning. This was the user-
  // surprising behavior that prompted the fix.
  //
  // Rust extraction itself is untouched: images still land on disk
  // under wiki/media/<slug>/ (cheap), and the raw-source preview
  // (which renders read_file output directly) still shows them —
  // that surface is "the source document as-is", separate from
  // "the curated wiki knowledge".
  let enrichedSourceContent = stripWikiMediaAbsPaths(
    pp,
    appendSavedImageRefsForCaption(sourceContent, savedImages),
  )
  const mmCfg = useWikiStore.getState().multimodalConfig
  const captionLlm = resolveCaptionConfig(mmCfg, llmConfig)
  if (!mmCfg.enabled && savedImages.length > 0) {
    // Strip recognized `![alt](url)` references with the shared parser. Preserve a single space
    // where the ref used to sit so adjacent words don't fuse.
    enrichedSourceContent = stripMarkdownImageReferences(sourceContent)
    console.log(
      `[ingest:caption] disabled — stripped image refs from sourceContent (${savedImages.length} image(s) won't appear in wiki pages)`,
    )
  } else if (
    captionLlm &&
    savedImages.length > 0 &&
    /!\[\]\(/.test(enrichedSourceContent)
  ) {
    activity.updateItem(activityId, { detail: "Captioning images..." })
    const ourMediaPrefix = `${pp}/wiki/media/${sourceSummarySlug}/`
    try {
      const result = await withProjectLock(`${pp}\0image-caption-cache`, () =>
        captionMarkdownImages(pp, enrichedSourceContent, captionLlm, {
          signal,
          // Strict filter: only caption images we know we just
          // extracted into this source's media directory. Skips any
          // pre-existing markdown image refs the user may have typed
          // into the source content (e.g. for hand-authored .md
          // sources).
          shouldCaption: (url) => url.startsWith(ourMediaPrefix) || isSavedImagePromptUrl(pp, sourceSummarySlug, url),
          urlToAbsPath: (url) => promptImageUrlToAbs(pp, url),
          concurrency: mmCfg.concurrency,
          outputLanguage: getLanguagePromptName(getOutputLanguage(enrichedSourceContent)),
          onProgress: (done, total) =>
            activity.updateItem(activityId, {
              detail: `Captioning images... ${done}/${total}`,
            }),
        }),
      )
      enrichedSourceContent = stripWikiMediaAbsPaths(pp, result.enrichedMarkdown)
      console.log(
        `[ingest:caption] images=${savedImages.length} fresh=${result.freshCaptions} cached=${result.cachedCaptions} failed=${result.failed}`,
      )
    } catch (err) {
      console.warn(
        `[ingest:caption] pipeline failed for "${fileName}":`,
        err instanceof Error ? err.message : err,
      )
      // Fall through with original (empty-alt) source content —
      // captioning failure must NEVER break ingest.
    }
  }

  const stableContextLength = schema.length + purpose.length + index.length + overview.length
  const sourceBudget = computeIngestSourceBudget(llmConfig.maxContextSize, stableContextLength)
  let sourceContext = enrichedSourceContent
  let precomputedAnalysis = ""
  let longSourceCheckpointPath: string | undefined

  if (enrichedSourceContent.length > sourceBudget) {
    const longSourcePlan = await analyzeLongSourceInChunks(
      pp,
      llmConfig,
      purpose,
      schema,
      index,
      sourceIdentity,
      sourceSummarySlug,
      folderContext,
      enrichedSourceContent,
      sourceBudget,
      activityId,
      signal,
    )
    if (longSourcePlan.chunked) {
      sourceContext = longSourcePlan.sourceContext
      precomputedAnalysis = longSourcePlan.analysis
      longSourceCheckpointPath = longSourcePlan.checkpointPath
    }
  }

  // ── Step 1: Analysis ──────────────────────────────────────────
  // LLM reads the source and produces a structured analysis:
  // key entities, concepts, main arguments, connections to existing wiki, contradictions
  activity.updateItem(activityId, {
    detail: precomputedAnalysis
      ? "Step 1/2: Consolidating long-source analysis..."
      : "Step 1/2: Analyzing source...",
  })

  let analysis = precomputedAnalysis

  if (!analysis) {
    let analysisTruncated = false
    const analysisRequest = ingestAnalysisRequest(llmConfig)
    await streamChat(
      llmConfig,
      [
        { role: "system", content: buildAnalysisPrompt(purpose, index, sourceContext, schema) },
        { role: "user", content: `Analyze this source document:\n\n**File:** ${sourceIdentity}${folderContext ? `\n**Folder context:** ${folderContext}` : ""}\n\n---\n\n${sourceContext}` },
      ],
      {
        onToken: (token) => { analysis += token },
        onDone: (completion) => { analysisTruncated = completion?.truncated === true },
        onError: (err) => {
          activity.updateItem(activityId, { status: "error", detail: `Analysis failed: ${err.message}` })
        },
      },
      signal,
      { temperature: 0.1, reasoning: analysisRequest.reasoning, max_tokens: analysisRequest.maxTokens },
    )
    if (analysisTruncated) {
      const message =
        `Analysis was truncated after reaching the ${analysisRequest.maxTokens.toLocaleString()} token output limit. ` +
        "Wiki pages were not generated from the incomplete analysis. Split the source or use a model with a larger output limit."
      activity.updateItem(activityId, { status: "error", detail: message })
      throw new NonRetryableIngestError(message)
    }
  }

  // A silent `return []` here would look like success to the queue
  // runner and cause the task to be filter()'d out. Throw instead so
  // processNext's catch-block path (retry / mark failed) engages.
  const analysisActivity = useActivityStore.getState().items.find((i) => i.id === activityId)
  if (analysisActivity?.status === "error") {
    throw new Error(analysisActivity.detail || "Analysis stream failed")
  }

  // ── Step 2: Generation ────────────────────────────────────────
  // LLM takes the analysis as context and produces wiki files + review items
  activity.updateItem(activityId, { detail: "Step 2/2: Generating wiki pages..." })

  const generationFingerprint = await sourceGenerationFingerprint(sp, sourceContent)
  const generationProgressPath = generationCheckpointPath(
    pp,
    sourceSummarySlug,
    generationFingerprint,
  )
  const generationCheckpoint = await loadGenerationCheckpoint(
    generationProgressPath,
    sourceIdentity,
    generationFingerprint,
    pp,
  )
  const previouslyCompletedPaths = generationCheckpoint?.completedPaths ?? []
  let generation = ""
  let generationError: string | null = null
  let generationTruncated = false

  try {
    await streamChat(
      llmConfig,
      [
        { role: "system", content: buildGenerationPrompt(schema, purpose, index, sourceIdentity, overview, sourceContext, sourceSummaryPath) },
        {
          role: "user",
          content: [
            `Source document to process: **${sourceIdentity}**`,
            "",
            "The Stage 1 analysis below is CONTEXT to inform your output. Do NOT echo",
            "its tables, bullet points, or prose. Your output must be FILE/REVIEW",
            "blocks as specified in the system prompt — nothing else.",
            previouslyCompletedPaths.length > 0
              ? [
                  "",
                  "## Resume checkpoint",
                  "The following FILE paths were already written successfully in an earlier attempt.",
                  "Do not emit them again. Emit only the remaining pages required by the analysis:",
                  ...previouslyCompletedPaths.map((path) => `- ${path}`),
                  "If every required page is already complete, return exactly `---RESUME COMPLETE---`.",
                ].join("\n")
              : "",
            "",
            "## Stage 1 Analysis (context only — do not repeat)",
            "",
            analysis,
            "",
            "## Source Context",
            "",
            sourceContext,
            "",
            "---",
            "",
            `Now emit the FILE blocks for the wiki files derived from **${sourceIdentity}**.`,
            "Your response MUST begin with `---FILE:` as the very first characters.",
            "No preamble. No analysis prose. Start immediately.",
          ].filter(Boolean).join("\n"),
        },
      ],
      {
        onToken: (token) => { generation += token },
        onDone: (completion) => { generationTruncated = completion?.truncated === true },
        onError: (err) => { generationError = err.message },
      },
      signal,
      {
        temperature: 0.1,
        reasoning: resolveIngestReasoning(llmConfig),
        max_tokens: computeIngestGenerationMaxTokens(llmConfig.maxContextSize),
      },
    )
  } catch (err) {
    throwIfIngestAborted(signal, activityId)
    generationError = err instanceof Error ? err.message : String(err)
  }

  const parsedGeneration = parseFileBlocks(generation)
  const resumeConfirmedComplete = previouslyCompletedPaths.length > 0 &&
    generation.trim() === "---RESUME COMPLETE---"
  if ((generationError || generationTruncated) && parsedGeneration.blocks.length === 0) {
    const message = generationError
      ? `Generation failed before any complete wiki file was produced: ${generationError}`
      : "Generation was truncated before any complete wiki file was produced."
    activity.updateItem(activityId, { status: "error", detail: message })
    throw new Error(message)
  }
  if (
    previouslyCompletedPaths.length > 0 &&
    !resumeConfirmedComplete &&
    parsedGeneration.blocks.length === 0
  ) {
    const message = "Generation resume returned no complete wiki file and did not confirm completion."
    activity.updateItem(activityId, { status: "error", detail: message })
    throw new Error(message)
  }
  throwIfIngestAborted(signal, activityId)

  let reviewSuggestionOutput = ""
  if (!generationError && !generationTruncated && !signal?.aborted && shouldRunDedicatedReviewStage(generation)) {
    let reviewStageHadError = false
    try {
      await streamChat(
        llmConfig,
        [
          {
            role: "system",
            content: buildReviewSuggestionPrompt(
              purpose,
              index,
              sourceIdentity,
              analysis,
              sourceContext,
              generation,
              llmConfig.maxContextSize,
            ),
          },
          {
            role: "user",
            content: "Emit only high-value REVIEW blocks for follow-up research or unresolved knowledge gaps. Output nothing if there are none.",
          },
        ],
        {
          onToken: (token) => { reviewSuggestionOutput += token },
          onDone: () => {},
          onError: (err) => {
            reviewStageHadError = true
            console.warn(`[ingest] Review suggestion generation failed for "${sourceIdentity}": ${err.message}`)
          },
        },
        signal,
        {
          temperature: 0.1,
          reasoning: resolveIngestReasoning(llmConfig),
          max_tokens: computeIngestReviewMaxTokens(llmConfig.maxContextSize),
        },
      )
    } catch (err) {
      throwIfIngestAborted(signal, activityId)
      console.warn(`[ingest] Review suggestion generation failed for "${sourceIdentity}":`, err)
    }
    throwIfIngestAborted(signal, activityId)
    if (reviewStageHadError) reviewSuggestionOutput = ""
  }

  // ── Step 3: Write files ───────────────────────────────────────
  return runCommit(async () => {
  throwIfIngestAborted(signal, activityId)
  activity.updateItem(activityId, { detail: "Writing files..." })
  await migrateLegacySourceSummaryIfSafe(pp, sourceIdentity, sourceSummaryPath)
  const writeResult = await writeFileBlocks(
    pp,
    generation,
    llmConfig,
    sourceIdentity,
    sourceSummaryPath,
    signal,
    activityId,
    onFileWritten,
  )
  throwIfIngestAborted(signal, activityId)
  const writtenPaths = uniqueNormalizedPaths([
    ...previouslyCompletedPaths,
    ...writeResult.writtenPaths,
  ])
  const writeWarnings = writeResult.warnings
  const hardFailures = writeResult.hardFailures
  let unrecoveredTruncatedPaths = uniqueNormalizedPaths(
    writeResult.truncatedPaths.filter((path) =>
      !writtenPaths.some((writtenPath) => normalizePath(writtenPath) === normalizePath(path))
    ),
  )

  if (unrecoveredTruncatedPaths.length > 0 && !signal?.aborted) {
    activity.updateItem(activityId, {
      detail: `Retrying truncated wiki files: ${unrecoveredTruncatedPaths.join(", ")}`,
    })
    let repairOutput = ""
    let repairFailed = false
    try {
      await streamChat(
        llmConfig,
        [
          {
            role: "system",
            content: buildTruncatedFileRepairPrompt(
              unrecoveredTruncatedPaths,
              sourceIdentity,
              {
                schema,
                purpose,
                analysis,
                sourceContext,
                maxContextSize: llmConfig.maxContextSize,
              },
            ),
          },
          {
            role: "user",
            content: "Regenerate the requested FILE blocks now. Start immediately with `---FILE:`.",
          },
        ],
        {
          onToken: (token) => { repairOutput += token },
          onDone: () => {},
          onError: (err) => {
            repairFailed = true
            writeWarnings.push(`Truncated FILE repair failed: ${err.message}`)
          },
        },
        signal,
        {
          temperature: 0.1,
          reasoning: resolveIngestReasoning(llmConfig),
          // A repair must regenerate the complete FILE body. Reusing the
          // smaller review budget can immediately truncate the same long page
          // that exhausted the original response.
          max_tokens: computeIngestGenerationMaxTokens(llmConfig.maxContextSize),
        },
      )
      throwIfIngestAborted(signal, activityId)

      if (!repairFailed && repairOutput.trim()) {
        const filteredRepair = filterTruncatedFileRepairOutput(
          repairOutput,
          unrecoveredTruncatedPaths,
        )
        writeWarnings.push(...filteredRepair.warnings)
        const repairResult = await writeFileBlocks(
          pp,
          filteredRepair.text,
          llmConfig,
          sourceIdentity,
          sourceSummaryPath,
          signal,
          activityId,
          onFileWritten,
        )
        // Match successful writes against the paths requested from the model,
        // not the final on-disk paths. writeFileBlocks may legitimately rewrite
        // a title-derived filename for the selected output language.
        const completedInputPathKeys = new Set(
          repairResult.completedInputPaths.map(normalizePath),
        )
        const recoveredPaths = filteredRepair.paths.filter((path) =>
          completedInputPathKeys.has(normalizePath(path)),
        )
        for (const path of repairResult.writtenPaths) {
          if (!writtenPaths.some((writtenPath) => normalizePath(writtenPath) === normalizePath(path))) {
            writtenPaths.push(path)
          }
        }
        for (const path of recoveredPaths) {
          const warningPrefix = `FILE block "${path}" was not closed before end of stream`
          for (let i = writeWarnings.length - 1; i >= 0; i--) {
            if (writeWarnings[i].startsWith(warningPrefix)) writeWarnings.splice(i, 1)
          }
        }
        writeWarnings.push(...repairResult.warnings)
        hardFailures.push(...repairResult.hardFailures)
        const recoveredPathKeys = new Set(recoveredPaths.map(normalizePath))
        unrecoveredTruncatedPaths = unrecoveredTruncatedPaths.filter((path) =>
          !recoveredPathKeys.has(normalizePath(path))
        )
      }
    } catch (err) {
      throwIfIngestAborted(signal, activityId)
      writeWarnings.push(
        `Truncated FILE repair failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  try {
    if (await updateWikiIndexDeterministically(pp, writtenPaths)) {
      writtenPaths.push("wiki/index.md")
      onFileWritten?.("wiki/index.md")
    }
  } catch (err) {
    writeWarnings.push(
      `Deterministic index update failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // log.md is append-only structural metadata. If the model omitted its FILE
  // block, write a deterministic entry instead of starting another LLM turn.
  // This keeps multi-file imports at two generation stages per source and
  // prevents a slow provider from making the queue appear stuck in "repair".
  if (!writtenPaths.some((path) => normalizePath(path).toLowerCase() === "wiki/log.md") && !signal?.aborted) {
    try {
      const logPath = `${pp}/wiki/log.md`
      const existingLog = await tryReadFile(logPath)
      await writeFile(logPath, buildDeterministicIngestLog(existingLog, sourceIdentity))
      writtenPaths.push("wiki/log.md")
      onFileWritten?.("wiki/log.md")
    } catch (err) {
      writeWarnings.push(
        `Deterministic log update failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // Surface parser / writer warnings to the activity panel so users
  // don't have to open devtools to find out a block was dropped.
  // Keeping the base "Writing files..." detail on top and appending the
  // first few warnings; full list is also persisted to .llm-wiki.
  let warningSummary = ""
  if (writeWarnings.length > 0) {
    await appendIngestWarningLog(pp, sourceIdentity, writeWarnings)
    warningSummary = writeWarnings.length === 1
      ? writeWarnings[0]
      : `${writeWarnings.length} ingest warnings: ${writeWarnings.slice(0, 2).join(" · ")}${writeWarnings.length > 2 ? ` … (+${writeWarnings.length - 2} more in .llm-wiki/ingest-warnings.log)` : ""}`
    activity.updateItem(activityId, { detail: `${warningSummary} — saved to .llm-wiki/ingest-warnings.log` })
  }

  // Ensure source summary page exists (LLM may not have generated it correctly)
  const sourceSummaryFullPath = `${pp}/${sourceSummaryPath}`
  const hasSourceSummary = writtenPaths.some((p) => normalizePath(p) === sourceSummaryPath)

  // If the signal was aborted (e.g. user switched projects / cancelled),
  // skip the fallback summary write — the LLM streams returned empty
  // via the abort fast-path (onDone), and writing a stub file into the
  // old project's wiki would both be noise and mask the error.
  // Returning no files lets processNext's length-0 safety net mark the
  // task for retry rather than "success".
  if (!hasSourceSummary && !signal?.aborted) {
    const date = new Date().toISOString().slice(0, 10)
    const fallbackContent = buildFallbackSourceSummary(sourceIdentity, analysis, date)
    try {
      await writeFile(sourceSummaryFullPath, fallbackContent)
      writtenPaths.push(sourceSummaryPath)
      onFileWritten?.(sourceSummaryPath)
    } catch {
      // non-critical
    }
  }

  // ── Step 3.5: Append extracted images to the source-summary page ─
  // Skipped when the master toggle is off — see Step 0.6 above for
  // the full rationale. With captioning disabled we also don't
  // want the safety-net section to slip image refs into the wiki
  // through the back door.
  if (mmCfg.enabled && savedImages.length > 0 && !signal?.aborted) {
    await injectImagesIntoSourceSummary(
      pp,
      sourceIdentity,
      sourceSummarySlug,
      savedImages,
      getLanguagePromptName(getOutputLanguage(sourceContent)),
    )
  }

  if (writtenPaths.length > 0) {
    try {
      await refreshProjectFileTree(pp, { bumpDataVersion: true })
    } catch {
      // ignore
    }
  }

  // A partial write is not a successful ingest. Keep the generated files on
  // disk so a retry can merge/repair them, but do not cache or embed the
  // incomplete result. Throwing here keeps the queue task visible as
  // pending/failed instead of removing it as "done" while Sources reports the
  // same file as not ingested.
  const resumeProducedNoValidFiles = previouslyCompletedPaths.length > 0 &&
    !resumeConfirmedComplete &&
    writeResult.writtenPaths.length === 0
  const generationIncomplete = Boolean(generationError) ||
    generationTruncated ||
    resumeProducedNoValidFiles
  if (generationIncomplete && writtenPaths.length > 0) {
    try {
      await saveGenerationCheckpoint(generationProgressPath, {
        version: 1,
        sourceIdentity,
        sourceFingerprint: generationFingerprint,
        completedPaths: writtenPaths.filter((path) => !isAppManagedAggregatePath(path)),
        updatedAt: Date.now(),
      })
    } catch (err) {
      hardFailures.push(
        `Generation checkpoint write failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  if (hardFailures.length > 0 || unrecoveredTruncatedPaths.length > 0 || generationIncomplete) {
    const reasons = [
      generationError ? `generation stream failed: ${generationError}` : "",
      generationTruncated ? "generation reached its output limit" : "",
      resumeProducedNoValidFiles ? "generation resume produced no valid wiki files" : "",
      hardFailures.length > 0
        ? `${hardFailures.length} wiki file write failure(s)`
        : "",
      unrecoveredTruncatedPaths.length > 0
        ? `${unrecoveredTruncatedPaths.length} truncated wiki file(s) could not be repaired: ${unrecoveredTruncatedPaths.join(", ")}`
        : "",
    ].filter(Boolean)
    const message = `Ingest incomplete: ${reasons.join("; ")}`
    activity.updateItem(activityId, {
      status: "error",
      detail: warningSummary
        ? `${message} — ${warningSummary} (saved to .llm-wiki/ingest-warnings.log)`
        : message,
      filesWritten: writtenPaths,
    })
    throw new Error(message)
  }

  // ── Step 4: Parse review items ────────────────────────────────
  // Do this only after the completeness gate above. Otherwise every queue
  // retry could duplicate review items derived from the same partial output.
  throwIfIngestAborted(signal, activityId)
  const reviewItems = [
    ...parseReviewBlocks(generation, sp),
    ...parseReviewBlocks(reviewSuggestionOutput, sp),
  ]
  if (reviewItems.length > 0) {
    useReviewStore.getState().addItems(reviewItems)
  }

  // ── Step 5: Save to cache ───────────────────────────────────
  // Skip cache when a write fails or a truncated path remains unrecovered;
  // otherwise the partial result would be replayed without another LLM turn.
  if (
    writtenPaths.length > 0 &&
    hardFailures.length === 0 &&
    unrecoveredTruncatedPaths.length === 0
  ) {
    await saveIngestCache(pp, sourceIdentity, sourceContent, writtenPaths)
    await clearGenerationCheckpoint(generationProgressPath)
    if (longSourceCheckpointPath) {
      await clearLongSourceCheckpoint(longSourceCheckpointPath)
    }
  } else if (hardFailures.length > 0 || unrecoveredTruncatedPaths.length > 0) {
    console.warn(
      `[ingest] Skipping cache save for "${sourceIdentity}" — ${hardFailures.length} write failure(s), ${unrecoveredTruncatedPaths.length} truncated FILE block(s) still missing.`,
    )
  }

  // ── Step 6: Generate embeddings (if enabled) ───────────────
  const embCfg = useWikiStore.getState().embeddingConfig
  if (embCfg.enabled && embCfg.model && writtenPaths.length > 0) {
    try {
      const { embedPage, wikiPageIdFromPath } = await import("@/lib/embedding")
      for (const wpath of writtenPaths) {
        const pageId = wikiPageIdFromPath(pp, wpath)
        const pageStem = wpath.split("/").pop()?.replace(/\.md$/, "") ?? ""
        if (!pageId || ["index", "log", "overview"].includes(pageStem)) continue
        try {
          const content = await readFile(`${pp}/${wpath}`)
          const fmTitle = parseFrontmatter(content).frontmatter?.title
          const title = typeof fmTitle === "string" && fmTitle.trim() ? fmTitle.trim() : pageId
          await embedPage(pp, pageId, title, content, embCfg)
        } catch {
          // non-critical
        }
      }
    } catch {
      // embedding module not available
    }
  }

  const baseDetail = writtenPaths.length > 0
    ? `${writtenPaths.length} files written${reviewItems.length > 0 ? `, ${reviewItems.length} review item(s)` : ""}`
    : "No files generated"
  const detail = warningSummary
    ? `${baseDetail} — ${warningSummary} (saved to .llm-wiki/ingest-warnings.log)`
    : baseDetail

  activity.updateItem(activityId, {
    status: writtenPaths.length > 0 ? "done" : "error",
    detail,
    filesWritten: writtenPaths,
  })

  return writtenPaths
  })
}

async function updateWikiIndexDeterministically(
  projectPath: string,
  writtenPaths: string[],
): Promise<boolean> {
  const candidates = Array.from(new Set(writtenPaths.map(normalizePath))).filter((path) =>
    path.startsWith("wiki/")
      && path.endsWith(".md")
      && !AGGREGATE_WIKI_PATHS.includes(path as (typeof AGGREGATE_WIKI_PATHS)[number]),
  )
  if (candidates.length === 0) return false

  const indexPath = `${projectPath}/wiki/index.md`
  const index = await readFile(indexPath).catch(() => "# Wiki Index\n")
  const knownTargets = new Set(
    Array.from(index.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g))
      .map((match) => normalizeIndexTarget(match[1])),
  )
  const additions: string[] = []
  for (const path of candidates) {
    const target = path.replace(/^wiki\//, "").replace(/\.md$/i, "")
    if (knownTargets.has(normalizeIndexTarget(target))) continue
    const content = await readFile(`${projectPath}/${path}`).catch(() => "")
    const parsed = parseFrontmatter(content)
    const title = typeof parsed.frontmatter?.title === "string"
      ? parsed.frontmatter.title.trim()
      : getFileName(path).replace(/\.md$/i, "")
    additions.push(`- [[${target}]] — ${title}`)
  }
  if (additions.length === 0) return false

  await writeFile(indexPath, updateBoundedRecentIndexSection(index, additions))
  return true
}

function normalizeIndexTarget(target: string): string {
  return normalizePath(target)
    .replace(/^wiki\//i, "")
    .replace(/\.md$/i, "")
    .toLowerCase()
}

export function updateBoundedRecentIndexSection(index: string, additions: string[]): string {
  const section = "## Recently Updated"
  const lines = index.trimEnd().split("\n")
  const start = lines.findIndex((line) => line.trim() === section)
  const prefix = start >= 0 ? lines.slice(0, start) : lines
  const sectionEnd = start >= 0
    ? lines.findIndex((line, position) => position > start && /^##\s+/.test(line))
    : -1
  const existing = start >= 0
    ? lines.slice(start + 1, sectionEnd >= 0 ? sectionEnd : undefined).filter((line) => /^-\s+/.test(line))
    : []
  const suffix = sectionEnd >= 0 ? lines.slice(sectionEnd) : []
  const recent = Array.from(new Set([...additions, ...existing])).slice(0, 200)
  return [...prefix, "", section, ...recent, ...(suffix.length ? ["", ...suffix] : []), ""].join("\n")
}

function isValidSourceReference(source: string, activeSourceIdentity: string): boolean {
  const normalized = normalizePath(source).replace(/^(?:\.\/)+/, "")
  const key = normalized.toLowerCase()
  const identityKey = normalizePath(activeSourceIdentity).toLowerCase()
  if (!normalized || normalized.startsWith("/") || /^[a-z]:\//i.test(normalized)) return false
  if (normalized.split("/").some((part) => part === "..")) return false
  if (sourceReferenceIdentity(normalized).toLowerCase() === identityKey) return true
  if (["wiki/index.md", "wiki/overview.md", "wiki/log.md"].includes(key)) return false
  if (key === ".llm-wiki" || key.startsWith(".llm-wiki/")) return false
  return true
}

export function canonicalizeSourcesField(content: string, sourceIdentity: string): string {
  if (!/^---\n/.test(content)) return content

  const identityKey = normalizePath(sourceIdentity).toLowerCase()
  const identityBaseName = getFileName(sourceIdentity).toLowerCase()
  const sourceValues = parseSources(content)
  const canonicalValues = sourceValues.filter((source) =>
    isValidSourceReference(source, sourceIdentity)
  ).map((source) => {
    const normalized = sourceReferenceIdentity(source)
    const key = normalized.toLowerCase()
    if (key === identityKey) return sourceIdentity
    if (!normalized.includes("/") && key === identityBaseName) return sourceIdentity
    return normalized
  })
  if (!canonicalValues.some((source) => normalizePath(source).toLowerCase() === identityKey)) {
    canonicalValues.push(sourceIdentity)
  }

  const seen = new Set<string>()
  const deduped = canonicalValues.filter((source) => {
    const key = normalizePath(source).toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return writeSources(content, deduped)
}

async function migrateLegacySourceSummaryIfSafe(
  projectPath: string,
  sourceIdentity: string,
  sourceSummaryPath: string,
): Promise<void> {
  const normalizedIdentity = normalizePath(sourceIdentity)
  if (!normalizedIdentity.includes("/")) return

  if (await migrateExactLegacySourceSummaryIfSafe(projectPath, normalizedIdentity, sourceSummaryPath)) {
    return
  }

  const basename = getFileName(normalizedIdentity)
  const legacySlug = basename.replace(/\.[^.]+$/, "")
  const legacyPath = `wiki/sources/${legacySlug}.md`
  if (legacyPath === sourceSummaryPath) return

  const pp = normalizePath(projectPath)
  const legacyFullPath = `${pp}/${legacyPath}`
  const canonicalFullPath = `${pp}/${sourceSummaryPath}`

  const matchingIdentities = await matchingRawSourceIdentitiesForBasename(pp, basename)
  const normalizedIdentityKey = normalizedIdentity.toLowerCase()
  if (
    matchingIdentities.length !== 1 ||
    normalizePath(matchingIdentities[0]).toLowerCase() !== normalizedIdentityKey
  ) {
    return
  }

  try {
    if (await fileExists(canonicalFullPath)) return
    if (await fileExists(`${pp}/raw/sources/${basename}`)) return
  } catch {
    return
  }

  const legacyContent = await tryReadFile(legacyFullPath)
  if (!legacyContent) return

  const sources = parseSources(legacyContent)
  const basenameKey = basename.toLowerCase()
  const legacyOnlyReferencesBasename =
    sources.length > 0 &&
    sources.every(
      (source) =>
        !normalizePath(source).includes("/") &&
        getFileName(source).toLowerCase() === basenameKey,
    )
  if (!legacyOnlyReferencesBasename) return

  try {
    await writeFile(canonicalFullPath, canonicalizeSourcesField(legacyContent, sourceIdentity))
    await deleteFile(legacyFullPath)
  } catch (err) {
    console.warn(
      `[ingest] failed to migrate legacy source summary ${legacyPath} -> ${sourceSummaryPath}:`,
      err instanceof Error ? err.message : err,
    )
  }
}

async function migrateExactLegacySourceSummaryIfSafe(
  projectPath: string,
  sourceIdentity: string,
  sourceSummaryPath: string,
): Promise<boolean> {
  const pp = normalizePath(projectPath)
  const canonicalFullPath = `${pp}/${sourceSummaryPath}`
  let canonicalExists = false
  try {
    canonicalExists = await fileExists(canonicalFullPath)
  } catch {
    return false
  }
  if (canonicalExists) return false

  const sourceKey = normalizePath(sourceIdentity).toLowerCase()
  const legacyPaths = sourceSummarySlugCandidatesFromIdentity(sourceIdentity)
    .map((slug) => `wiki/sources/${slug}.md`)
    .filter((path) => path !== sourceSummaryPath)

  for (const legacyPath of legacyPaths) {
    const legacyFullPath = `${pp}/${legacyPath}`
    let legacyContent = ""
    try {
      if (!(await fileExists(legacyFullPath))) continue
      legacyContent = await readFile(legacyFullPath)
    } catch {
      continue
    }

    const sources = parseSources(legacyContent)
    const referencesSameSource = sources.some(
      (source) => normalizePath(source).toLowerCase() === sourceKey,
    )
    if (!referencesSameSource) continue

    try {
      await writeFile(canonicalFullPath, canonicalizeSourcesField(legacyContent, sourceIdentity))
      await deleteFile(legacyFullPath)
      return true
    } catch (err) {
      console.warn(
        `[ingest] failed to migrate legacy source summary ${legacyPath} -> ${sourceSummaryPath}:`,
        err instanceof Error ? err.message : err,
      )
      return false
    }
  }

  return false
}

async function matchingRawSourceIdentitiesForBasename(
  projectPath: string,
  basename: string,
): Promise<string[]> {
  const rawRoot = `${projectPath}/raw/sources`
  let nodes: FileNode[]
  try {
    nodes = await listDirectory(rawRoot)
  } catch {
    return []
  }

  const rootPrefix = `${normalizePath(rawRoot).replace(/\/+$/, "")}/`
  const rootPrefixKey = rootPrefix.toLowerCase()
  const basenameKey = basename.toLowerCase()
  const matches: string[] = []

  const visit = (items: FileNode[]) => {
    for (const item of items) {
      if (item.is_dir) {
        if (item.children) visit(item.children)
        continue
      }
      const normalizedPath = normalizePath(item.path)
      if (
        getFileName(normalizedPath).toLowerCase() === basenameKey &&
        normalizedPath.toLowerCase().startsWith(rootPrefixKey)
      ) {
        matches.push(normalizedPath.slice(rootPrefix.length))
      }
    }
  }

  visit(nodes)
  return matches
}

export function currentWikiDate(now: Date = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

export function buildFallbackSourceSummary(
  sourceIdentity: string,
  analysis: string,
  date: string,
): string {
  return [
    "---",
    "type: source",
    `title: "Source: ${sourceIdentity}"`,
    `created: ${date}`,
    `updated: ${date}`,
    `sources: ["${sourceIdentity}"]`,
    "tags: []",
    "related: []",
    "---",
    "",
    `# Source: ${sourceIdentity}`,
    "",
    // This is a recovery page, so preserving the complete analysis matters
    // more than keeping the page short. Truncating here used to create
    // syntactically valid but silently incomplete source summaries.
    analysis || "(Analysis not available)",
    "",
  ].join("\n")
}

export function stampGeneratedFrontmatterDates(content: string, date: string): string {
  const fmRe = /^(---\s*\r?\n)([\s\S]*?)(\r?\n---\s*(?:\r?\n|$))/
  const match = content.match(fmRe)
  if (!match) return content

  let payload = match[2]
  payload = setOrAppendFrontmatterDate(payload, "created", date)
  payload = setOrAppendFrontmatterDate(payload, "updated", date)
  return `${match[1]}${payload}${match[3]}${content.slice(match[0].length)}`
}

export function stampGeneratedLogDate(content: string, date: string): string {
  const normalized = content.replace(/\bYYYY-MM-DD\b/g, date)
  if (/^\s*##\s*\[?\d{4}-\d{2}-\d{2}\]?/m.test(normalized)) {
    return normalized.replace(
      /^(\s*##\s*\[?)\d{4}-\d{2}-\d{2}(\]?)/m,
      `$1${date}$2`,
    )
  }
  return normalized
}

function setOrAppendFrontmatterDate(payload: string, key: "created" | "updated", date: string): string {
  const lineRe = new RegExp(`(^|\\n)(${key}\\s*:\\s*)[^\\n\\r]*`, "i")
  if (lineRe.test(payload)) {
    return payload.replace(lineRe, (_match, prefix: string, label: string) => `${prefix}${label}${date}`)
  }
  return `${payload.trimEnd()}\n${key}: ${date}`
}

async function writeFileBlocks(
  projectPath: string,
  text: string,
  llmConfig: LlmConfig,
  sourceFileName: string,
  sourceSummaryPath?: string,
  signal?: AbortSignal,
  activityId?: string,
  onFileWritten?: (relativePath: string) => void,
): Promise<{
  writtenPaths: string[]
  completedInputPaths: string[]
  warnings: string[]
  hardFailures: string[]
  truncatedPaths: string[]
}> {
  const { blocks, warnings: parseWarnings, truncatedPaths } = parseFileBlocks(text)
  const warnings = [...parseWarnings]
  const writtenPaths: string[] = []
  // Keep the model-requested path separate from the final path. Path
  // canonicalization may rename the file after parsing, but callers that
  // repair a specific FILE block still need to know that request succeeded.
  const completedInputPaths: string[] = []
  // "Hard failures" = blocks we INTENDED to write but the FS rejected
  // (disk full, permission, OS-level errors). Distinct from soft drops
  // (language mismatch, parse warnings, path-traversal rejections):
  // those represent intentional content-level decisions, while hard
  // failures are unexpected losses. The autoIngest cache layer keys
  // off this list — any hard failure means the cache entry must NOT
  // be written, so the next re-ingest goes through the full pipeline
  // instead of replaying the partial result forever.
  const hardFailures: string[] = []
  const projectSchemaRouting = await loadProjectWikiSchemaRouting(projectPath)

  const targetLang = useWikiStore.getState().outputLanguage
  const today = currentWikiDate()

  for (const { path: rawRelativePath, content: rawContent } of blocks) {
    throwIfIngestAborted(signal, activityId)
    let relativePath = rawRelativePath
    if (sourceSummaryPath && relativePath.startsWith("wiki/sources/")) {
      relativePath = sourceSummaryPath
    }
    if (isAppManagedAggregatePath(relativePath)) {
      warnings.push(
        `Ignored model-generated "${relativePath}"; aggregate navigation is maintained by the application.`,
      )
      continue
    }

    // Sanitize at the boundary — strip stray code-fence wrappers,
    // `frontmatter:` prefixes, and repair invalid wikilink-list
    // YAML lines so the file we write is canonical regardless of
    // what shape the model emitted. See `ingest-sanitize.ts` for
    // the recurring corruption shapes this fixes; without this
    // step ~45% of generated entity pages went to disk with
    // unparseable frontmatter and the read-time fallback had to
    // paper over it forever.
    let content = sanitizeIngestedFileContent(rawContent)
    if (isLogPath(relativePath)) {
      content = stampGeneratedLogDate(content, today)
    } else if (!isListingPath(relativePath)) {
      content = stampGeneratedFrontmatterDates(content, today)
    }
    if (!isLogPath(relativePath) && !isListingPath(relativePath)) {
      content = canonicalizeSourcesField(content, sourceFileName)
    }
    if (sourceSummaryPath && relativePath === sourceSummaryPath) {
      content = sourceSummaryMediaRefsForExternalMarkdown(content)
    }
    relativePath = rewriteIngestPathFromTitleForTargetLanguage(relativePath, content, targetLang)

    if (
      projectSchemaRouting &&
      !isLogPath(relativePath) &&
      !isListingPath(relativePath)
    ) {
      const correction = correctWikiPageRouting(
        relativePath,
        content,
        projectSchemaRouting,
      )
      if (correction.message) {
        if (!isSafeIngestPath(correction.path)) {
          const msg = `Dropped "${relativePath}" — corrected schema path was unsafe.`
          console.warn(`[ingest] ${msg}`)
          warnings.push(msg)
          continue
        }
        console.info(`[ingest] ${correction.message}`)
        warnings.push(correction.message)
        relativePath = correction.path
      }
      const routingIssue = validateWikiPageRouting(relativePath, content, projectSchemaRouting)
      if (routingIssue) {
        const msg = `Dropped "${relativePath}" — ${routingIssue.message}`
        console.warn(`[ingest] ${msg}`)
        warnings.push(msg)
        continue
      }
    }

    // Language guard: reject individual FILE blocks whose body contradicts
    // the user-set target language. Skip:
    // - log.md (structural, short)
    // - /sources/ and /entities/ pages: these legitimately cite cross-
    //   language proper nouns (a German philosophy source summary naturally
    //   quotes Russian philosophers) which confuses naive script-based
    //   detection. Keep the check for /concepts/ pages, which should be
    //   authoritative content in the target language.
    const isLog = isLogPath(relativePath)
    const isEntityOrSource =
      relativePath.startsWith("wiki/entities/") ||
      relativePath.includes("/entities/") ||
      relativePath.startsWith("wiki/sources/") ||
      relativePath.includes("/sources/")
    if (
      targetLang &&
      targetLang !== "auto" &&
      !isLog &&
      !isEntityOrSource &&
      !contentMatchesTargetLanguage(content, targetLang)
    ) {
      const msg = `Dropped "${relativePath}" — body language doesn't match target ${targetLang}.`
      console.warn(`[ingest] ${msg}`)
      warnings.push(msg)
      continue
    }

    const fullPath = `${projectPath}/${relativePath}`
    try {
      if (isLogPath(relativePath)) {
        const existing = await tryReadFile(fullPath)
        const appended = existing ? `${existing}\n\n${content.trim()}` : content.trim()
        await writeFile(fullPath, appended)
      } else if (
        isListingPath(relativePath)
      ) {
        // Listing pages (index / overview) are always overwritten
        // wholesale — their sources field is incidental and merging
        // wouldn't make semantic sense (they aren't source-derived
        // content pages).
        await writeFile(fullPath, content)
      } else {
        // Content pages (entities / concepts / queries / synthesis /
        // comparisons / sources summaries): if a page with this
        // path already exists on disk, merge old + new instead of
        // clobbering. The merge has three layers:
        //   1. Frontmatter array fields (sources, tags, related)
        //      are union-merged at the application layer.
        //   2. If body content differs, an LLM call produces a
        //      coherent merged body — preserves contributions from
        //      every source document.
        //   3. Locked frontmatter fields (type, title, created)
        //      are forced back to the existing values; updated is
        //      stamped today.
        // LLM failure / sanity rejection falls back to "incoming
        // body + array-field union" with a best-effort backup.
        // See page-merge.ts.
        const existing = await tryReadFile(fullPath)
        // Re-ingesting a corrected source must replace pages owned solely by
        // that source. Merging the old body back into the new generation kept
        // retracted wording alive indefinitely. Multi-source pages still use
        // the merger because their other sources' contributions must survive.
        const replaceExistingBody = Boolean(
          existing && isOwnedOnlyBySource(existing, sourceFileName),
        )
        const merged = await mergePageContent(
          content,
          existing || null,
          buildPageMerger(llmConfig),
          {
            sourceFileName,
            pagePath: relativePath,
            signal,
            backup: (oldContent) => backupExistingPage(projectPath, relativePath, oldContent),
            replaceExistingBody,
          },
        )
        // The merge unions existing frontmatter arrays, so sanitize again to
        // remove legacy/generated paths that may already be stored on disk.
        const toWrite = canonicalizeSourcesField(merged, sourceFileName)
        await writeFile(fullPath, toWrite)
      }
      writtenPaths.push(relativePath)
      completedInputPaths.push(rawRelativePath)
      onFileWritten?.(relativePath)
    } catch (err) {
      const msg = `Failed to write "${relativePath}": ${err instanceof Error ? err.message : String(err)}`
      console.error(`[ingest] ${msg}`)
      warnings.push(msg)
      hardFailures.push(relativePath)
    }
  }

  return {
    writtenPaths,
    completedInputPaths,
    warnings,
    hardFailures,
    truncatedPaths,
  }
}

function isOwnedOnlyBySource(content: string, sourceIdentity: string): boolean {
  const sources = parseSources(content)
  if (sources.length === 0) return false
  const expected = sourceReferenceIdentity(sourceIdentity).toLowerCase()
  return sources.every(
    (source) => sourceReferenceIdentity(source).toLowerCase() === expected,
  )
}

function uniqueNormalizedPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  return paths.filter((path) => {
    const key = normalizePath(path)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function getStore() {
  return useChatStore.getState()
}

async function tryReadFile(path: string): Promise<string> {
  try {
    return await readFile(path)
  } catch {
    return ""
  }
}

async function tryReadSourceTextFile(path: string): Promise<string> {
  try {
    return await readFile(path, { extractImages: false })
  } catch {
    return ""
  }
}

async function backupExistingPage(
  projectPath: string,
  relativePath: string,
  existingContent: string,
): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const sanitized = relativePath.replace(/[/\\]/g, "_")
  const backupPath = `${projectPath}/.llm-wiki/page-history/${sanitized}-${stamp}`
  await writeFile(backupPath, existingContent)
}

async function injectImagesIntoSourceSummary(
  pp: string,
  sourceIdentity: string,
  sourceSummarySlug: string,
  savedImages: { relPath: string; page: number | null; sha256?: string }[],
  outputLanguage?: string,
): Promise<void> {
  if (savedImages.length === 0) return
  const sourceSummaryPath = `wiki/sources/${sourceSummarySlug}.md`
  const sourceSummaryFullPath = `${pp}/${sourceSummaryPath}`
  console.log(`[ingest:diag] injectImagesIntoSourceSummary: target=${sourceSummaryFullPath}, images=${savedImages.length}`)
  try {
    const existing = await tryReadFile(sourceSummaryFullPath)
    console.log(`[ingest:diag] injectImagesIntoSourceSummary: existing file ${existing ? `read OK (${existing.length} chars)` : "MISSING (will write stub)"}`)
    // Load captions from the on-disk cache so the safety-net
    // section embeds caption text as alt — the embedding pipeline
    // indexes whatever's in the wiki page, so without this, search
    // by image content (e.g. "find the chart with revenue data")
    // never matches because alt text was empty.
    const captionsBySha = await loadCaptionCache(pp, outputLanguage)
    const newSection = buildImageMarkdownSection(
      savedImages.map((img) => ({
        ...img,
        relPath: toSourceSummaryImageRef(img.relPath),
      })) as never,
      captionsBySha,
    )
    const marker = "<!-- llm-wiki:embedded-images -->"
    const wrapped = `\n\n${marker}\n${newSection.trim()}\n${marker}\n`
    if (existing) {
      // Strip any prior injection (paired markers) so re-ingest
      // doesn't accumulate stale references when images change.
      const stripped = existing.replace(
        new RegExp(`\\n*${marker}[\\s\\S]*?${marker}\\n*`, "g"),
        "",
      )
      await writeFile(sourceSummaryFullPath, stripped.trimEnd() + wrapped)
    } else {
      // Page is missing — write a minimal stub so the user actually
      // sees the images in the file tree. Without this fallback, the
      // images sit in wiki/media/<slug>/ with no .md page referencing
      // them, which means the lint view's orphan-page sweep eventually
      // reaps the media directory (cascadeDeleteWikiPage triggered by
      // a missing source page) — silent loss of extracted images.
      const date = new Date().toISOString().slice(0, 10)
      const stubFrontmatter = [
        "---",
        "type: source",
        `title: "Source: ${sourceIdentity}"`,
        `created: ${date}`,
        `updated: ${date}`,
        `sources: ["${sourceIdentity}"]`,
        "tags: []",
        "related: []",
        "---",
        "",
        `# Source: ${sourceIdentity}`,
        "",
      ].join("\n")
      await writeFile(sourceSummaryFullPath, stubFrontmatter + wrapped)
    }
    console.log(
      `[ingest:images] injected ${savedImages.length} image reference(s) into ${sourceSummaryPath}`,
    )
  } catch (err) {
    console.warn(
      `[ingest:images] failed to append images to ${sourceSummaryPath}:`,
      err instanceof Error ? err.message : err,
    )
  }
}

async function reembedSourceSummary(
  pp: string,
  sourceIdentity: string,
  sourceSummarySlug: string,
): Promise<void> {
  const embCfg = useWikiStore.getState().embeddingConfig
  if (!embCfg.enabled || !embCfg.model) return
  const sourceSummaryFullPath = `${pp}/wiki/sources/${sourceSummarySlug}.md`
  try {
    const content = await readFile(sourceSummaryFullPath)
    const fmTitle = parseFrontmatter(content).frontmatter?.title
    const title = typeof fmTitle === "string" && fmTitle.trim() ? fmTitle.trim() : sourceIdentity
    const { embedPage, wikiPageIdFromPath } = await import("@/lib/embedding")
    await embedPage(
      pp,
      wikiPageIdFromPath(pp, sourceSummaryFullPath),
      title,
      content,
      embCfg,
    )
    console.log(`[ingest:caption] re-embedded ${sourceSummarySlug} with captioned alt text`)
  } catch (err) {
    console.warn(
      `[ingest:caption] re-embed failed for ${sourceSummarySlug}:`,
      err instanceof Error ? err.message : err,
    )
  }
}

export async function startIngest(
  projectPath: string,
  sourcePath: string,
  llmConfig: LlmConfig,
  signal?: AbortSignal,
): Promise<void> {
  const pp = normalizePath(projectPath)
  const sp = normalizePath(sourcePath)
  const sourceIdentity = sourceIdentityForPath(pp, sp)
  const sourceSummarySlug = sourceSummarySlugFromIdentity(sourceIdentity)
  const store = getStore()
  store.setMode("ingest")
  store.setIngestSource(sp)
  store.clearMessages()
  store.setStreaming(false)

  // Extract embedded images upfront — independent of the LLM call
  // that follows. Done eagerly here (rather than in
  // `executeIngestWrites`) so the images are on disk before the user
  // even sees the analysis stream, and the cost is only paid once
  // per source: a follow-up `executeIngestWrites` will reuse the
  // already-extracted set rather than re-running pdfium.
  // Failure-tolerant — `extractAndSaveSourceImages` returns [] on
  // any error and logs internally; we never want image extraction
  // to break the ingest chat flow.
  void extractSourceImagesOnce(pp, sp, sourceSummarySlug).catch((err: unknown) => {
    console.warn(
      `[startIngest:images] eager extraction failed for "${getFileName(sp)}":`,
      err instanceof Error ? err.message : err,
    )
  })

  const [sourceContent, schema, purpose, index] = await Promise.all([
    tryReadSourceTextFile(sp),
    tryReadFile(`${pp}/wiki/schema.md`),
    tryReadFile(`${pp}/wiki/purpose.md`),
    tryReadFile(`${pp}/wiki/index.md`),
  ])

  const systemPrompt = [
    "You are a knowledgeable assistant helping to build a wiki from source documents.",
    "",
    languageRule(sourceContent),
    "",
    purpose ? `## Wiki Purpose\n${purpose}` : "",
    schema ? `## Wiki Schema\n${schema}` : "",
    index ? `## Current Wiki Index\n${index}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")

  const userMessage = [
    `I'm ingesting the following source file into my wiki: **${sourceIdentity}**`,
    "",
    "Please read it carefully and present the key takeaways, important concepts, and information that would be valuable to capture in the wiki. Highlight anything that relates to the wiki's purpose and schema.",
    "",
    "---",
    `**File: ${sourceIdentity}**`,
    "```",
    sourceContent || "(empty file)",
    "```",
  ].join("\n")

  store.addMessage("user", userMessage)
  store.setStreaming(true)

  let accumulated = ""

  await streamChat(
    llmConfig,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    {
      onToken: (token) => {
        accumulated += token
        getStore().appendStreamToken(token)
      },
      onDone: () => {
        getStore().finalizeStream(accumulated)
      },
      onError: (err) => {
        getStore().finalizeStream(`Error during ingest: ${err.message}`)
      },
    },
    signal,
  )
}

export function executeIngestWrites(
  projectPath: string,
  llmConfig: LlmConfig,
  userGuidance?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const pp = normalizePath(projectPath)
  return withProjectLock(pp, () =>
    executeIngestWritesImpl(pp, llmConfig, userGuidance, signal)
  )
}

async function executeIngestWritesImpl(
  projectPath: string,
  llmConfig: LlmConfig,
  userGuidance?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const pp = normalizePath(projectPath)
  const store = getStore()
  const ingestSource = store.ingestSource
  const activeSourceIdentity = ingestSource
    ? sourceIdentityForPath(pp, ingestSource)
    : null
  const activeSourceSummarySlug = activeSourceIdentity
    ? sourceSummarySlugFromIdentity(activeSourceIdentity)
    : null
  const activeSourceSummaryPath = activeSourceSummarySlug
    ? `wiki/sources/${activeSourceSummarySlug}.md`
    : null

  const [schema, index] = await Promise.all([
    tryReadFile(`${pp}/wiki/schema.md`),
    tryReadFile(`${pp}/wiki/index.md`),
  ])

  const conversationHistory = store.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))

  const writePrompt = [
    "Based on our discussion, please generate the wiki files that should be created or updated.",
    "",
    userGuidance ? `Additional guidance: ${userGuidance}` : "",
    "",
    schema ? `## Wiki Schema\n${schema}` : "",
    index ? `## Current Wiki Index\n${index}` : "",
    activeSourceIdentity && activeSourceSummaryPath
      ? [
          `## Source File`,
          `The original source file is: **${activeSourceIdentity}**`,
          `If you generate a source summary page, it MUST use this exact path: **${activeSourceSummaryPath}**.`,
          `Every page generated from this source MUST include "${activeSourceIdentity}" in its frontmatter \`sources\` field.`,
        ].join("\n")
      : "",
    "",
    "Output ONLY the file contents in this exact format for each file:",
    "```",
    "---FILE: wiki/path/to/file.md---",
    "(file content here)",
    "---END FILE---",
    "```",
    "",
    "For wiki/log.md, include a log entry to append. For all other files, output the complete file content.",
    "Do not generate wiki/index.md or wiki/overview.md. The application owns those aggregate files.",
    "Use relative paths from the project root (e.g., wiki/sources/topic.md).",
    "Do not include any other text outside the FILE blocks.",
  ]
    .filter((line) => line !== undefined)
    .join("\n")

  conversationHistory.push({ role: "user", content: writePrompt })

  store.addMessage("user", writePrompt)
  store.setStreaming(true)

  let accumulated = ""

  // In auto mode, fall back to detecting language from the chat history
  // (user's discussion messages) rather than the empty string, which would
  // default to English regardless of the source content.
  const historyText = conversationHistory
    .map((m) => m.content)
    .join("\n")
    .slice(0, 2000)

  const systemPrompt = [
    "You are a wiki generation assistant. Your task is to produce structured wiki file contents.",
    "",
    languageRule(historyText),
    schema ? `## Wiki Schema\n${schema}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")

  await streamChat(
    llmConfig,
    [{ role: "system", content: systemPrompt }, ...conversationHistory],
    {
      onToken: (token) => {
        accumulated += token
        getStore().appendStreamToken(token)
      },
      onDone: () => {
        getStore().finalizeStream(accumulated)
      },
      onError: (err) => {
        getStore().finalizeStream(`Error generating wiki files: ${err.message}`)
      },
    },
    signal,
  )

  const writtenPaths: string[] = []
  const matches = accumulated.matchAll(FILE_BLOCK_REGEX)

  for (const match of matches) {
    let relativePath = match[1].trim()
    let content = match[2]

    if (!relativePath) continue
    if (
      activeSourceSummaryPath &&
      relativePath.startsWith("wiki/sources/")
    ) {
      relativePath = activeSourceSummaryPath
    }

    if (!isSafeIngestPath(relativePath) || isAppManagedAggregatePath(relativePath)) {
      console.warn(`[executeIngestWrites] rejected unsafe or app-managed path: ${relativePath}`)
      continue
    }

    content = sanitizeIngestedFileContent(content)

    if (
      activeSourceIdentity &&
      !isLogPath(relativePath) &&
      !isListingPath(relativePath)
    ) {
      content = canonicalizeSourcesField(content, activeSourceIdentity)
    }

    const fullPath = `${pp}/${relativePath}`

    try {
      if (isLogPath(relativePath)) {
        const existing = await tryReadFile(fullPath)
        const appended = existing
          ? `${existing}\n\n${content.trim()}`
          : content.trim()
        await writeFile(fullPath, appended)
      } else {
        await writeFile(fullPath, content)
      }
      writtenPaths.push(fullPath)
    } catch (err) {
      console.error(`Failed to write ${fullPath}:`, err)
    }
  }

  if (writtenPaths.length > 0) {
    const fileList = writtenPaths.map((p) => `- ${p}`).join("\n")
    getStore().addMessage("system", `Files written to wiki:\n${fileList}`)
  } else {
    getStore().addMessage("system", "No files were written. The LLM response did not contain valid FILE blocks.")
  }

  // Image cascade: surface any embedded images on the source-summary
  // page. `startIngest` already kicked off extraction in parallel
  // with the chat stream — by now the images are sitting in
  // `wiki/media/<slug>/`, but no markdown references them yet. Reuse
  // the eager extraction promise from `startIngest` to get back the
  // SavedImage metadata (rel_path, page) needed to build the markdown
  // section. If this write path is reached without a prior startIngest
  // call, the helper falls back to a single extraction.
  //
  // Read the source path from the chat store — `startIngest` set it
  // there at the beginning of the flow, and we don't have it as a
  // parameter (the chat-panel "Save to Wiki" button only passes
  // projectPath). Skipped silently when there's no ingestSource
  // (e.g. user manually entered chat mode and called this).
  // Master toggle gate — see autoIngestImpl Step 0.6 / 3.5 for
  // the full rationale. When captioning is disabled, we skip the
  // safety-net inject here too so the executeIngestWrites path
  // stays consistent with autoIngest.
  const mmCfgWrites = useWikiStore.getState().multimodalConfig
  if (ingestSource && mmCfgWrites.enabled) {
    let extractionKey: string | null = null
    try {
      const sourceIdentity = sourceIdentityForPath(pp, ingestSource)
      const sourceSummarySlug = sourceSummarySlugFromIdentity(sourceIdentity)
      extractionKey = await imageExtractionKey(pp, ingestSource, sourceSummarySlug)
      const savedImages = await extractSourceImagesOnceByKey(
        extractionKey,
        pp,
        ingestSource,
        sourceSummarySlug,
      )
      if (savedImages.length > 0) {
        await injectImagesIntoSourceSummary(pp, sourceIdentity, sourceSummarySlug, savedImages)
      }
    } catch (err) {
      console.warn(
        `[executeIngestWrites:images] post-write injection failed:`,
        err instanceof Error ? err.message : err,
      )
    } finally {
      if (extractionKey) ingestImageExtractionPromises.delete(extractionKey)
    }
  }

  return writtenPaths
}
