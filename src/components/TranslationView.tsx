import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import React from "react";
import { SkillMarkdown } from "./SkillMarkdown";
import { cn } from "../utils";
import { stripFrontmatter, stripTranslatedPreamble } from "../utils/markdownUtils";

interface TranslationViewProps {
  original: string;
  translated: string;
  skillName?: string;
  skillDescription?: string | null;
  className?: string;
}

/**
 * Query all rendered block-level elements from a container.
 * These are the actual DOM nodes produced by ReactMarkdown.
 */
const BLOCK_SELECTOR =
  "h1, h2, h3, h4, h5, h6, p, pre, ul, ol, blockquote, table, hr";

function queryBlocks(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll(BLOCK_SELECTOR));
}

/**
 * Find the block whose top edge is at or just above the container's viewport top,
 * and return the fractional position within that block (0 = block top, 1 = block bottom).
 */
function findScrollPosition(
  container: HTMLElement,
  blocks: HTMLElement[],
): { index: number; fraction: number } {
  const containerTop = container.getBoundingClientRect().top;
  let idx = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].getBoundingClientRect().top <= containerTop + 1) {
      idx = i;
      break;
    }
  }
  const blockRect = blocks[idx].getBoundingClientRect();
  const blockHeight = blockRect.height;
  const fraction = blockHeight > 0
    ? Math.min(1, Math.max(0, (containerTop - blockRect.top) / blockHeight))
    : 0;
  return { index: idx, fraction };
}

/**
 * Scroll `container` so that block[index] is at the viewport top, offset by
 * `fraction` of the block's height.  This reproduces the exact scroll ratio
 * from the source pane even when the two panes' blocks have different heights.
 */
function scrollToPosition(
  container: HTMLElement,
  blocks: HTMLElement[],
  index: number,
  fraction: number,
) {
  const el = blocks[index];
  if (!el) return;
  // el.getBoundingClientRect().top is relative to viewport.
  // container.getBoundingClientRect().top is the viewport top of the scroll area.
  // el.offsetTop is relative to the scroll container's content origin.
  const elTop = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
  const elHeight = el.getBoundingClientRect().height;
  const targetScrollTop = elTop + elHeight * fraction;
  container.scrollTo({ top: Math.max(0, targetScrollTop), behavior: "smooth" });
}

export function TranslationView({
  original,
  translated,
  skillName,
  skillDescription,
  className,
}: TranslationViewProps) {
  const [activeBlock, setActiveBlock] = useState(-1);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const leftBlocksRef = useRef<HTMLElement[]>([]);
  const rightBlocksRef = useRef<HTMLElement[]>([]);
  const isSyncingRef = useRef(false);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clickedSideRef = useRef<"left" | "right" | null>(null);

  const originalContent = useMemo(() => stripFrontmatter(original), [original]);
  const translatedContent = useMemo(
    () => stripTranslatedPreamble(stripFrontmatter(translated), original, skillName, skillDescription),
    [translated, original, skillName, skillDescription],
  );

  // Observe DOM mutations in each pane to keep block references up to date.
  // This runs whenever ReactMarkdown finishes rendering.
  const observeBlocks = useCallback(
    (container: HTMLDivElement, side: "left" | "right") => {
      const update = () => {
        const blocks = queryBlocks(container);
        if (side === "left") leftBlocksRef.current = blocks;
        else rightBlocksRef.current = blocks;
      };

      // Initial read
      update();

      const observer = new MutationObserver(update);
      observer.observe(container, { childList: true, subtree: true });
      return observer;
    },
    [],
  );

  // Set up observers
  useEffect(() => {
    const left = leftRef.current;
    const right = rightRef.current;
    if (!left || !right) return;

    const obsLeft = observeBlocks(left, "left");
    const obsRight = observeBlocks(right, "right");

    return () => {
      obsLeft.disconnect();
      obsRight.disconnect();
    };
  }, [observeBlocks, originalContent, translatedContent]);

  // Scroll one pane so the block at `index` is at the top (used for click).
  const scrollToBlockIndex = useCallback(
    (container: HTMLDivElement, blocks: HTMLElement[], index: number) => {
      const el = blocks[index];
      if (!el) return;
      isSyncingRef.current = true;
      scrollToPosition(container, blocks, index, 0);
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      syncTimerRef.current = setTimeout(() => {
        isSyncingRef.current = false;
        clickedSideRef.current = null;
      }, 400);
    },
    [],
  );

  // Handle click on a block element in either pane.
  const handleBlockClick = useCallback(
    (side: "left" | "right", index: number) => {
      clickedSideRef.current = side;
      setActiveBlock(index);
      const left = leftRef.current;
      const right = rightRef.current;
      if (left) scrollToBlockIndex(left, leftBlocksRef.current, index);
      if (right) scrollToBlockIndex(right, rightBlocksRef.current, index);
    },
    [scrollToBlockIndex],
  );

  // Scroll sync: when scrolling one pane, find the top block and scroll
  // the other pane to align the corresponding block.
  useEffect(() => {
    const left = leftRef.current;
    const right = rightRef.current;
    if (!left || !right) return;

    const syncScroll = (from: HTMLDivElement, fromBlocks: HTMLElement[], to: HTMLDivElement, toBlocks: HTMLElement[]) => {
      if (isSyncingRef.current) return;
      if (fromBlocks.length === 0 || toBlocks.length === 0) return;

      const pos = findScrollPosition(from, fromBlocks);
      setActiveBlock(pos.index);

      isSyncingRef.current = true;
      scrollToPosition(to, toBlocks, pos.index, pos.fraction);
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      syncTimerRef.current = setTimeout(() => {
        isSyncingRef.current = false;
      }, 80);
    };

    let leftTicking = false;
    let rightTicking = false;

    const handleLeftScroll = () => {
      if (leftTicking || isSyncingRef.current || clickedSideRef.current) return;
      leftTicking = true;
      requestAnimationFrame(() => {
        syncScroll(left, leftBlocksRef.current, right, rightBlocksRef.current);
        leftTicking = false;
      });
    };

    const handleRightScroll = () => {
      if (rightTicking || isSyncingRef.current || clickedSideRef.current) return;
      rightTicking = true;
      requestAnimationFrame(() => {
        syncScroll(right, rightBlocksRef.current, left, leftBlocksRef.current);
        rightTicking = false;
      });
    };

    left.addEventListener("scroll", handleLeftScroll, { passive: true });
    right.addEventListener("scroll", handleRightScroll, { passive: true });
    return () => {
      left.removeEventListener("scroll", handleLeftScroll);
      right.removeEventListener("scroll", handleRightScroll);
    };
  }, [originalContent, translatedContent]);

  useEffect(() => {
    return () => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
  }, []);

  return (
    <div className={cn("grid h-full min-h-0 grid-cols-2 gap-1", className)}>
      <Pane
        ref={leftRef}
        label="Original"
        content={originalContent}
        activeBlock={activeBlock}
        onBlockClick={(idx) => handleBlockClick("left", idx)}
      />
      <Pane
        ref={rightRef}
        label="Translated"
        content={translatedContent}
        activeBlock={activeBlock}
        onBlockClick={(idx) => handleBlockClick("right", idx)}
      />
    </div>
  );
}

// ---- Pane component ----

interface PaneProps {
  label: string;
  content: string;
  activeBlock: number;
  onBlockClick: (index: number) => void;
}

const Pane = React.forwardRef<HTMLDivElement, PaneProps>(function Pane(
  { label, content, activeBlock, onBlockClick },
  ref
) {
  const contentRef = useRef<HTMLDivElement>(null);

  // Attach click delegation to the content container
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Walk up to find a block-level ancestor
      const block = target.closest(BLOCK_SELECTOR);
      if (!block || !el.contains(block)) return;

      // Find the index among all block elements
      const allBlocks = Array.from(el.querySelectorAll(BLOCK_SELECTOR));
      const idx = allBlocks.indexOf(block as HTMLElement);
      if (idx >= 0) onBlockClick(idx);
    };

    el.addEventListener("click", handleClick);
    return () => el.removeEventListener("click", handleClick);
  }, [onBlockClick]);

  // Highlight the active block
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const allBlocks = Array.from(el.querySelectorAll(BLOCK_SELECTOR)) as HTMLElement[];
    allBlocks.forEach((block, idx) => {
      if (idx === activeBlock) {
        block.classList.add("translation-block-active");
      } else {
        block.classList.remove("translation-block-active");
      }
    });
  }, [activeBlock]);

  return (
    <div className="flex min-h-0 flex-col rounded-xl border border-border-subtle bg-bg-secondary">
      <div className="shrink-0 border-b border-border-subtle px-4 py-2">
        <span className="text-[12px] font-medium text-muted">{label}</span>
      </div>
      <div ref={ref} className="flex-1 overflow-y-auto px-3 py-3 scrollbar-hide">
        <div ref={contentRef} className="translation-pane-content">
          <SkillMarkdown content={content} />
        </div>
      </div>
    </div>
  );
});
