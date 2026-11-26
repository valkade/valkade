import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import {
  STREAM_FADE_CLASS,
  STREAM_FADE_SETTLE_MS,
  STREAM_FADE_SPAN_ATTR,
  patchStreamingMarkdownDom,
} from './streaming-markdown';
import { StreamingMarkdownDirective } from './streaming-markdown.directive';

describe('patchStreamingMarkdownDom', () => {
  it('writes HTML directly with no fade wrappers when animate is false', () => {
    const host = document.createElement('div');
    patchStreamingMarkdownDom(host, '<p>Hello <strong>world</strong></p>', { animate: false });
    expect(host.innerHTML).toBe('<p>Hello <strong>world</strong></p>');
    expect(host.querySelector(`.${STREAM_FADE_CLASS}`)).toBeNull();
  });

  it('fades in newly appended text deltas without replacing existing prefix nodes', () => {
    const host = document.createElement('div');
    patchStreamingMarkdownDom(host, '<p>Hello</p>', { animate: true, nowMs: 1000 });
    const p = host.querySelector('p')!;
    expect(p).not.toBeNull();
    expect(p.classList.contains(STREAM_FADE_CLASS)).toBe(true);
    expect(p.textContent).toBe('Hello');

    patchStreamingMarkdownDom(host, '<p>Hello world</p>', { animate: true, nowMs: 1050 });
    expect(host.querySelector('p')).toBe(p);
    const fadeSpans = p.querySelectorAll(`span[${STREAM_FADE_SPAN_ATTR}]`);
    expect(fadeSpans.length).toBe(1);
    expect(fadeSpans[0]!.textContent).toBe(' world');
    expect(fadeSpans[0]!.classList.contains(STREAM_FADE_CLASS)).toBe(true);
    expect(p.textContent).toBe('Hello world');

    patchStreamingMarkdownDom(host, '<p>Hello world!</p>', { animate: true, nowMs: 1100 });
    const spansAfter = p.querySelectorAll(`span[${STREAM_FADE_SPAN_ATTR}]`);
    expect(spansAfter.length).toBe(2);
    expect(spansAfter[0]!.textContent).toBe(' world');
    expect(spansAfter[1]!.textContent).toBe('!');
    expect(p.textContent).toBe('Hello world!');
  });

  it('coalesces settled leading fade spans into plain text nodes while keeping active fades intact', () => {
    const host = document.createElement('div');
    patchStreamingMarkdownDom(host, '<p>One</p>', { animate: true, nowMs: 0 });
    patchStreamingMarkdownDom(host, '<p>One two</p>', { animate: true, nowMs: 100 });
    patchStreamingMarkdownDom(host, '<p>One two three</p>', { animate: true, nowMs: 200 });

    // After STREAM_FADE_SETTLE_MS has elapsed for " two" (100 -> 500), " three" (200 -> 500) is still active.
    patchStreamingMarkdownDom(host, '<p>One two three four</p>', {
      animate: true,
      nowMs: 100 + STREAM_FADE_SETTLE_MS,
    });
    const p = host.querySelector('p')!;
    expect(p.textContent).toBe('One two three four');
    const spans = [...p.querySelectorAll(`span[${STREAM_FADE_SPAN_ATTR}]`)].map((s) => s.textContent);
    expect(spans).toEqual([' three', ' four']);
  });

  it('keeps earlier completed paragraphs untouched and fades in new trailing blocks', () => {
    const host = document.createElement('div');
    patchStreamingMarkdownDom(host, '<p>First paragraph.</p>', { animate: true, nowMs: 1000 });
    const firstP = host.querySelector('p')!;

    patchStreamingMarkdownDom(host, '<p>First paragraph.</p><p>Second paragraph.</p>', {
      animate: true,
      nowMs: 1500,
    });
    const paragraphs = host.querySelectorAll('p');
    expect(paragraphs.length).toBe(2);
    expect(paragraphs[0]).toBe(firstP);
    expect(paragraphs[1]!.classList.contains(STREAM_FADE_CLASS)).toBe(true);
    expect(paragraphs[1]!.textContent).toBe('Second paragraph.');
  });

  it('does not blink already-visible text when inline markdown syntax closes', () => {
    const host = document.createElement('div');
    patchStreamingMarkdownDom(host, '<p>See **bol</p>', { animate: true, nowMs: 1000 });
    patchStreamingMarkdownDom(host, '<p>See <strong>bold</strong> now</p>', { animate: true, nowMs: 1050 });
    const p = host.querySelector('p')!;
    const strong = p.querySelector('strong')!;
    expect(strong).not.toBeNull();
    expect(strong.textContent).toBe('bold');
    // The newly formatted inline element should not fade from opacity 0 over already-shown letters.
    expect(strong.classList.contains(STREAM_FADE_CLASS)).toBe(false);
    // The trailing new text after it does fade in.
    const fadeSpans = p.querySelectorAll(`span[${STREAM_FADE_SPAN_ATTR}]`);
    expect(fadeSpans.length).toBe(1);
    expect(fadeSpans[0]!.textContent).toBe(' now');
    expect(p.textContent).toBe('See bold now');
  });

  it('preserves syntax-highlighted spans inside code blocks and fades in trailing tokens', () => {
    const host = document.createElement('div');
    patchStreamingMarkdownDom(
      host,
      '<pre><code class="hljs language-ts"><span class="hljs-keyword">const</span> x = 1</code></pre>',
      { animate: true, nowMs: 1000 },
    );
    const keywordSpan = host.querySelector('.hljs-keyword')!;

    patchStreamingMarkdownDom(
      host,
      '<pre><code class="hljs language-ts"><span class="hljs-keyword">const</span> x = 10;</code></pre>',
      { animate: true, nowMs: 1050 },
    );
    expect(host.querySelector('.hljs-keyword')).toBe(keywordSpan);
    const code = host.querySelector('code')!;
    expect(code.textContent).toBe('const x = 10;');
    const fadeSpans = code.querySelectorAll(`span[${STREAM_FADE_SPAN_ATTR}]`);
    expect(fadeSpans.length).toBe(1);
    expect(fadeSpans[0]!.textContent).toBe('0;');
  });

  it('removes the fade class from newly added block elements once animationend fires', () => {
    const host = document.createElement('div');
    patchStreamingMarkdownDom(host, '<p>Hello</p>', { animate: true, nowMs: 1000 });
    const p = host.querySelector('p')!;
    expect(p.classList.contains(STREAM_FADE_CLASS)).toBe(true);
    p.dispatchEvent(new Event('animationend'));
    expect(p.classList.contains(STREAM_FADE_CLASS)).toBe(false);
  });

  it('ignores bubbling animationend events from child fade spans on a parent block', () => {
    const host = document.createElement('div');
    patchStreamingMarkdownDom(host, '<p>Hello</p>', { animate: true, nowMs: 1000 });
    patchStreamingMarkdownDom(host, '<p>Hello world</p>', { animate: true, nowMs: 1050 });
    const p = host.querySelector('p')!;
    const span = p.querySelector(`span[${STREAM_FADE_SPAN_ATTR}]`)!;
    expect(p.classList.contains(STREAM_FADE_CLASS)).toBe(true);

    span.dispatchEvent(new Event('animationend', { bubbles: true }));
    expect(p.classList.contains(STREAM_FADE_CLASS)).toBe(true);

    p.dispatchEvent(new Event('animationend'));
    expect(p.classList.contains(STREAM_FADE_CLASS)).toBe(false);
  });

  it('does not blink already-shown text when inline or block markdown closes at slot start', () => {
    const host = document.createElement('div');
    patchStreamingMarkdownDom(host, '<p>**bol</p>', { animate: true, nowMs: 1000 });
    patchStreamingMarkdownDom(host, '<p><strong>bold</strong></p>', { animate: true, nowMs: 1050 });
    expect(host.querySelector('strong')?.classList.contains(STREAM_FADE_CLASS)).toBe(false);

    const headingHost = document.createElement('div');
    patchStreamingMarkdownDom(headingHost, '<p>## Overvie</p>', { animate: true, nowMs: 1000 });
    patchStreamingMarkdownDom(headingHost, '<h2>Overview</h2>', { animate: true, nowMs: 1050 });
    expect(headingHost.querySelector('h2')?.classList.contains(STREAM_FADE_CLASS)).toBe(false);

    const listHost = document.createElement('div');
    patchStreamingMarkdownDom(listHost, '<p>- First ite</p>', { animate: true, nowMs: 1000 });
    patchStreamingMarkdownDom(listHost, '<ul><li>First item</li></ul>', { animate: true, nowMs: 1050 });
    expect(listHost.querySelector('ul')?.classList.contains(STREAM_FADE_CLASS)).toBe(false);
  });

  it('coalesces settled fade spans in completed earlier paragraphs on later updates', () => {
    const host = document.createElement('div');
    patchStreamingMarkdownDom(host, '<p>One</p>', { animate: true, nowMs: 0 });
    patchStreamingMarkdownDom(host, '<p>One two</p>', { animate: true, nowMs: 50 });
    expect(host.querySelectorAll(`p span[${STREAM_FADE_SPAN_ATTR}]`).length).toBe(1);

    patchStreamingMarkdownDom(host, '<p>One two</p><p>Next</p>', {
      animate: true,
      nowMs: 50 + STREAM_FADE_SETTLE_MS,
    });
    const firstP = host.querySelectorAll('p')[0]!;
    expect(firstP.textContent).toBe('One two');
    expect(firstP.querySelectorAll(`span[${STREAM_FADE_SPAN_ATTR}]`).length).toBe(0);
  });

  it('preserves RunButtonDirective attachment state and output siblings during streaming', () => {
    const host = document.createElement('div');
    const blockHtml =
      '<div class="code-block-wrapper" data-script="echo%20hi" data-language="bash">' +
      '<button class="code-block-run-btn" type="button">Run</button>' +
      '<pre><code class="hljs language-bash">echo hi</code></pre></div>';
    patchStreamingMarkdownDom(host, blockHtml, { animate: true, nowMs: 1000 });
    const btn = host.querySelector('.code-block-run-btn') as HTMLElement;
    btn.dataset['attached'] = 'true';
    const output = document.createElement('div');
    output.className = 'code-block-output';
    output.textContent = 'hi';
    host.appendChild(output);

    patchStreamingMarkdownDom(host, `${blockHtml}<p>Done.</p>`, { animate: true, nowMs: 1100 });
    expect(btn.dataset['attached']).toBe('true');
    expect(host.querySelector('.code-block-output')).toBe(output);
    expect(host.querySelector('p')?.textContent).toBe('Done.');
  });
});

@Component({
  standalone: true,
  imports: [StreamingMarkdownDirective],
  template: `<div class="md" [appStreamingMarkdown]="html()" [appStreamingMarkdownAnimate]="animate()"></div>`,
})
class DirectiveHostComponent {
  readonly html = signal('<p>First</p>');
  readonly animate = signal(true);
}

describe('StreamingMarkdownDirective', () => {
  it('reconciles live HTML updates without recreating unchanged paragraphs', () => {
    const fixture = TestBed.createComponent(DirectiveHostComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement.querySelector('.md') as HTMLElement;
    const firstP = el.querySelector('p')!;
    expect(firstP.textContent).toBe('First');

    fixture.componentInstance.html.set('<p>First chunk</p>');
    fixture.detectChanges();
    expect(el.querySelector('p')).toBe(firstP);
    expect(firstP.querySelector(`span[${STREAM_FADE_SPAN_ATTR}]`)?.textContent).toBe(' chunk');
  });

  it('strips fade wrappers when animate transitions from true to false with unchanged HTML', () => {
    const fixture = TestBed.createComponent(DirectiveHostComponent);
    fixture.detectChanges();
    fixture.componentInstance.html.set('<p>First chunk</p>');
    fixture.detectChanges();
    const el = fixture.nativeElement.querySelector('.md') as HTMLElement;
    expect(el.querySelector(`.${STREAM_FADE_CLASS}`)).not.toBeNull();

    fixture.componentInstance.animate.set(false);
    fixture.detectChanges();
    expect(el.querySelector(`.${STREAM_FADE_CLASS}`)).toBeNull();
    expect(el.querySelector(`span[${STREAM_FADE_SPAN_ATTR}]`)).toBeNull();
    expect(el.textContent).toBe('First chunk');
  });

  it('sanitizes unsafe HTML passed directly to the directive', () => {
    const fixture = TestBed.createComponent(DirectiveHostComponent);
    fixture.componentInstance.html.set('<p onclick="alert(1)">Safe</p><script>alert(1)</script>');
    fixture.detectChanges();
    const el = fixture.nativeElement.querySelector('.md') as HTMLElement;
    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('p')?.getAttribute('onclick')).toBeNull();
    expect(el.textContent).toBe('Safe');
  });
});
