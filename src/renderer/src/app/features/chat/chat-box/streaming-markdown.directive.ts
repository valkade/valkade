import { Directive, ElementRef, effect, inject, input } from '@angular/core';
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
  private lastHtml: string | null = null;

  constructor() {
    effect(() => {
      const html = this.appStreamingMarkdown();
      const animate = this.appStreamingMarkdownAnimate();
      if (html === this.lastHtml) {
        return;
      }
      this.lastHtml = html;
      patchStreamingMarkdownDom(this.host, html, { animate });
    });
  }
}
