/**
 * Strip YAML frontmatter from the start of markdown content.
 * Matches the Rust backend's lenient parsing: finds the first `---`
 * and the next `---`, regardless of line breaks.
 */
export function stripFrontmatter(content: string): string {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return content;
  const afterOpen = trimmed.slice(3);
  const end = afterOpen.indexOf("---");
  return end === -1 ? content : afterOpen.slice(end + 3).trimStart();
}

/**
 * Strip the AI-added skill name heading and description from the start of
 * translated content, so the right pane matches the left pane structure.
 * Only removes content that doesn't exist in the original.
 */
export function stripTranslatedPreamble(
  translated: string,
  _original: string,
  skillName?: string,
  skillDescription?: string | null,
): string {
  let result = translated.trimStart();

  // Normalize for fuzzy comparison (ignore case and punctuation)
  const normalize = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, "").trim();

  // --- Step 1: Strip leading H1 only if it restates the skill name ---
  const translatedH1 = result.match(/^#\s+(.+)\n*/);
  if (translatedH1 && skillName) {
    const headingText = translatedH1[1].trim();
    if (normalize(headingText) === normalize(skillName)) {
      result = result.slice(translatedH1[0].length).trimStart();
    }
  }

  // --- Step 2: Strip the description paragraph only if H1 was stripped ---
  if (translatedH1 && skillName && skillDescription?.trim()) {
    const headingText = translatedH1[1].trim();
    const h1WasStripped = normalize(headingText) === normalize(skillName);

    if (h1WasStripped) {
      const descLines = skillDescription.trim().split("\n");
      const descLineCount = descLines.length;

      const startsWithParagraph = result.length > 0
        && !result.startsWith("#")
        && !result.startsWith("```")
        && !result.startsWith(">")
        && !result.startsWith("|")
        && !/^-{3,}|\*{3,}|_{3,}/.test(result)
        && !/^(\d+\.|\*|-|\+)\s/.test(result);

      if (startsWithParagraph) {
        const paragraphMatch = result.match(/^((?:[^\n]+\n?)*?)\n\n/);
        const paragraphLines = paragraphMatch
          ? paragraphMatch[1].split("\n").length
          : result.split("\n").length;

        if (Math.abs(paragraphLines - descLineCount) <= 1) {
          const endIdx = paragraphMatch ? paragraphMatch[0].length : result.length;
          result = result.slice(endIdx).trimStart();
        }
      }
    }
  }

  return result;
}
