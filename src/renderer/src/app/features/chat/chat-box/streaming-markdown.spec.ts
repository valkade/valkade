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
});
