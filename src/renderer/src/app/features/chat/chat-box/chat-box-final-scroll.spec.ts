import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lucideAppProviders } from '../../../lucide-setup';
import { ChatBox } from './chat-box';

function defineGeometry(
  el: HTMLElement,
  props: { clientHeight: number; scrollHeight: number; rectTop?: number },
): void {
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => props.clientHeight });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => props.scrollHeight });
  el.getBoundingClientRect = () =>
    ({
      top: props.rectTop ?? 0,
      bottom: (props.rectTop ?? 0) + props.clientHeight,
      left: 0,
      right: 600,
      width: 600,
      height: props.clientHeight,
      x: 0,
      y: props.rectTop ?? 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

describe('ChatBox final response top-of-container scroll stop', () => {
  let rafQueue: FrameRequestCallback[] = [];
  let origRaf: typeof window.requestAnimationFrame;
  let origCancelRaf: typeof window.cancelAnimationFrame;
  let origResizeObserver: typeof globalThis.ResizeObserver;

  beforeEach(async () => {
    rafQueue = [];
    origRaf = window.requestAnimationFrame;
    origCancelRaf = window.cancelAnimationFrame;
    origResizeObserver = globalThis.ResizeObserver;

    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = (() => undefined) as typeof window.cancelAnimationFrame;
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;

    await TestBed.configureTestingModule({
      imports: [ChatBox],
      providers: [...lucideAppProviders],
    }).compileComponents();
  });

  afterEach(() => {
    window.requestAnimationFrame = origRaf;
    window.cancelAnimationFrame = origCancelRaf;
    globalThis.ResizeObserver = origResizeObserver;
    vi.restoreAllMocks();
  });

  function flushRaf(): void {
    const callbacks = rafQueue.splice(0, rafQueue.length);
    for (const cb of callbacks) {
      cb(performance.now());
    }
  }

  it('stops auto-scrolling at the top of the final response, unsticks, and shows jump-to-bottom', () => {
    const fixture = TestBed.createComponent(ChatBox);
    const comp = fixture.componentInstance;
    fixture.componentRef.setInput('conversationId', 'conv-1');
    fixture.componentRef.setInput('messages', [{ role: 'user', text: 'Write a long explanation' }]);
    fixture.componentRef.setInput('loading', true);
    fixture.componentRef.setInput('streamingParts', [
      { streamTag: 'agent', label: '', text: 'Line 1\nLine 2' },
    ]);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const scrollBox = host.querySelector('.chat-box') as HTMLElement;
    scrollBox.scrollTo = ((opts?: ScrollToOptions | number) => {
      if (typeof opts === 'object' && opts && typeof opts.top === 'number') {
        scrollBox.scrollTop = opts.top;
      }
    }) as HTMLElement['scrollTo'];

    // Case 1: Final response starts at content y=800, short enough that bottom scrollTop=700 keeps it below top.
    const finalEl = scrollBox.querySelector('.chat-row--live [data-final-response="true"]') as HTMLElement;
    expect(finalEl).not.toBeNull();

    defineGeometry(scrollBox, { clientHeight: 600, scrollHeight: 1300, rectTop: 100 });
    let finalContentTop = 800;
    finalEl.getBoundingClientRect = () =>
      ({
        top: 100 + (finalContentTop - scrollBox.scrollTop),
        bottom: 100 + (finalContentTop - scrollBox.scrollTop) + 200,
        left: 0,
        right: 600,
        width: 600,
        height: 200,
        x: 0,
        y: 100 + (finalContentTop - scrollBox.scrollTop),
        toJSON: () => ({}),
      }) as DOMRect;

    flushRaf();
    expect(comp.stickMode()).toBe(true);
    expect(comp.showJumpToBottom()).toBe(false);

    // Case 2: Final response grows tall enough that scrolling to bottom (900) would push y=800 off the top.
    defineGeometry(scrollBox, { clientHeight: 600, scrollHeight: 1500, rectTop: 100 });
    fixture.componentRef.setInput('streamingParts', [
      { streamTag: 'agent', label: '', text: 'Line 1\nLine 2\n' + 'More text\n'.repeat(40) },
    ]);
    fixture.detectChanges();
    flushRaf();
    fixture.detectChanges();

    expect(scrollBox.scrollTop).toBe(800);
    expect(comp.stickMode()).toBe(false);
    expect(comp.showJumpToBottom()).toBe(true);
    expect(host.querySelector('.chat-jump-bottom')).not.toBeNull();

    // Case 3: More tokens stream in while unstuck — scroll stays pinned at the start of the final response.
    defineGeometry(scrollBox, { clientHeight: 600, scrollHeight: 2000, rectTop: 100 });
    fixture.componentRef.setInput('streamingParts', [
      { streamTag: 'agent', label: '', text: 'Line 1\nLine 2\n' + 'More text\n'.repeat(80) },
    ]);
    fixture.detectChanges();
    flushRaf();

    expect(scrollBox.scrollTop).toBe(800);
    expect(comp.stickMode()).toBe(false);
    expect(comp.showJumpToBottom()).toBe(true);

    // Case 4: Clicking the jump-to-bottom button re-sticks and scrolls past the cap to the real bottom.
    const jumpBtn = host.querySelector('.chat-jump-bottom') as HTMLButtonElement;
    jumpBtn.click();
    fixture.detectChanges();
    flushRaf();
    fixture.detectChanges();

    expect(comp.stickMode()).toBe(true);
    expect(comp.showJumpToBottom()).toBe(false);
    expect(scrollBox.scrollTop).toBe(2000);
  });
});
