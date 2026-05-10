import {
  getSettings,
  getTranslationDocument,
  saveTranslationDocument,
} from "./tauri";

export type TranslationProvider = "openai" | "gemini" | "anthropic";

export interface TranslationConfig {
  provider: TranslationProvider;
  apiUrl: string;
  apiKey: string;
  model: string;
}

const DEFAULT_URLS: Record<TranslationProvider, string> = {
  openai: "https://api.openai.com/v1/chat/completions",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  anthropic: "https://api.anthropic.com/v1/messages",
};

const DEFAULT_MODELS: Record<TranslationProvider, string> = {
  openai: "gpt-4o-mini",
  gemini: "gemini-2.0-flash",
  anthropic: "claude-haiku-4-5-20251001",
};

export const PROVIDER_DEFAULTS = { urls: DEFAULT_URLS, models: DEFAULT_MODELS };

const SYSTEM_PROMPT =
  "You are a professional translator. Translate the following markdown content to the target language.\n\n" +
  "CRITICAL RULES:\n" +
  "1. Preserve the EXACT document structure — every heading, paragraph, code block, list, blockquote, " +
  "table, and horizontal rule must remain as a separate block. Do NOT merge or split paragraphs.\n" +
  "2. Keep all markdown formatting, code blocks, links, frontmatter exactly as-is.\n" +
  "3. Only translate natural language text. Do NOT translate: code, URLs, file paths, variable names, " +
  "command names, or technical identifiers.\n" +
  "4. Preserve blank lines between blocks exactly as they appear in the original.\n" +
  "5. Output ONLY the translated markdown, nothing else.";

function buildRequestBody(
  config: TranslationConfig,
  content: string,
  targetLang: string,
): { url: string; headers: Record<string, string>; body: string } {
  const userMessage = `Translate to ${targetLang}:\n\n${content}`;

  switch (config.provider) {
    case "openai": {
      return {
        url: config.apiUrl || DEFAULT_URLS.openai,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model || DEFAULT_MODELS.openai,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userMessage },
          ],
          temperature: 0.3,
        }),
      };
    }
    case "gemini": {
      const model = config.model || DEFAULT_MODELS.gemini;
      const baseUrl = config.apiUrl || DEFAULT_URLS.gemini;
      const url = `${baseUrl}/models/${model}:generateContent?key=${config.apiKey}`;
      return {
        url,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ parts: [{ text: userMessage }] }],
          generationConfig: { temperature: 0.3 },
        }),
      };
    }
    case "anthropic": {
      return {
        url: config.apiUrl || DEFAULT_URLS.anthropic,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: config.model || DEFAULT_MODELS.anthropic,
          max_tokens: 8192,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMessage }],
          temperature: 0.3,
        }),
      };
    }
  }
}

function extractResponseText(
  provider: TranslationProvider,
  data: Record<string, unknown>,
): string {
  switch (provider) {
    case "openai": {
      const choices = data.choices as Array<Record<string, unknown>> | undefined;
      const message = choices?.[0]?.message as Record<string, unknown> | undefined;
      return (message?.content as string) ?? "";
    }
    case "gemini": {
      const candidates = data.candidates as Array<Record<string, unknown>> | undefined;
      const content = candidates?.[0]?.content as Record<string, unknown> | undefined;
      const parts = content?.parts as Array<Record<string, unknown>> | undefined;
      return (parts?.[0]?.text as string) ?? "";
    }
    case "anthropic": {
      const content = data.content as Array<Record<string, unknown>> | undefined;
      const textBlock = content?.find((block) => block.type === "text");
      return (textBlock?.text as string) ?? "";
    }
  }
}

export async function loadTranslationConfig(): Promise<TranslationConfig | null> {
  const [provider, apiUrl, apiKey, model] = await Promise.all([
    getSettings("translation_api_provider"),
    getSettings("translation_api_url"),
    getSettings("translation_api_key"),
    getSettings("translation_api_model"),
  ]);

  if (!apiKey) return null;

  return {
    provider: (provider as TranslationProvider) || "openai",
    apiUrl: apiUrl || "",
    apiKey,
    model: model || "",
  };
}

/** Load cached translation from disk. Returns null if not cached. */
export async function loadCachedTranslation(
  skillId: string,
  lang: string,
): Promise<string | null> {
  try {
    const doc = await getTranslationDocument(skillId, lang);
    return doc?.content ?? null;
  } catch {
    return null;
  }
}

/** Translate a short text via API (no persistence). */
export async function translateShortText(
  text: string,
  targetLang: string,
): Promise<string> {
  const config = await loadTranslationConfig();
  if (!config) {
    throw new Error("Translation API not configured.");
  }

  const shortPrompt =
    "Translate the following text to the target language. Output ONLY the translation, nothing else.";

  const userMessage = `Translate to ${targetLang}:\n\n${text}`;
  const { url, headers, body } = buildRequestBody(config, userMessage, targetLang);

  // Override system prompt for short text
  let finalBody: string;
  const parsed = JSON.parse(body);
  if (config.provider === "openai") {
    parsed.messages[0].content = shortPrompt;
    finalBody = JSON.stringify(parsed);
  } else if (config.provider === "anthropic") {
    parsed.system = shortPrompt;
    finalBody = JSON.stringify(parsed);
  } else {
    parsed.system_instruction.parts[0].text = shortPrompt;
    finalBody = JSON.stringify(parsed);
  }

  const resp = await fetch(url, { method: "POST", headers, body: finalBody });
  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    throw new Error(`Translation API error (${resp.status}): ${err || resp.statusText}`);
  }

  const data = (await resp.json()) as Record<string, unknown>;
  const result = extractResponseText(config.provider, data);
  if (!result) throw new Error("Translation API returned empty response.");
  return result;
}

/** Translate via API, then persist the result to disk. */
export async function translateAndSave(
  skillId: string,
  content: string,
  targetLang: string,
): Promise<string> {
  const config = await loadTranslationConfig();
  if (!config) {
    throw new Error("Translation API not configured. Please set up your API key in Settings.");
  }

  const { url, headers, body } = buildRequestBody(config, content, targetLang);

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body,
  });

  if (!resp.ok) {
    const errorText = await resp.text().catch(() => "");
    throw new Error(`Translation API error (${resp.status}): ${errorText || resp.statusText}`);
  }

  const data = (await resp.json()) as Record<string, unknown>;
  const text = extractResponseText(config.provider, data);

  if (!text) {
    throw new Error("Translation API returned empty response.");
  }

  // Persist to disk so next open is instant
  try {
    await saveTranslationDocument(skillId, targetLang, text);
  } catch (e) {
    console.warn("Failed to save translation to disk:", e);
  }

  return text;
}
