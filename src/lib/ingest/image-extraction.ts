// image-extraction.ts — image extraction + caption config + saved-image refs.
// Split from src/lib/ingest/ingest.ts (M2 of refactor-web-app).

import { getFileModifiedTime, getFileSize, readFileAsBase64 } from "@/commands/fs"
import type { MultimodalConfig } from "@/stores/wiki-store"
import type { LlmConfig } from "@/stores/wiki-store"
import { getFileName, normalizePath } from "@/lib/path-utils"
import {
  extractAndSaveSourceImages,
  type SavedImage,
} from "@/lib/extract-source-images"


export function appendSavedImageRefsForCaption(content: string, images: SavedImage[]): string {
  if (images.length === 0) return content
  const refs = images
    .map((img) => img.relPath)
    .filter(Boolean)
    .map((relPath) => `![](${relPath})`)
  if (refs.length === 0) return content
  return `${content}\n\n## Referenced Local Images\n\n${refs.join("\n")}\n`
}

export const ingestImageExtractionPromises = new Map<string, Promise<SavedImage[]>>()

export async function imageExtractionKey(
  projectPath: string,
  sourcePath: string,
  sourceSummarySlug: string,
): Promise<string> {
  const normalizedSource = normalizePath(sourcePath)
  let fingerprint: string
  try {
    const [size, mtime] = await Promise.all([
      getFileSize(normalizedSource),
      getFileModifiedTime(normalizedSource),
    ])
    fingerprint = `${size}:${mtime}`
  } catch {
    // If the source disappeared or stat fails, avoid reusing a stale
    // promise from a previous ingest of the same path.
    fingerprint = `unstable:${Date.now()}`
  }
  return `${normalizePath(projectPath)}\n${normalizedSource}\n${sourceSummarySlug}\n${fingerprint}`
}

export function rememberImageExtractionByKey(
  key: string,
  promise: Promise<SavedImage[]>,
): Promise<SavedImage[]> {
  ingestImageExtractionPromises.set(key, promise)
  if (ingestImageExtractionPromises.size > 32) {
    const oldest = ingestImageExtractionPromises.keys().next().value
    if (oldest) ingestImageExtractionPromises.delete(oldest)
  }
  promise.catch(() => {
    if (ingestImageExtractionPromises.get(key) === promise) {
      ingestImageExtractionPromises.delete(key)
    }
  })
  return promise
}

export function extractSourceImagesOnceByKey(
  key: string,
  projectPath: string,
  sourcePath: string,
  sourceSummarySlug: string,
): Promise<SavedImage[]> {
  const existing = ingestImageExtractionPromises.get(key)
  if (existing) return existing
  return rememberImageExtractionByKey(
    key,
    extractAndSaveSourceImages(projectPath, sourcePath, sourceSummarySlug),
  )
}

export async function extractSourceImagesOnce(
  projectPath: string,
  sourcePath: string,
  sourceSummarySlug: string,
): Promise<SavedImage[]> {
  const key = await imageExtractionKey(projectPath, sourcePath, sourceSummarySlug)
  return extractSourceImagesOnceByKey(key, projectPath, sourcePath, sourceSummarySlug)
}

export function isSavedImagePromptUrl(projectPath: string, sourceSummarySlug: string, url: string): boolean {
  return (
    url.startsWith(`${projectPath}/wiki/media/${sourceSummarySlug}/`) ||
    url.startsWith(`media/${sourceSummarySlug}/`)
  )
}

export function promptImageUrlToAbs(projectPath: string, url: string): string {
  return url.startsWith("media/") ? `${projectPath}/wiki/${url}` : url
}

function imageMimeTypeFromPath(path: string): string {
  const ext = getFileName(path).split(".").pop()?.toLowerCase() ?? ""
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg"
    case "png":
      return "image/png"
    case "gif":
      return "image/gif"
    case "webp":
      return "image/webp"
    case "bmp":
      return "image/bmp"
    case "svg":
      return "image/svg+xml"
    case "tif":
    case "tiff":
      return "image/tiff"
    default:
      return "application/octet-stream"
  }
}

async function sha256OfBase64(b64: string): Promise<string> {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const digest = await crypto.subtle.digest("SHA-256", buffer)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export async function savedImagesFromMineruMarkdown(
  projectPath: string,
  sourceSummarySlug: string,
  markdown: string,
): Promise<SavedImage[]> {
  const pp = normalizePath(projectPath)
  const prefix = `media/${sourceSummarySlug}/mineru/`
  const encodedPrefix = `media/${encodeMarkdownPathSegment(sourceSummarySlug)}/mineru/`
  const refs: string[] = []
  const seen = new Set<string>()

  for (const match of markdown.matchAll(/!\[[^\]]*]\(((?:[^()]|\([^()]*\))*)\)/g)) {
    const rawTarget = (match[1] ?? "").trim()
    const url = rawTarget.startsWith("<") && rawTarget.includes(">")
      ? rawTarget.slice(1, rawTarget.indexOf(">"))
      : rawTarget.split(/\s+["']/)[0]
    if (!url) continue
    let decoded = url
    try {
      decoded = decodeURIComponent(url)
    } catch {
      // Keep the raw URL if it is not valid percent-encoding.
    }
    const normalized = normalizePath(decoded.replace(/^\.\//, ""))
    if (!normalized.startsWith(prefix) && !normalized.startsWith(encodedPrefix)) continue
    const relPath = normalized.startsWith(encodedPrefix)
      ? `media/${sourceSummarySlug}/mineru/${normalized.slice(encodedPrefix.length)}`
      : normalized
    if (seen.has(relPath)) continue
    seen.add(relPath)
    refs.push(relPath)
  }

  const images: SavedImage[] = []
  for (const relPath of refs) {
    const absPath = `${pp}/wiki/${relPath}`
    try {
      const { base64 } = await readFileAsBase64(absPath)
      images.push({
        index: images.length + 1,
        mimeType: imageMimeTypeFromPath(relPath),
        page: null,
        width: 0,
        height: 0,
        relPath,
        absPath,
        sha256: await sha256OfBase64(base64),
      })
    } catch (err) {
      console.warn(
        `[ingest:mineru] failed to read cached MinerU image "${relPath}":`,
        err instanceof Error ? err.message : err,
      )
    }
  }
  return images
}

export function stripWikiMediaAbsPaths(projectPath: string, content: string): string {
  return content.split(`${projectPath}/wiki/media/`).join("media/")
}

export function toSourceSummaryImageRef(relPath: string): string {
  const normalized = relPath.replace(/^\.\//, "")
  return normalized.startsWith("media/") ? `../${normalized}` : relPath
}

function encodeMarkdownPathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

export function resolveCaptionConfig(
  mm: MultimodalConfig,
  mainLlm: LlmConfig,
): LlmConfig | null {
  if (!mm.enabled) return null
  if (mm.useMainLlm) return mainLlm
  return {
    provider: mm.provider,
    apiKey: mm.apiKey,
    model: mm.model,
    ollamaUrl: mm.ollamaUrl,
    customEndpoint: mm.customEndpoint,
    azureApiVersion: mm.azureApiVersion,
    azureModelFamily: mm.azureModelFamily,
    apiMode: mm.apiMode,
    // The dedicated caption provider has no separate reasoning control. Reuse
    // the ingest preference and let its own provider capabilities normalize it.
    ingestReasoning: mainLlm.ingestReasoning,
    // The caption helper hits `streamChat` directly, which doesn't
    // care about `maxContextSize` (that field is for the analysis
    // / generation prompt-truncation logic). Keep it set so the
    // shape matches LlmConfig.
    maxContextSize: mainLlm.maxContextSize,
  }
}
