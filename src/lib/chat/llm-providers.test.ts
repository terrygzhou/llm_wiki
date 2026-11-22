/**
 * Wire-format coverage for `getProviderConfig().buildBody` —
 * specifically the multimodal `ContentBlock[]` path added in Phase 2
 * of the multimodal-images plan. The expectation we encode here:
 *
 *   - Each provider's body produces the EXACT shape that wire
 *     accepts for vision input. Drift in any field name or nesting
 *     (e.g. OpenAI emitting `image: {url}` instead of
 *     `image_url: {url}`, or Anthropic emitting
 *     `mediaType` instead of `media_type`) breaks vision in prod
 *     silently — the wire returns 400 but only when an image is
 *     actually sent, which is rare in our test surface.
 *
 *   - String content keeps emitting bytes byte-identical to the
 *     pre-Phase-2 shape. This is non-negotiable: regressing the
 *     text wire would break every existing call site.
 */
import { describe, it, expect } from "vitest"
import {
  buildAnthropicUrl,
  deriveAnthropicMaxTokens,
  getProviderConfig,
  mergeLlmRequestHeaders,
  parseAnthropicLine,
  parseAnthropicResponse,
  parseGoogleLine,
  parseGoogleResponse,
  parseOpenAiResponse,
  supportsImageInput,
  type ChatMessage,
  type ContentBlock,
} from "./llm-providers"
import type { LlmConfig } from "@/stores/wiki-store"

const makeConfig = (overrides: Partial<LlmConfig> = {}): LlmConfig => ({
  provider: "minimax",
  apiKey: "test-key",
  model: "MiniMax-M3",
  ollamaUrl: "http://localhost:11434",
  customEndpoint: "",
  maxContextSize: 204800,
  ...overrides,
})


const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABXvMqOgAAAABJRU5ErkJggg=="

function mkConfig(over: Partial<LlmConfig>): LlmConfig {
  return {
    provider: "openai",
    apiKey: "sk-test",
    model: "gpt-4o",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 8192,
    ...over,
  }
}

describe("non-streaming provider configuration", () => {
  it("disables streaming on OpenAI and Anthropic request bodies", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hello" }]
    const openai = getProviderConfig(mkConfig({ streamingEnabled: false }))
    const anthropic = getProviderConfig(mkConfig({
      provider: "anthropic",
      model: "claude-3-5-sonnet-latest",
      streamingEnabled: false,
    }))

    expect(openai.streaming).toBe(false)
    expect(openai.buildBody(messages)).toMatchObject({ stream: false })
    expect(anthropic.streaming).toBe(false)
    expect(anthropic.buildBody(messages)).toMatchObject({ stream: false })
  })

  it("uses Gemini generateContent instead of the SSE endpoint", () => {
    const provider = getProviderConfig(mkConfig({
      provider: "google",
      model: "gemini-2.5-flash",
      streamingEnabled: false,
    }))

    expect(provider.url).toContain(":generateContent")
    expect(provider.url).not.toContain("streamGenerateContent")
  })

  it("extracts complete response text for each HTTP wire", () => {
    expect(parseOpenAiResponse({ choices: [{ message: { content: "openai" } }] })).toBe("openai")
    expect(parseAnthropicResponse({ content: [{ type: "text", text: "anthropic" }] })).toBe("anthropic")
    expect(parseGoogleResponse({
      candidates: [{ content: { parts: [
        { text: "hidden", thought: true },
        { text: "google" },
      ] } }],
    })).toBe("google")
  })

  it("keeps streaming enabled for legacy configs without the new field", () => {
    const provider = getProviderConfig(mkConfig({}))
    expect(provider.streaming).toBe(true)
    expect(provider.buildBody([{ role: "user", content: "hello" }]))
      .toMatchObject({ stream: true })
  })
})

function visionMessage(): ChatMessage {
  const blocks: ContentBlock[] = [
    { type: "text", text: "What's in this image?" },
    { type: "image", mediaType: "image/png", dataBase64: TINY_PNG_B64 },
  ]
  return { role: "user", content: blocks }
}

describe("OpenAI buildBody — vision content", () => {
  it("emits image_url block with data: URL framing", () => {
    const cfg = mkConfig({ provider: "openai" })
    const body = getProviderConfig(cfg).buildBody([visionMessage()]) as {
      messages: Array<{ role: string; content: unknown }>
    }
    expect(body.messages).toHaveLength(1)
    const content = body.messages[0].content as Array<{ type: string }>
    expect(content).toHaveLength(2)
    expect(content[0]).toEqual({ type: "text", text: "What's in this image?" })
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` },
    })
  })

  it("flattens single-text-block array back to a string (avoids accidentally regressing text-only callers)", () => {
    const cfg = mkConfig({ provider: "openai" })
    const msg: ChatMessage = {
      role: "user",
      content: [{ type: "text", text: "hello world" }],
    }
    const body = getProviderConfig(cfg).buildBody([msg]) as {
      messages: Array<{ content: unknown }>
    }
    expect(body.messages[0].content).toBe("hello world")
  })

  it("string content stays a string (byte-identical to pre-vision wire)", () => {
    const cfg = mkConfig({ provider: "openai" })
    const body = getProviderConfig(cfg).buildBody([
      { role: "user", content: "hi" },
    ]) as { messages: Array<{ content: unknown }> }
    expect(body.messages[0].content).toBe("hi")
  })
})

describe("Anthropic buildBody — vision content", () => {
  it("emits image block with media_type/data inside source", () => {
    const cfg = mkConfig({ provider: "anthropic", model: "claude-3-5-sonnet-latest" })
    const body = getProviderConfig(cfg).buildBody([visionMessage()]) as {
      messages: Array<{ role: string; content: unknown }>
    }
    const content = body.messages[0].content as Array<{ type: string }>
    expect(content).toHaveLength(2)
    expect(content[0]).toEqual({ type: "text", text: "What's in this image?" })
    expect(content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: TINY_PNG_B64 },
    })
  })

  it("flattens system content with images by dropping image blocks (anthropic doesn't accept system images)", () => {
    const cfg = mkConfig({ provider: "anthropic", model: "claude-3-5-sonnet-latest" })
    const sys: ChatMessage = {
      role: "system",
      content: [
        { type: "text", text: "be terse" },
        { type: "image", mediaType: "image/png", dataBase64: TINY_PNG_B64 },
      ],
    }
    const body = getProviderConfig(cfg).buildBody([
      sys,
      { role: "user", content: "ok" },
    ]) as { system?: unknown; messages: unknown[] }
    expect(body.system).toEqual([
      {
        type: "text",
        text: "be terse",
        cache_control: { type: "ephemeral" },
      },
    ])
  })

  it("emits Anthropic system prompts as cacheable text blocks", () => {
    const cfg = mkConfig({ provider: "anthropic", model: "claude-3-5-sonnet-latest" })
    const body = getProviderConfig(cfg).buildBody([
      { role: "system", content: "You are helpful." },
      { role: "system", content: "Prefer concise answers." },
      { role: "user", content: "Hi" },
    ]) as { system?: unknown; messages: unknown[] }

    expect(body.system).toEqual([
      {
        type: "text",
        text: "You are helpful.\nPrefer concise answers.",
        cache_control: { type: "ephemeral" },
      },
    ])
    expect(body.messages).toEqual([{ role: "user", content: "Hi" }])
  })
})

describe("MiniMax Anthropic-compatible endpoint", () => {
  it("normalizes bare MiniMax global host to the Anthropic messages path", () => {
    expect(buildAnthropicUrl("https://api.minimax.io")).toBe(
      "https://api.minimax.io/anthropic/v1/messages",
    )
  })

  it("normalizes bare MiniMax China host to the Anthropic messages path", () => {
    expect(buildAnthropicUrl("https://api.minimaxi.com")).toBe(
      "https://api.minimaxi.com/anthropic/v1/messages",
    )
  })

  it("recovers from MiniMax URLs pasted as /v1/messages", () => {
    expect(buildAnthropicUrl("https://api.minimaxi.com/v1/messages")).toBe(
      "https://api.minimaxi.com/anthropic/v1/messages",
    )
  })

  it("keeps already-correct MiniMax Anthropic URLs intact", () => {
    expect(buildAnthropicUrl("https://api.minimaxi.com/anthropic/v1/messages")).toBe(
      "https://api.minimaxi.com/anthropic/v1/messages",
    )
  })

  it("uses Bearer auth for bare MiniMax endpoints after normalization", () => {
    const provider = getProviderConfig(mkConfig({
      provider: "custom",
      apiKey: "sk-minimax",
      model: "MiniMax-M2",
      customEndpoint: "https://api.minimaxi.com",
      apiMode: "anthropic_messages",
    }))

    expect(provider.url).toBe("https://api.minimaxi.com/anthropic/v1/messages")
    expect(provider.headers.Authorization).toBe("Bearer sk-minimax")
    expect(provider.headers["x-api-key"]).toBeUndefined()
  })

  it("allows official MiniMax-M3 Anthropic image input", () => {
    const body = getProviderConfig(mkConfig({
      provider: "custom",
      apiKey: "sk-minimax",
      model: "MiniMax-M3",
      customEndpoint: "https://api.minimaxi.com",
      apiMode: "anthropic_messages",
    })).buildBody([visionMessage()]) as { messages: Array<{ content: unknown }> }

    const content = body.messages[0].content as Array<{ type: string }>
    expect(content[1]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: TINY_PNG_B64 },
    })
  })

  it("fails early for official MiniMax M2.x Anthropic image input", () => {
    const provider = getProviderConfig(mkConfig({
      provider: "custom",
      apiKey: "sk-minimax",
      model: "MiniMax-M2",
      customEndpoint: "https://api.minimaxi.com",
      apiMode: "anthropic_messages",
    }))

    expect(() => provider.buildBody([visionMessage()])).toThrow(
      /MiniMax image input is supported only by MiniMax-M3/,
    )
  })

  it("fails early for native MiniMax M2.x image input", () => {
    const provider = getProviderConfig(mkConfig({
      provider: "minimax",
      apiKey: "sk-minimax",
      model: "MiniMax-M2",
      customEndpoint: "https://api.minimaxi.com",
    }))

    expect(() => provider.buildBody([visionMessage()])).toThrow(
      /MiniMax image input is supported only by MiniMax-M3/,
    )
  })

  it("allows native MiniMax-M3 image input", () => {
    const body = getProviderConfig(mkConfig({
      provider: "minimax",
      apiKey: "sk-minimax",
      model: "MiniMax-M3",
      customEndpoint: "https://api.minimaxi.com",
    })).buildBody([visionMessage()]) as { messages: Array<{ content: unknown }> }

    const content = body.messages[0].content as Array<{ type: string }>
    expect(content[1]).toMatchObject({ type: "image" })
  })

  it("still allows text-only MiniMax Anthropic requests", () => {
    const body = getProviderConfig(mkConfig({
      provider: "minimax",
      apiKey: "sk-minimax",
      model: "MiniMax-M2",
      customEndpoint: "https://api.minimaxi.com",
    })).buildBody([{ role: "user", content: "hi" }]) as Record<string, unknown>

    expect(body.model).toBe("MiniMax-M2")
    expect(body.messages).toEqual([{ role: "user", content: "hi" }])
  })

  it("reports official MiniMax-M3 Anthropic endpoints as image-capable", () => {
    expect(supportsImageInput(mkConfig({
      provider: "custom",
      model: "MiniMax-M3",
      customEndpoint: "https://api.minimaxi.com",
      apiMode: "anthropic_messages",
    }))).toBe(true)
  })

  it("reports native MiniMax-M3 as image-capable and native MiniMax M2.x as not image-capable", () => {
    expect(supportsImageInput(mkConfig({
      provider: "minimax",
      model: "MiniMax-M3",
      customEndpoint: "https://api.minimaxi.com",
    }))).toBe(true)
    expect(supportsImageInput(mkConfig({
      provider: "minimax",
      model: "MiniMax-M3-Preview",
      customEndpoint: "https://api.minimaxi.com",
    }))).toBe(true)
    expect(supportsImageInput(mkConfig({
      provider: "minimax",
      model: "MiniMax-M2.7",
      customEndpoint: "https://api.minimaxi.com",
    }))).toBe(false)
  })

  it("reports Codex CLI as not image-capable because images are text-omitted", () => {
    expect(supportsImageInput(mkConfig({
      provider: "codex-cli",
      model: "gpt-5-codex",
    }))).toBe(false)
  })

  it("reports official MiniMax M2.x Anthropic endpoints as not image-capable", () => {
    expect(supportsImageInput(mkConfig({
      provider: "custom",
      model: "MiniMax-M2",
      customEndpoint: "https://api.minimaxi.com",
      apiMode: "anthropic_messages",
    }))).toBe(false)
  })

  it("does not block non-MiniMax custom Anthropic-compatible endpoints from image input", () => {
    expect(supportsImageInput(mkConfig({
      provider: "custom",
      model: "claude-compatible-vision",
      customEndpoint: "https://example.com/anthropic",
      apiMode: "anthropic_messages",
    }))).toBe(true)
  })
})

describe("Google buildBody — vision content", () => {
  it("emits parts with inline_data for images", () => {
    const cfg = mkConfig({ provider: "google", model: "gemini-2.5-pro" })
    const body = getProviderConfig(cfg).buildBody([visionMessage()]) as {
      contents: Array<{ role: string; parts: unknown[] }>
    }
    const parts = body.contents[0].parts as Array<Record<string, unknown>>
    expect(parts).toHaveLength(2)
    expect(parts[0]).toEqual({ text: "What's in this image?" })
    expect(parts[1]).toEqual({
      inline_data: { mime_type: "image/png", data: TINY_PNG_B64 },
    })
  })
})

describe("Zhipu BigModel / GLM vision content", () => {
  it("uses OpenAI-compatible image_url blocks for GLM vision models", () => {
    const provider = getProviderConfig(mkConfig({
      provider: "custom",
      apiKey: "zhipu-key",
      model: "glm-4.5v",
      customEndpoint: "https://open.bigmodel.cn/api/paas/v4",
      apiMode: "chat_completions",
    }))
    const body = provider.buildBody([visionMessage()]) as {
      messages: Array<{ content: unknown }>
    }
    const content = body.messages[0].content as Array<{ type: string }>

    expect(provider.url).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions")
    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` },
    })
  })

  it("reports BigModel GLM vision models as image-capable", () => {
    for (const model of ["glm-5v-turbo", "glm-4.6v", "glm-4.5v", "glm-4v-plus"]) {
      expect(supportsImageInput(mkConfig({
        provider: "custom",
        model,
        customEndpoint: "https://open.bigmodel.cn/api/paas/v4",
        apiMode: "chat_completions",
      }))).toBe(true)
    }
  })

  it("reports BigModel text-only GLM models as not image-capable", () => {
    for (const model of ["glm-5.1", "glm-5", "glm-4.7", "glm-4.6", "glm-4.5-flash"]) {
      expect(supportsImageInput(mkConfig({
        provider: "custom",
        model,
        customEndpoint: "https://open.bigmodel.cn/api/paas/v4",
        apiMode: "chat_completions",
      }))).toBe(false)
    }
  })

  it("fails early when BigModel text-only GLM models receive image input", () => {
    const provider = getProviderConfig(mkConfig({
      provider: "custom",
      apiKey: "zhipu-key",
      model: "glm-4.6",
      customEndpoint: "https://open.bigmodel.cn/api/paas/v4",
      apiMode: "chat_completions",
    }))

    expect(() => provider.buildBody([visionMessage()])).toThrow(
      /Zhipu BigModel image input is supported only by GLM vision models/,
    )
  })

  it("keeps the default permissive image capability for OpenAI and Claude Code providers", () => {
    expect(supportsImageInput(mkConfig({
      provider: "openai",
      model: "gpt-4o-mini",
    }))).toBe(true)
    expect(supportsImageInput(mkConfig({
      provider: "claude-code",
      model: "claude-sonnet-4-5-20250929",
    }))).toBe(true)
  })
})

describe("Azure OpenAI provider", () => {
  it("uses Azure deployment URL and api-key auth", () => {
    const cfg = getProviderConfig(mkConfig({
      provider: "azure",
      apiKey: "azure-key",
      model: "my-gpt-4o-deployment",
      customEndpoint: "https://example-resource.openai.azure.com",
    }))

    expect(cfg.url).toBe(
      "https://example-resource.openai.azure.com/openai/deployments/my-gpt-4o-deployment/chat/completions?api-version=2024-10-21",
    )
    expect(cfg.headers["api-key"]).toBe("azure-key")
    expect(cfg.headers.Authorization).toBeUndefined()
  })

  it("omits model from the request body because the deployment is in the URL", () => {
    const cfg = getProviderConfig(mkConfig({
      provider: "azure",
      model: "deployment-a",
      customEndpoint: "https://example-resource.openai.azure.com",
    }))
    const body = cfg.buildBody([{ role: "user", content: "hi" }]) as Record<string, unknown>

    expect(body.model).toBeUndefined()
    expect(body.messages).toEqual([{ role: "user", content: "hi" }])
  })

  it("uses the configured Azure API version", () => {
    const cfg = getProviderConfig(mkConfig({
      provider: "azure",
      model: "deployment-a",
      customEndpoint: "https://example-resource.openai.azure.com",
      azureApiVersion: "2025-01-01-preview",
    }))

    expect(cfg.url).toContain("api-version=2025-01-01-preview")
  })

  it("maps max_tokens to max_completion_tokens for Azure GPT-5 deployments", () => {
    const cfg = getProviderConfig(mkConfig({
      provider: "azure",
      model: "gpt-5-nano",
      customEndpoint: "https://example-resource.openai.azure.com",
    }))
    const body = cfg.buildBody(
      [{ role: "user", content: "hi" }],
      { max_tokens: 4096 },
    ) as Record<string, unknown>

    expect(body.max_tokens).toBeUndefined()
    expect(body.max_completion_tokens).toBe(4096)
  })

  it("omits unsupported non-default temperature for Azure GPT-5 deployments", () => {
    const cfg = getProviderConfig(mkConfig({
      provider: "azure",
      model: "gpt-5-nano",
      customEndpoint: "https://example-resource.openai.azure.com",
    }))
    const body = cfg.buildBody(
      [{ role: "user", content: "hi" }],
      { temperature: 0.1 },
    ) as Record<string, unknown>

    expect(body.temperature).toBeUndefined()
  })

  it("uses explicit Azure model family when deployment name does not reveal GPT-5", () => {
    const cfg = getProviderConfig(mkConfig({
      provider: "azure",
      model: "production-chat-deployment",
      customEndpoint: "https://example-resource.openai.azure.com",
      azureModelFamily: "gpt5",
    }))
    const body = cfg.buildBody(
      [{ role: "user", content: "hi" }],
      { max_tokens: 1024, temperature: 0.1 },
    ) as Record<string, unknown>

    expect(body.max_tokens).toBeUndefined()
    expect(body.max_completion_tokens).toBe(1024)
    expect(body.temperature).toBeUndefined()
  })

  it("applies explicit Azure model family to custom Azure endpoints", () => {
    const cfg = getProviderConfig(mkConfig({
      provider: "custom",
      model: "wiki-main",
      customEndpoint: "https://example-resource.openai.azure.com",
      azureModelFamily: "gpt5",
    }))
    const body = cfg.buildBody(
      [{ role: "user", content: "hi" }],
      { max_tokens: 512, temperature: 0.1 },
    ) as Record<string, unknown>

    expect(body.model).toBeUndefined()
    expect(body.max_completion_tokens).toBe(512)
    expect(body.temperature).toBeUndefined()
  })
})

describe("Ollama / custom (chat_completions) — vision content", () => {
  it("ollama uses OpenAI-shaped image_url block (works on /v1/chat/completions for vision-capable models)", () => {
    const cfg = mkConfig({
      provider: "ollama",
      model: "qwen2.5vl",
      ollamaUrl: "http://localhost:11434",
    })
    const body = getProviderConfig(cfg).buildBody([visionMessage()]) as {
      messages: Array<{ content: unknown }>
    }
    const content = body.messages[0].content as Array<{ type: string }>
    expect(content[1]).toMatchObject({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` },
    })
  })

  it("custom endpoint in chat_completions mode emits the same image_url block", () => {
    const cfg = mkConfig({
      provider: "custom",
      model: "Qwen3.6-27B-Q4_K_M.gguf",
      customEndpoint: "http://192.168.1.50:8000/v1",
      apiMode: "chat_completions",
    })
    const body = getProviderConfig(cfg).buildBody([visionMessage()]) as {
      messages: Array<{ content: unknown }>
    }
    const content = body.messages[0].content as Array<{ type: string }>
    expect(content).toHaveLength(2)
    expect(content[1]).toMatchObject({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` },
    })
  })
})

describe("reasoning controls", () => {
  it("does not send thinking to legacy DeepSeek chat models that reject the field", () => {
    const cfg = mkConfig({
      provider: "custom",
      model: "deepseek-chat",
      customEndpoint: "https://api.deepseek.com/v1",
      apiMode: "chat_completions",
    })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: { mode: "off" } },
    ) as Record<string, unknown>

    expect(body.thinking).toBeUndefined()
    expect(body.reasoning).toBeUndefined()
  })

  it("maps DeepSeek V4 reasoning off to thinking disabled for structured tasks", () => {
    const cfg = mkConfig({
      provider: "custom",
      model: "deepseek-v4-flash",
      customEndpoint: "https://api.deepseek.com/v1",
      apiMode: "chat_completions",
    })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: { mode: "off" } },
    ) as Record<string, unknown>

    expect(body.thinking).toEqual({ type: "disabled" })
    expect(body.reasoning).toBeUndefined()
  })

  it("maps DeepSeek V4 high reasoning to thinking enabled plus reasoning_effort", () => {
    const cfg = mkConfig({
      provider: "custom",
      model: "deepseek-v4-pro",
      customEndpoint: "https://api.deepseek.com/v1",
      apiMode: "chat_completions",
    })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: { mode: "high" } },
    ) as Record<string, unknown>

    expect(body.thinking).toEqual({ type: "enabled" })
    expect(body.reasoning_effort).toBe("high")
  })

  it("omits unsupported custom budgets on DeepSeek V4", () => {
    const cfg = mkConfig({
      provider: "custom",
      model: "deepseek-v4-pro",
      customEndpoint: "https://api.deepseek.com/v1",
      apiMode: "chat_completions",
    })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: { mode: "custom", budgetTokens: 2048 } },
    ) as Record<string, unknown>

    expect(body.thinking).toBeUndefined()
    expect(body.max_reasoning_tokens).toBeUndefined()
  })

  it("maps Xiaomi MiMo reasoning off to thinking disabled and max_completion_tokens", () => {
    const cfg = mkConfig({
      provider: "custom",
      model: "mimo-v2.5-pro",
      customEndpoint: "https://api.xiaomimimo.com/v1",
      apiMode: "chat_completions",
    })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { temperature: 0.1, max_tokens: 2048, reasoning: { mode: "off" } },
    ) as Record<string, unknown>

    expect(body.thinking).toEqual({ type: "disabled" })
    expect(body.max_tokens).toBeUndefined()
    expect(body.max_completion_tokens).toBe(2048)
    expect(body.temperature).toBe(0.1)
  })

  it("omits custom temperature for Xiaomi MiMo thinking requests on Token Plan OpenAI wire", () => {
    const cfg = mkConfig({
      provider: "custom",
      model: "custom-router-model",
      customEndpoint: "https://token-plan-cn.xiaomimimo.com/v1",
      apiMode: "chat_completions",
    })
    const provider = getProviderConfig(cfg)
    const body = provider.buildBody(
      [{ role: "user", content: "hi" }],
      { temperature: 0.1, max_tokens: 4096, reasoning: { mode: "auto" } },
    ) as Record<string, unknown>

    expect(provider.url).toBe("https://token-plan-cn.xiaomimimo.com/v1/chat/completions")
    expect(body.temperature).toBeUndefined()
    expect(body.max_completion_tokens).toBe(4096)
  })

  it("uses Bearer auth for Xiaomi MiMo Token Plan Anthropic wire", () => {
    const cfg = mkConfig({
      provider: "custom",
      apiKey: "sk-mimo",
      model: "mimo-v2.5-pro",
      customEndpoint: "https://token-plan-cn.xiaomimimo.com/anthropic",
      apiMode: "anthropic_messages",
    })
    const provider = getProviderConfig(cfg)

    expect(provider.url).toBe("https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages")
    expect(provider.headers.Authorization).toBe("Bearer sk-mimo")
    expect(provider.headers["x-api-key"]).toBeUndefined()
    expect(provider.headers["anthropic-version"]).toBe("2023-06-01")
  })

  it("uses Bearer auth for Kimi Coding Plan Anthropic wire", () => {
    const cfg = mkConfig({
      provider: "custom",
      apiKey: "sk-kimi-test",
      model: "kimi-for-coding",
      customEndpoint: "https://api.kimi.com/coding/",
      apiMode: "anthropic_messages",
    })
    const provider = getProviderConfig(cfg)

    expect(provider.url).toBe("https://api.kimi.com/coding/v1/messages")
    expect(provider.headers.Authorization).toBe("Bearer sk-kimi-test")
    expect(provider.headers["x-api-key"]).toBeUndefined()
    expect(provider.headers["anthropic-version"]).toBe("2023-06-01")
  })

  it("uses Bearer auth for Moonshot Anthropic wire", () => {
    const cfg = mkConfig({
      provider: "custom",
      apiKey: "sk-moonshot",
      model: "kimi-k2.6",
      customEndpoint: "https://api.moonshot.ai/anthropic",
      apiMode: "anthropic_messages",
    })
    const provider = getProviderConfig(cfg)

    expect(provider.url).toBe("https://api.moonshot.ai/anthropic/v1/messages")
    expect(provider.headers.Authorization).toBe("Bearer sk-moonshot")
    expect(provider.headers["x-api-key"]).toBeUndefined()
    expect(provider.headers["anthropic-version"]).toBe("2023-06-01")
  })

  it("uses cacheable system blocks for custom Anthropic-wire providers", () => {
    const cfg = mkConfig({
      provider: "custom",
      apiKey: "sk-custom",
      model: "custom-claude",
      customEndpoint: "https://example.com/anthropic",
      apiMode: "anthropic_messages",
    })
    const body = getProviderConfig(cfg).buildBody([
      { role: "system", content: "Project-wide instruction." },
      { role: "user", content: "Hi" },
    ]) as { system?: unknown; messages: unknown[] }

    expect(body.system).toEqual([
      {
        type: "text",
        text: "Project-wide instruction.",
        cache_control: { type: "ephemeral" },
      },
    ])
    expect(body.messages).toEqual([{ role: "user", content: "Hi" }])
  })

  it("does not infer Qwen private parameters on generic custom endpoints", () => {
    const cfg = mkConfig({
      provider: "custom",
      model: "Qwen3.5-122B",
      customEndpoint: "http://127.0.0.1:8000/v1",
      apiMode: "chat_completions",
    })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: { mode: "off" } },
    ) as Record<string, unknown>

    expect(body.chat_template_kwargs).toBeUndefined()
  })

  it("strips temperature for Kimi/Moonshot OpenAI-compatible endpoints", () => {
    const cfg = mkConfig({
      provider: "custom",
      model: "kimi-k2.6",
      customEndpoint: "https://api.moonshot.ai/v1",
      apiMode: "chat_completions",
    })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { temperature: 0.1, max_tokens: 4096 },
    ) as Record<string, unknown>

    expect(body.temperature).toBeUndefined()
    expect(body.max_tokens).toBe(4096)
  })

  it("maps Anthropic reasoning budget to extended thinking and removes sampling knobs", () => {
    const cfg = mkConfig({ provider: "anthropic", model: "claude-sonnet-4-5-20250929" })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: { mode: "custom", budgetTokens: 2048 }, temperature: 0.1, max_tokens: 4096 },
    ) as Record<string, unknown>

    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 })
    expect(body.temperature).toBeUndefined()
  })

  it("keeps cacheable system blocks when Anthropic extended thinking is enabled", () => {
    const cfg = mkConfig({ provider: "anthropic", model: "claude-sonnet-4-5-20250929" })
    const body = getProviderConfig(cfg).buildBody(
      [
        { role: "system", content: "Persistent project context." },
        { role: "user", content: "hi" },
      ],
      { reasoning: { mode: "low" }, temperature: 0.1, max_tokens: 4096 },
    ) as Record<string, unknown>

    expect(body.system).toEqual([
      {
        type: "text",
        text: "Persistent project context.",
        cache_control: { type: "ephemeral" },
      },
    ])
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 })
    expect(body.temperature).toBeUndefined()
  })

  it("omits unsupported reasoning off for Gemini 2.5 Pro", () => {
    const cfg = mkConfig({ provider: "google", model: "gemini-2.5-pro" })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: { mode: "off" } },
    ) as { generationConfig?: Record<string, unknown> }

    expect(body.generationConfig?.thinkingConfig).toBeUndefined()
  })

  it("uses adaptive thinking and effort for Claude 4.7+", () => {
    const cfg = mkConfig({ provider: "anthropic", model: "claude-opus-4-7" })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: { mode: "high" }, temperature: 0.1 },
    ) as Record<string, unknown>

    expect(body.thinking).toEqual({ type: "adaptive" })
    expect(body.output_config).toEqual({ effort: "high" })
    expect(body.temperature).toBeUndefined()
  })

  it("uses thinkingLevel rather than token budgets for Gemini 3", () => {
    const cfg = mkConfig({ provider: "google", model: "gemini-3-pro-preview" })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: { mode: "medium" } },
    ) as { generationConfig?: Record<string, unknown> }

    expect(body.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: "medium" })
  })

  it("maps Ollama reasoning off to reasoning_effort none (stops thinking-runaway empty content)", () => {
    const cfg = mkConfig({
      provider: "ollama",
      model: "gemma3:12b",
      ollamaUrl: "http://localhost:11434",
    })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: { mode: "off" }, temperature: 0.1, max_tokens: 4096 },
    ) as Record<string, unknown>

    expect(body.reasoning_effort).toBe("none")
  })

  it("uses Ollama-native reasoning control instead of Qwen chat_template_kwargs", () => {
    const cfg = mkConfig({
      provider: "ollama",
      model: "qwen3:8b",
      ollamaUrl: "http://localhost:11434",
    })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: { mode: "off" } },
    ) as Record<string, unknown>

    expect(body.reasoning_effort).toBe("none")
    expect(body.chat_template_kwargs).toBeUndefined()
  })

  it("maps Ollama low/medium/high reasoning straight through to reasoning_effort", () => {
    const cfg = mkConfig({
      provider: "ollama",
      model: "qwen3:8b",
      ollamaUrl: "http://localhost:11434",
    })
    for (const mode of ["low", "medium", "high"] as const) {
      const body = getProviderConfig(cfg).buildBody(
        [{ role: "user", content: "hi" }],
        { reasoning: { mode } },
      ) as Record<string, unknown>
      expect(body.reasoning_effort).toBe(mode)
    }
  })

  it("maps Ollama reasoning max to the strongest supported level high", () => {
    const cfg = mkConfig({
      provider: "ollama",
      model: "qwen3:8b",
      ollamaUrl: "http://localhost:11434",
    })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: { mode: "max" } },
    ) as Record<string, unknown>

    expect(body.reasoning_effort).toBe("high")
  })

  it("leaves Ollama reasoning_effort unset on auto so the model default applies", () => {
    const cfg = mkConfig({
      provider: "ollama",
      model: "gemma3:12b",
      ollamaUrl: "http://localhost:11434",
    })
    const body = getProviderConfig(cfg).buildBody(
      [{ role: "user", content: "hi" }],
      { reasoning: { mode: "auto" } },
    ) as Record<string, unknown>

    expect(body.reasoning_effort).toBeUndefined()
  })
})
describe("custom LLM request headers", () => {
  it("adds gateway headers and preserves protocol authentication precedence", () => {
    const cfg = getProviderConfig(makeConfig({
      provider: "openai",
      apiKey: "real-key",
      customHeaders: { "X-Tenant-ID": "team-a", authorization: "Custom secret" },
    }))
    expect(cfg.headers["X-Tenant-ID"]).toBe("team-a")
    expect(cfg.headers.Authorization).toBe("Bearer real-key")
    expect(cfg.headers.authorization).toBeUndefined()
  })

  it("allows custom Authorization when a custom endpoint has no API key", () => {
    const cfg = getProviderConfig(makeConfig({
      provider: "custom",
      apiKey: "",
      customEndpoint: "https://gateway.example/v1",
      customHeaders: { Authorization: "Basic gateway-token" },
    }))
    expect(cfg.headers.Authorization).toBe("Basic gateway-token")
  })

  it("drops malformed names and newline-bearing values", () => {
    expect(mergeLlmRequestHeaders({
      "Bad Header": "value",
      "X-Good": "ok",
      "X-Injection": "safe\r\nInjected: yes",
    }, { "Content-Type": "application/json" })).toEqual({
      "X-Good": "ok",
      "Content-Type": "application/json",
    })
  })
})

describe("MiniMax Provider", () => {
  it("uses the Anthropic Messages endpoint under /anthropic", () => {
    const cfg = getProviderConfig(makeConfig())
    expect(cfg.url).toBe("https://api.minimax.io/anthropic/v1/messages")
  })

  it("supports the China regional endpoint via customEndpoint", () => {
    const cfg = getProviderConfig(
      makeConfig({ customEndpoint: "https://api.minimaxi.com/anthropic" }),
    )
    expect(cfg.url).toBe("https://api.minimaxi.com/anthropic/v1/messages")
  })

  it("uses Authorization: Bearer (MiniMax rejects x-api-key at CORS layer)", () => {
    const cfg = getProviderConfig(makeConfig({ apiKey: "my-key" }))
    expect(cfg.headers.Authorization).toBe("Bearer my-key")
    expect((cfg.headers as Record<string, string>)["x-api-key"]).toBeUndefined()
  })

  it("sets Content-Type to application/json", () => {
    const cfg = getProviderConfig(makeConfig())
    expect(cfg.headers["Content-Type"]).toBe("application/json")
  })

  it("enables streaming", () => {
    const cfg = getProviderConfig(makeConfig())
    const body = cfg.buildBody([]) as Record<string, unknown>
    expect(body.stream).toBe(true)
  })

  it("includes max_tokens derived from context budget (required by Anthropic wire)", () => {
    const cfg = getProviderConfig(makeConfig())
    const body = cfg.buildBody([]) as Record<string, unknown>
    // 204 800 chars × 15% reserve ÷ 3 chars-per-token = 10 240; capped at 16 384
    expect(body.max_tokens).toBe(10240)
  })

  it("carries the model in the body", () => {
    const cfg = getProviderConfig(makeConfig({ model: "MiniMax-M3" }))
    const body = cfg.buildBody([]) as Record<string, unknown>
    expect(body.model).toBe("MiniMax-M3")
  })

  it("separates system messages from conversation and marks the system prompt cacheable", () => {
    const cfg = getProviderConfig(makeConfig())
    const body = cfg.buildBody([
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Hello" },
    ]) as Record<string, unknown>
    expect(body.system).toEqual([
      {
        type: "text",
        text: "You are helpful",
        cache_control: { type: "ephemeral" },
      },
    ])
    expect(body.messages).toEqual([{ role: "user", content: "Hello" }])
  })
})

describe("Anthropic output budget", () => {
  it("derives output tokens from the character response reserve", () => {
    expect(deriveAnthropicMaxTokens(204_800)).toBe(10_240)
  })

  it("caps large context windows at the Anthropic default limit", () => {
    expect(deriveAnthropicMaxTokens(1_000_000)).toBe(16_384)
  })

  it("never emits a protocol-invalid zero token limit", () => {
    expect(deriveAnthropicMaxTokens(1)).toBe(1)
  })

  it("applies the derived default to native and custom Anthropic providers", () => {
    const native = getProviderConfig(makeConfig({ provider: "anthropic" }))
    const custom = getProviderConfig(makeConfig({
      provider: "custom",
      apiMode: "anthropic_messages",
      customEndpoint: "https://example.com/anthropic",
    }))

    expect((native.buildBody([]) as Record<string, unknown>).max_tokens).toBe(10_240)
    expect((custom.buildBody([]) as Record<string, unknown>).max_tokens).toBe(10_240)
  })

  it("preserves an explicit caller override", () => {
    const provider = getProviderConfig(makeConfig({ provider: "anthropic" }))
    const body = provider.buildBody([], { max_tokens: 777 }) as Record<string, unknown>

    expect(body.max_tokens).toBe(777)
  })
})

describe("MiniMax provider registration", () => {
  it("minimax is a valid provider value in the type union", () => {
    const provider: LlmConfig["provider"] = "minimax"
    expect(provider).toBe("minimax")
  })
})

describe("buildAnthropicUrl — URL suffix handling", () => {
  it("appends /v1/messages to a bare host", () => {
    expect(buildAnthropicUrl("https://api.anthropic.com")).toBe(
      "https://api.anthropic.com/v1/messages",
    )
  })

  it("appends /v1/messages to a bare /anthropic proxy base", () => {
    expect(buildAnthropicUrl("https://api.minimax.io/anthropic")).toBe(
      "https://api.minimax.io/anthropic/v1/messages",
    )
  })

  it("does NOT double the /v1 when base already ends in /v1", () => {
    expect(buildAnthropicUrl("https://api.anthropic.com/v1")).toBe(
      "https://api.anthropic.com/v1/messages",
    )
  })

  it("does NOT double the /v1 when proxy base ends in /anthropic/v1", () => {
    expect(buildAnthropicUrl("https://api.minimax.io/anthropic/v1")).toBe(
      "https://api.minimax.io/anthropic/v1/messages",
    )
  })

  it("preserves a full /v1/messages URL", () => {
    expect(buildAnthropicUrl("https://api.anthropic.com/v1/messages")).toBe(
      "https://api.anthropic.com/v1/messages",
    )
  })

  it("handles arbitrary version segments like /api/paas/v4", () => {
    expect(buildAnthropicUrl("https://open.bigmodel.cn/api/paas/v4")).toBe(
      "https://open.bigmodel.cn/api/paas/v4/messages",
    )
  })

  it("strips trailing slashes", () => {
    expect(buildAnthropicUrl("https://api.anthropic.com/v1/")).toBe(
      "https://api.anthropic.com/v1/messages",
    )
  })
})

describe("parseGoogleLine — Gemini SSE parsing", () => {
  it("extracts plain text from a single-part event", () => {
    const line = 'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}'
    expect(parseGoogleLine(line)).toBe("Hello")
  })

  it("accepts SSE data lines without a space after the colon", () => {
    const line = 'data:{"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}'
    expect(parseGoogleLine(line)).toBe("Hello")
  })

  it("concatenates text across multiple parts in one event", () => {
    // Gemini 2.5/3.x reasoning models sometimes split output across
    // multiple parts in a single streaming chunk. The old parser only
    // took parts[0], silently dropping the tail.
    const line = 'data: {"candidates":[{"content":{"parts":[{"text":"Hello "},{"text":"world"}]}}]}'
    expect(parseGoogleLine(line)).toBe("Hello world")
  })

  it("skips thought parts so reasoning tokens don't leak into output", () => {
    const line =
      'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"let me think"},{"text":"The answer is 42"}]}}]}'
    expect(parseGoogleLine(line)).toBe("The answer is 42")
  })

  it("returns null when the event has no visible text", () => {
    const line = 'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"thinking"}]}}]}'
    expect(parseGoogleLine(line)).toBeNull()
  })

  it("returns null for non-data lines", () => {
    expect(parseGoogleLine("event: something")).toBeNull()
    expect(parseGoogleLine("")).toBeNull()
    expect(parseGoogleLine(":keepalive")).toBeNull()
  })

  it("returns null for malformed JSON", () => {
    expect(parseGoogleLine("data: {not json")).toBeNull()
  })
})

describe("parseAnthropicLine — Anthropic SSE parsing", () => {
  it("extracts text from a standard text_delta event (with space)", () => {
    const line = 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}'
    expect(parseAnthropicLine(line)).toBe("Hello")
  })

  it("extracts text when delta.type is omitted (no-space SSE)", () => {
    // Some third-party Anthropic-compatible gateways (e.g. Kimi Coding Plan)
    // emit content_block_delta with a bare `text` field and no `type` inside
    // delta, and sometimes omit the space after `data:`.
    const line = 'data:{"type":"content_block_delta","index":0,"delta":{"text":"world"}}'
    expect(parseAnthropicLine(line)).toBe("world")
  })

  it("extracts text from a complete message event (single-shot SSE)", () => {
    const line =
      'data: {"type":"message","id":"msg_01","role":"assistant","content":[{"type":"text","text":"Hello world"}]}'
    expect(parseAnthropicLine(line)).toBe("Hello world")
  })

  it("concatenates all text blocks from a complete message event", () => {
    const line =
      'data: {"type":"message","id":"msg_01","role":"assistant","content":[{"type":"text","text":"Hello "},{"type":"tool_use","id":"tool_1"},{"type":"text","text":"world"}]}'
    expect(parseAnthropicLine(line)).toBe("Hello world")
  })

  it("falls back to OpenAI-shaped delta.content when present", () => {
    const line = 'data: {"choices":[{"delta":{"content":"fallback"}}]}'
    expect(parseAnthropicLine(line)).toBe("fallback")
  })

  it("returns null for non-content-block-delta events without extractable text", () => {
    const line = 'data: {"type":"message_start","message":{"id":"msg_01"}}'
    expect(parseAnthropicLine(line)).toBeNull()
  })

  it("returns null for non-data lines", () => {
    expect(parseAnthropicLine("event: start")).toBeNull()
    expect(parseAnthropicLine("")).toBeNull()
  })
})

describe("parseOpenAiLine — OpenAI-compatible SSE parsing", () => {
  it("accepts SSE data lines without a space after the colon", () => {
    const cfg = getProviderConfig(makeConfig({ provider: "openai", model: "gpt-4.1" }))
    const line = 'data:{"choices":[{"delta":{"content":"Hello"}}]}'
    expect(cfg.parseStream(line)).toBe("Hello")
  })
})

describe("Claude Code CLI provider — not reachable via getProviderConfig", () => {
  it("throws, because the subprocess transport dispatches one layer up in streamChat", () => {
    // If this ever stops throwing, someone wired claude-code into the
    // HTTP path by mistake — it has no URL/headers and would crash
    // silently inside fetch() otherwise.
    expect(() =>
      getProviderConfig({
        provider: "claude-code",
        apiKey: "",
        model: "claude-sonnet-4-6",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 200000,
      } as LlmConfig),
    ).toThrow(/subprocess transport/)
  })
})

describe("Codex CLI provider — not reachable via getProviderConfig", () => {
  it("throws, because the subprocess transport dispatches one layer up in streamChat", () => {
    expect(() =>
      getProviderConfig({
        provider: "codex-cli",
        apiKey: "",
        model: "gpt-5.4-mini",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 200000,
      } as LlmConfig),
    ).toThrow(/subprocess transport/)
  })
})

describe("Google provider URL — model path encoding", () => {
  const makeGoogleConfig = (model: string): LlmConfig => ({
    provider: "google",
    apiKey: "test",
    model,
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
  })

  it("embeds a normal model id directly in the URL", () => {
    const cfg = getProviderConfig(makeGoogleConfig("gemini-2.5-flash"))
    expect(cfg.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
    )
  })

  it("encodes slashes in a pasted OpenRouter-style id so the path stays well-formed", () => {
    // Previously bare interpolation put a real "/" in the path, which
    // would have been interpreted as a segment boundary → 404 on a
    // nonexistent Google resource.
    const cfg = getProviderConfig(makeGoogleConfig("google/gemini-3-pro-preview"))
    expect(cfg.url).toContain("google%2Fgemini-3-pro-preview:streamGenerateContent")
  })
})

describe("Sampling override translation across wires", () => {
  const baseMessages = [{ role: "user" as const, content: "hi" }]

  it("Gemini nests overrides under generationConfig with Gemini naming", () => {
    // Regression for a user-reported HTTP 400 —
    //   "Unknown name 'temperature': Cannot find field."
    // Gemini rejects sampling knobs at the top level and requires the
    // renamed keys (top_p → topP, max_tokens → maxOutputTokens).
    const cfg = getProviderConfig({
      provider: "google",
      apiKey: "k",
      model: "gemini-2.5-flash",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    })
    const body = cfg.buildBody(baseMessages, {
      temperature: 0.1,
      top_p: 0.9,
      top_k: 40,
      max_tokens: 500,
      stop: ["###"],
    }) as Record<string, unknown>

    expect(body.temperature).toBeUndefined()
    expect(body.top_p).toBeUndefined()
    expect(body.max_tokens).toBeUndefined()
    const gc = body.generationConfig as Record<string, unknown>
    expect(gc.temperature).toBe(0.1)
    expect(gc.topP).toBe(0.9)
    expect(gc.topK).toBe(40)
    expect(gc.maxOutputTokens).toBe(500)
    expect(gc.stopSequences).toEqual(["###"])
  })

  it("Gemini omits generationConfig entirely when no overrides passed", () => {
    const cfg = getProviderConfig({
      provider: "google",
      apiKey: "k",
      model: "gemini-2.5-flash",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    })
    const body = cfg.buildBody(baseMessages) as Record<string, unknown>
    expect(body.generationConfig).toBeUndefined()
  })

  it("OpenAI wires put overrides at the top level", () => {
    const cfg = getProviderConfig({
      provider: "openai",
      apiKey: "k",
      model: "gpt-4o",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    })
    const body = cfg.buildBody(baseMessages, { temperature: 0.1, max_tokens: 500 }) as Record<string, unknown>
    expect(body.temperature).toBe(0.1)
    expect(body.max_tokens).toBe(500)
  })

  it("OpenAI GPT-5 maps max_tokens and strips unsupported sampling knobs", () => {
    const cfg = getProviderConfig({
      provider: "openai",
      apiKey: "k",
      model: "gpt-5-nano",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    })
    const body = cfg.buildBody(baseMessages, {
      temperature: 0.1,
      top_p: 0.8,
      top_k: 40,
      max_tokens: 4096,
    }) as Record<string, unknown>

    expect(body.max_completion_tokens).toBe(4096)
    expect(body.max_tokens).toBeUndefined()
    expect(body.temperature).toBeUndefined()
    expect(body.top_p).toBeUndefined()
    expect(body.top_k).toBeUndefined()
  })

  it("OpenAI o-series models use max_completion_tokens", () => {
    const cfg = getProviderConfig({
      provider: "openai",
      apiKey: "k",
      model: "o3-mini",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    })
    const body = cfg.buildBody(baseMessages, { max_tokens: 8192 }) as Record<string, unknown>

    expect(body.max_completion_tokens).toBe(8192)
    expect(body.max_tokens).toBeUndefined()
  })

  it("custom OpenAI-compatible GPT-5 routes keep legacy overrides for OpenRouter-style shims", () => {
    const cfg = getProviderConfig({
      provider: "custom",
      apiKey: "k",
      model: "gpt-5.5",
      ollamaUrl: "",
      customEndpoint: "https://openrouter.ai/api/v1",
      apiMode: "chat_completions",
      maxContextSize: 128000,
    })
    const body = cfg.buildBody(baseMessages, { temperature: 0.1, max_tokens: 500 }) as Record<string, unknown>

    expect(body.temperature).toBe(0.1)
    expect(body.max_tokens).toBe(500)
    expect(body.max_completion_tokens).toBeUndefined()
  })

  it("maps OpenRouter reasoning settings to its documented request object", () => {
    const cfg = getProviderConfig({
      provider: "custom",
      apiKey: "k",
      model: "vendor/reasoning-model",
      ollamaUrl: "",
      customEndpoint: "https://openrouter.ai/api/v1",
      apiMode: "chat_completions",
      maxContextSize: 128000,
    })

    expect(cfg.buildBody(baseMessages, { reasoning: { mode: "low" } }))
      .toMatchObject({ reasoning: { effort: "low" } })
    expect(cfg.buildBody(baseMessages, { reasoning: { mode: "off" } }))
      .toMatchObject({ reasoning: { effort: "none" } })
    expect(cfg.buildBody(baseMessages, {
      reasoning: { mode: "custom", budgetTokens: 2048 },
    })).toMatchObject({ reasoning: { max_tokens: 2048 } })
  })

  it("custom Kimi routes strip unsupported temperature overrides", () => {
    const cfg = getProviderConfig({
      provider: "custom",
      apiKey: "k",
      model: "kimi-k2.6",
      ollamaUrl: "",
      customEndpoint: "https://api.moonshot.ai/v1",
      apiMode: "chat_completions",
      maxContextSize: 256000,
    })
    const body = cfg.buildBody(baseMessages, { temperature: 0.1, max_tokens: 4096 }) as Record<string, unknown>

    expect(body.temperature).toBeUndefined()
    expect(body.max_tokens).toBe(4096)
  })

  it("Anthropic maps stop → stop_sequences and respects max_tokens override", () => {
    const cfg = getProviderConfig({
      provider: "anthropic",
      apiKey: "k",
      model: "claude-sonnet-4-5-20250929",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 200000,
    })
    const body = cfg.buildBody(baseMessages, {
      temperature: 0.1,
      stop: "END",
      max_tokens: 8192,
    }) as Record<string, unknown>
    expect(body.temperature).toBe(0.1)
    // Anthropic's wire field is `stop_sequences` (array), not `stop`.
    expect(body.stop_sequences).toEqual(["END"])
    expect(body.stop).toBeUndefined()
    expect(body.max_tokens).toBe(8192)
  })
})

// ── Origin header for local LLM providers (Ollama + custom OpenAI) ──
//
// History pinned by two user reports:
//
//   v0.3.11: a Windows user's packet capture showed plugin-http's
//   auto-injected origin was `http://tauri.localhost` (NOT
//   `tauri://localhost` like macOS/Linux), triggering Ollama 403
//   because the default OLLAMA_ORIGINS list has `tauri://*` but
//   not `http://tauri.localhost`. We started overriding the header.
//
//   v0.4.2: a user with Ollama on a LAN box at 192.168.x reported
//   "error sending request" (reqwest network error). Diagnosis:
//   our v0.3.11 fix set Origin to the request URL's own host
//   (`http://192.168.0.20:11434`), which IS NOT in the default
//   OLLAMA_ORIGINS list either. Older Ollama versions reject same-
//   origin literally if it's not on the allowlist; some close the
//   TCP connection rather than 403, which surfaces as a generic
//   reqwest error.
//
// Current strategy: ALWAYS send `Origin: http://localhost`
// regardless of where the actual server is. Ollama's default
// OLLAMA_ORIGINS unconditionally includes `http://localhost` (and
// the related `127.0.0.1` / port-wildcard variants); LM Studio /
// llama.cpp / vLLM don't check Origin at all. The header is purely
// a CORS-allowlist signal — semantically lying about "where this
// request came from" is fine because the server uses API keys (or
// no auth), not origin, for actual permission checks.

describe("Origin header — local LLM CORS workaround", () => {
  it("Ollama provider sends Origin: http://localhost when server is on localhost", () => {
    const cfg = getProviderConfig({
      provider: "ollama",
      apiKey: "",
      model: "llama3",
      ollamaUrl: "http://localhost:11434",
      customEndpoint: "",
      maxContextSize: 8192,
    })
    expect(cfg.headers["Origin"]).toBe("http://localhost")
  })

  it("Ollama provider sends Origin: http://localhost EVEN WHEN server is on a remote LAN IP", () => {
    // This is the v0.4.2 user-reported bug: previously the Origin
    // mirrored the request URL's host (`http://192.168.1.50:11434`),
    // which Ollama's default OLLAMA_ORIGINS doesn't include →
    // request rejected. Forcing localhost makes any LAN deployment
    // pass Ollama's CORS check.
    const cfg = getProviderConfig({
      provider: "ollama",
      apiKey: "",
      model: "llama3",
      ollamaUrl: "http://192.168.1.50:11434",
      customEndpoint: "",
      maxContextSize: 8192,
    })
    expect(cfg.headers["Origin"]).toBe("http://localhost")
  })

  it("Ollama provider Origin doesn't change with /v1 in the URL", () => {
    const cfg = getProviderConfig({
      provider: "ollama",
      apiKey: "",
      model: "llama3",
      ollamaUrl: "http://localhost:11434/v1",
      customEndpoint: "",
      maxContextSize: 8192,
    })
    expect(cfg.headers["Origin"]).toBe("http://localhost")
  })

  it("local custom OpenAI-compat endpoint gets the Origin override (LM Studio / llama.cpp / vLLM)", () => {
    // For these servers Origin is ignored entirely — but we send
    // the value anyway so behavior is uniform across local-LLM
    // providers and the rare hardened deployment that does check
    // CORS still works.
    const cfg = getProviderConfig({
      provider: "custom",
      apiKey: "",
      model: "qwen3",
      ollamaUrl: "",
      customEndpoint: "http://127.0.0.1:1234",
      maxContextSize: 8192,
      apiMode: "chat_completions",
    } as LlmConfig)
    expect(cfg.headers["Origin"]).toBe("http://localhost")
  })

  it("public custom OpenAI-compat endpoint does not get the local Origin override", () => {
    const cfg = getProviderConfig({
      provider: "custom",
      apiKey: "key",
      model: "qwen3",
      ollamaUrl: "",
      customEndpoint: "https://gateway.example.com/v1",
      maxContextSize: 8192,
      apiMode: "chat_completions",
    } as LlmConfig)
    expect(cfg.headers["Origin"]).toBeUndefined()
  })

  it("commercial provider (OpenAI) does NOT get an explicit Origin override", () => {
    // OpenAI's CORS doesn't care about Origin (auth is via API key).
    // Setting Origin would just be noise. Pin that we DON'T touch
    // commercial endpoints.
    const cfg = getProviderConfig({
      provider: "openai",
      apiKey: "k",
      model: "gpt-4o",
      ollamaUrl: "",
      customEndpoint: "",
      maxContextSize: 128000,
    })
    expect(cfg.headers["Origin"]).toBeUndefined()
  })

  it("Ollama provider always sets Origin even when the configured URL is malformed", () => {
    // The fixed-string Origin doesn't depend on URL parsing, so a
    // mistyped config can't strip the header. (The request itself
    // will fail elsewhere because the URL is bad — that's not this
    // helper's concern.)
    const cfg = getProviderConfig({
      provider: "ollama",
      apiKey: "",
      model: "llama3",
      ollamaUrl: "not a url",
      customEndpoint: "",
      maxContextSize: 8192,
    })
    expect(cfg.headers["Origin"]).toBe("http://localhost")
    expect(typeof cfg.url).toBe("string")
  })
})
