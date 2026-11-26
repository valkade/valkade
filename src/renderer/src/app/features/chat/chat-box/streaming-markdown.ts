/**
 * Incremental DOM reconciliation for live streaming markdown.
 *
 * Replaces raw `[innerHTML]` wholesale swaps so unchanged prefix blocks and text stay untouched
 * while newly arriving text deltas and blocks fade in softly via `.stream-md-fade`.
 */

/** CSS class applied to newly arriving text spans and elements while streaming. */
export const STREAM_FADE_CLASS = 'stream-md-fade';

/** Attribute marking inline wrapper spans created solely to fade in newly streamed text deltas. */
export const STREAM_FADE_SPAN_ATTR = 'data-stream-md-fade';

/** Duration after which a fade-in span is considered settled and safe to merge back into a text node. */
export const STREAM_FADE_SETTLE_MS = 380;

const fadeCreatedAt = new WeakMap<Node, number>();

type TargetItem =
  | { kind: 'text-run'; nodes: ChildNode[]; text: string }
  | { kind: 'element'; el: Element };

type SourceItem =
  | { kind: 'text'; text: string }
  | { kind: 'element'; el: Element };

function isFadeTextSpan(node: Node): node is HTMLSpanElement {
  return (
    node.nodeType === 1 &&
    (node as Element).tagName === 'SPAN' &&
    (node as Element).hasAttribute(STREAM_FADE_SPAN_ATTR)
  );
}

function isTextRunNode(node: Node): boolean {
  return node.nodeType === 3 || isFadeTextSpan(node);
}

function groupTargetChildren(parent: Element): TargetItem[] {
  const items: TargetItem[] = [];
  for (const child of Array.from(parent.childNodes)) {
    if (isTextRunNode(child)) {
      const prev = items[items.length - 1];
      const chunk = child.textContent ?? '';
      if (prev?.kind === 'text-run') {
        prev.nodes.push(child);
        prev.text += chunk;
      } else {
        items.push({ kind: 'text-run', nodes: [child], text: chunk });
      }
      continue;
    }
    if (child.nodeType === 1) {
      const el = child as Element;
      // Preserve live script output injected by RunButtonDirective beside runnable code blocks.
      if (el.classList.contains('code-block-output')) {
        continue;
      }
      items.push({ kind: 'element', el });
    }
  }
  return items;
}

function groupSourceChildren(parent: DocumentFragment | Element): SourceItem[] {
  const items: SourceItem[] = [];
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === 3) {
      const text = child.textContent ?? '';
      const prev = items[items.length - 1];
      if (prev?.kind === 'text') {
        prev.text += text;
      } else {
        items.push({ kind: 'text', text });
      }
      continue;
    }
    if (child.nodeType === 1) {
      items.push({ kind: 'element', el: child as Element });
    }
  }
  return items;
}

function createFadeTextNode(doc: Document, text: string, nowMs: number): ChildNode {
  // Inter-block newlines and pure whitespace do not need fade wrapper spans.
  if (!text.trim()) {
    return doc.createTextNode(text);
  }
  const span = doc.createElement('span');
  span.className = STREAM_FADE_CLASS;
  span.setAttribute(STREAM_FADE_SPAN_ATTR, '1');
  span.textContent = text;
  fadeCreatedAt.set(span, nowMs);
  return span;
}

function markElementFadeIn(el: Element, nowMs: number): void {
  el.classList.add(STREAM_FADE_CLASS);
  fadeCreatedAt.set(el, nowMs);
  const onAnimationEnd = (event: Event): void => {
    // Ignore bubbling animationend events from descendant fade spans/blocks.
    if (event.target !== el) {
      return;
    }
    el.removeEventListener('animationend', onAnimationEnd);
    el.classList.remove(STREAM_FADE_CLASS);
    fadeCreatedAt.delete(el);
  };
  el.addEventListener('animationend', onAnimationEnd);
}

function isSettledFadeSpan(node: ChildNode, nowMs: number): boolean {
  if (!isFadeTextSpan(node)) {
    return false;
  }
  const created = fadeCreatedAt.get(node);
  return created === undefined || nowMs - created >= STREAM_FADE_SETTLE_MS;
}

/**
 * Fold leading settled fade spans into a single plain text node so long responses do not
 * accumulate hundreds of wrapper spans while still-animating spans remain undisturbed.
 */
function coalesceSettledTextRun(parent: Element, run: { nodes: ChildNode[]; text: string }, nowMs: number): void {
  let settledEnd = 0;
  while (settledEnd < run.nodes.length) {
    const node = run.nodes[settledEnd]!;
    if (node.nodeType === 3 || isSettledFadeSpan(node, nowMs)) {
      settledEnd++;
    } else {
      break;
    }
  }
  if (settledEnd <= 1 && (settledEnd === 0 || run.nodes[0]!.nodeType === 3)) {
    return;
  }
  let merged = '';
  for (let i = 0; i < settledEnd; i++) {
    merged += run.nodes[i]!.textContent ?? '';
  }
  const first = run.nodes[0]!;
  const doc = parent.ownerDocument;
  let anchor: Text;
  if (first.nodeType === 3) {
    anchor = first as Text;
    anchor.nodeValue = merged;
  } else {
    anchor = doc.createTextNode(merged);
    parent.insertBefore(anchor, first);
    parent.removeChild(first);
  }
  for (let i = 1; i < settledEnd; i++) {
    parent.removeChild(run.nodes[i]!);
  }
  run.nodes.splice(0, settledEnd, anchor);
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) {
    i++;
  }
  return i;
}

/** Trim `run.nodes` to keep only the first `keepChars` characters, preserving prefix nodes intact. */
function trimTextRunToLength(parent: Element, run: { nodes: ChildNode[]; text: string }, keepChars: number): void {
  let remaining = keepChars;
  const kept: ChildNode[] = [];
  for (const node of run.nodes) {
    const chunk = node.textContent ?? '';
    if (remaining <= 0) {
      parent.removeChild(node);
      continue;
    }
    if (chunk.length <= remaining) {
      kept.push(node);
      remaining -= chunk.length;
      continue;
    }
    if (node.nodeType === 3) {
      node.nodeValue = chunk.slice(0, remaining);
    } else {
      node.textContent = chunk.slice(0, remaining);
    }
    kept.push(node);
    remaining = 0;
  }
  run.nodes = kept;
  run.text = run.text.slice(0, keepChars);
}

function syncAttributes(target: Element, source: Element, nowMs: number): void {
  const created = fadeCreatedAt.get(target);
  const keepFadeClass =
    target.classList.contains(STREAM_FADE_CLASS) &&
    created !== undefined &&
    nowMs - created < STREAM_FADE_SETTLE_MS;
  const preserveRunAttached = target.classList.contains('code-block-run-btn');

  for (const attr of Array.from(target.attributes)) {
    if (!source.hasAttribute(attr.name)) {
      if (attr.name === 'class' && keepFadeClass) {
        if (target.getAttribute('class') !== STREAM_FADE_CLASS) {
          target.setAttribute('class', STREAM_FADE_CLASS);
        }
      } else if (preserveRunAttached && attr.name === 'data-attached') {
        continue;
      } else {
        target.removeAttribute(attr.name);
      }
    }
  }

  for (const attr of Array.from(source.attributes)) {
    if (attr.name === 'class') {
      const nextClass = keepFadeClass
        ? attr.value
          ? `${attr.value} ${STREAM_FADE_CLASS}`
          : STREAM_FADE_CLASS
        : attr.value;
      if (target.getAttribute('class') !== nextClass) {
        target.setAttribute('class', nextClass);
      }
      continue;
    }
    // Avoid rewriting an identical `src` on <img> so the browser never re-fetches / flickers it.
    if (target.getAttribute(attr.name) !== attr.value) {
      target.setAttribute(attr.name, attr.value);
    }
  }
}

function firstNodeOf(item: TargetItem): ChildNode {
  return item.kind === 'element' ? item.el : item.nodes[0]!;
}

function lastNodeOf(item: TargetItem): ChildNode {
  return item.kind === 'element' ? item.el : item.nodes[item.nodes.length - 1]!;
}

function removeTargetItem(parent: Element, item: TargetItem): void {
  if (item.kind === 'element') {
    parent.removeChild(item.el);
    return;
  }
  for (const node of item.nodes) {
    parent.removeChild(node);
  }
}

function textAlreadyShown(prevText: string, nextText: string): boolean {
  if (!prevText || !nextText) {
    return false;
  }
  if (prevText.includes(nextText)) {
    return true;
  }
  // Strip raw markdown syntax markers so closing delimiters that also add characters
  // (e.g. `**bol` -> `bold`, `## Headin` -> `Heading`, `- Ite` -> `Item`) do not blink out.
  const stripped = prevText
    .replace(/^[\s*_~`#>[()-]+|^\s*\d+[.)]\s+/, '')
    .replace(/[*_~`]+$/, '')
    .trim();
  return stripped.length > 0 && nextText.trimStart().startsWith(stripped);
}

function reconcileChildren(
  target: Element,
  source: DocumentFragment | Element,
  doc: Document,
  nowMs: number,
): void {
  const targetItems = groupTargetChildren(target);
  const sourceItems = groupSourceChildren(source);
  let shortenedPriorTextTail = false;

  for (let i = 0; i < sourceItems.length; i++) {
    const s = sourceItems[i]!;
    const t = targetItems[i];

    // Brand-new trailing item.
    if (!t) {
      if (s.kind === 'text') {
        target.appendChild(createFadeTextNode(doc, s.text, nowMs));
      } else {
        // If the immediately preceding text run just lost its raw markdown suffix (e.g. `**bol` ->
        // `<strong>bold</strong>`), adopt the inline element without fading it from opacity 0 so
        // already-visible letters do not blink out.
        if (!shortenedPriorTextTail) {
          markElementFadeIn(s.el, nowMs);
        }
        target.appendChild(s.el);
      }
      shortenedPriorTextTail = false;
      continue;
    }

    // Both text: preserve unchanged prefix, fade in only the newly appended suffix.
    if (t.kind === 'text-run' && s.kind === 'text') {
      coalesceSettledTextRun(target, t, nowMs);
      if (s.text === t.text) {
        shortenedPriorTextTail = false;
        continue;
      }
      const prefixLen = commonPrefixLength(t.text, s.text);
      const lostTail = prefixLen < t.text.length;
      if (lostTail) {
        trimTextRunToLength(target, t, prefixLen);
      }
      const added = s.text.slice(prefixLen);
      if (added) {
        const fadeNode = createFadeTextNode(doc, added, nowMs);
        const anchor = t.nodes[t.nodes.length - 1];
        if (anchor) {
          target.insertBefore(fadeNode, anchor.nextSibling);
        } else {
          const nextTarget = targetItems[i + 1];
          target.insertBefore(fadeNode, nextTarget ? firstNodeOf(nextTarget) : null);
        }
        t.nodes.push(fadeNode);
        t.text += added;
      }
      shortenedPriorTextTail = lostTail && !added;
      continue;
    }

    // Matching element tag: sync attributes and recurse into children.
    if (t.kind === 'element' && s.kind === 'element' && t.el.tagName === s.el.tagName) {
      syncAttributes(t.el, s.el, nowMs);
      reconcileChildren(t.el, s.el, doc, nowMs);
      shortenedPriorTextTail = false;
      continue;
    }

    // Structural change at the same slot (e.g. `<p>` became `<h2>`, or `**bold` became `<strong>bold</strong>`).
    const refNode = lastNodeOf(t).nextSibling;
    const prevText = t.kind === 'element' ? (t.el.textContent ?? '') : t.text;
    removeTargetItem(target, t);

    if (s.kind === 'text') {
      const node =
        textAlreadyShown(prevText, s.text)
          ? doc.createTextNode(s.text)
          : createFadeTextNode(doc, s.text, nowMs);
      target.insertBefore(node, refNode);
    } else {
      const nextText = s.el.textContent ?? '';
      // Avoid blinking already-visible text back to opacity 0 when markdown closes inline/block syntax.
      const alreadyShown = textAlreadyShown(prevText, nextText);
      if (!alreadyShown && !shortenedPriorTextTail) {
        markElementFadeIn(s.el, nowMs);
      }
      target.insertBefore(s.el, refNode);
    }
    shortenedPriorTextTail = false;
  }

  for (let i = sourceItems.length; i < targetItems.length; i++) {
    removeTargetItem(target, targetItems[i]!);
  }
}

/**
 * Apply sanitized markdown HTML to `container`.
 *
 * When `animate` is true, reconciles existing DOM nodes against the newly parsed HTML so only
 * newly appended text deltas and blocks fade in. When `animate` is false, writes `innerHTML`
 * directly with no fade wrappers.
 */
export function patchStreamingMarkdownDom(
  container: HTMLElement,
  html: string,
  options: { animate: boolean; nowMs?: number },
): void {
  if (!options.animate) {
    container.innerHTML = html;
    return;
  }
  const doc = container.ownerDocument;
  const template = doc.createElement('template');
  template.innerHTML = html;
  reconcileChildren(container, template.content, doc, options.nowMs ?? Date.now());
}
