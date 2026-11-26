import { Directive, ElementRef, SecurityContext, effect, inject, input } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { patchStreamingMarkdownDom } from './streaming-markdown';

/**
 * Renders sanitized markdown HTML into the host element.
 *
 * When `appStreamingMarkdownAnimate` is true (live final response), incrementally patches the DOM
 * so newly streamed chunks and blocks fade in smoothly instead of snapping in on wholesale
 * `innerHTML` replacement.
 */
@Directive({
  selector: '[appStreamingMarkdown]',
  standalone: true,
})
export class StreamingMarkdownDirective {
  readonly appStreamingMarkdown = input.required<string>();
  readonly appStreamingMarkdownAnimate = input(false);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly sanitizer = inject(DomSanitizer);
  private lastHtml: string | null = null;
  private lastAnimate = false;

  constructor() {
    effect(() => {
      const rawHtml = this.appStreamingMarkdown();
      const animate = this.appStreamingMarkdownAnimate();
      const html = this.sanitizer.sanitize(SecurityContext.HTML, rawHtml) ?? '';
      // Re-apply when leaving animate mode so stale fade wrappers/classes are stripped even if HTML is unchanged.
      if (html === this.lastHtml && (!this.lastAnimate || animate)) {
        return;
      }
      this.lastHtml = html;
      this.lastAnimate = animate;
      patchStreamingMarkdownDom(this.host, html, { animate });
    });
  }
}
