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
  let resizeCallbacks: ResizeObserverCallback[] = [];
  let origRaf: typeof window.requestAnimationFrame;
  let origCancelRaf: typeof window.cancelAnimationFrame;
  let origResizeObserver: typeof globalThis.ResizeObserver;

  beforeEach(async () => {
    rafQueue = [];
    resizeCallbacks = [];
    origRaf = window.requestAnimationFrame;
    origCancelRaf = window.cancelAnimationFrame;
    origResizeObserver = globalThis.ResizeObserver;

    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = (() => undefined) as typeof window.cancelAnimationFrame;
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        resizeCallbacks.push(cb);
      }
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

  it('does not yank back up after jump-to-bottom if an earlier stream item shifts the final response index', () => {
    const fixture = TestBed.createComponent(ChatBox);
    const comp = fixture.componentInstance;
    fixture.componentRef.setInput('conversationId', 'conv-shift');
    fixture.componentRef.setInput('messages', [{ role: 'user', text: 'Explain' }]);
    fixture.componentRef.setInput('loading', true);
    fixture.componentRef.setInput('streamingParts', [
      { streamTag: 'agent', label: '', text: 'Line 1\n' + 'More text\n'.repeat(40) },
    ]);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const scrollBox = host.querySelector('.chat-box') as HTMLElement;
    scrollBox.scrollTo = ((opts?: ScrollToOptions | number) => {
      if (typeof opts === 'object' && opts && typeof opts.top === 'number') {
        scrollBox.scrollTop = opts.top;
      }
    }) as HTMLElement['scrollTo'];

    const mockFinalRect = (contentTop: number) => {
      const el = scrollBox.querySelector('.chat-row--live [data-final-response="true"]') as HTMLElement;
      el.getBoundingClientRect = () =>
        ({
          top: 100 + (contentTop - scrollBox.scrollTop),
          bottom: 100 + (contentTop - scrollBox.scrollTop) + 800,
          left: 0,
          right: 600,
          width: 600,
          height: 800,
          x: 0,
          y: 100 + (contentTop - scrollBox.scrollTop),
          toJSON: () => ({}),
        }) as DOMRect;
    };

    defineGeometry(scrollBox, { clientHeight: 600, scrollHeight: 1600, rectTop: 100 });
    mockFinalRect(800);
    flushRaf();
    fixture.detectChanges();

    expect(scrollBox.scrollTop).toBe(800);
    expect(comp.stickMode()).toBe(false);

    // User clicks Jump-to-Bottom to follow the bottom of the live stream.
    (host.querySelector('.chat-jump-bottom') as HTMLButtonElement).click();
    fixture.detectChanges();
    flushRaf();
    expect(comp.stickMode()).toBe(true);
    expect(scrollBox.scrollTop).toBe(1600);

    // An earlier tool/thought row shifts the final response's feed index from 0 -> 1.
    defineGeometry(scrollBox, { clientHeight: 600, scrollHeight: 1900, rectTop: 100 });
    fixture.componentRef.setInput('streamingParts', [
      { streamTag: 'reasoning', label: 'Model reasoning', text: 'Checked details' },
      { streamTag: 'agent', label: '', text: 'Line 1\n' + 'More text\n'.repeat(60) },
    ]);
    fixture.detectChanges();
    mockFinalRect(840);
    flushRaf();

    // Must remain stuck to bottom rather than yanking back up to y=840.
    expect(comp.stickMode()).toBe(true);
    expect(scrollBox.scrollTop).toBe(1900);
  });

  it('stays unstuck when scrollend fires after stopping at the final response top', () => {
    const fixture = TestBed.createComponent(ChatBox);
    const comp = fixture.componentInstance;
    fixture.componentRef.setInput('conversationId', 'conv-scrollend');
    fixture.componentRef.setInput('messages', [{ role: 'user', text: 'Write' }]);
    fixture.componentRef.setInput('loading', true);
    fixture.componentRef.setInput('streamingParts', [
      { streamTag: 'agent', label: '', text: 'Start\n' + 'Line\n'.repeat(30) },
    ]);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const scrollBox = host.querySelector('.chat-box') as HTMLElement;
    const finalEl = scrollBox.querySelector('.chat-row--live [data-final-response="true"]') as HTMLElement;

    // Slight overflow past maxScrollTop so slack (50px) is still inside stickThresholdPx (300px).
    defineGeometry(scrollBox, { clientHeight: 600, scrollHeight: 1450, rectTop: 100 });
    finalEl.getBoundingClientRect = () =>
      ({
        top: 100 + (800 - scrollBox.scrollTop),
        bottom: 100 + (800 - scrollBox.scrollTop) + 350,
        left: 0,
        right: 600,
        width: 600,
        height: 350,
        x: 0,
        y: 100 + (800 - scrollBox.scrollTop),
        toJSON: () => ({}),
      }) as DOMRect;

    flushRaf();
    expect(scrollBox.scrollTop).toBe(800);
    expect(comp.stickMode()).toBe(false);

    // Programmatic scrollend firing at the stop position must not re-stick.
    scrollBox.dispatchEvent(new Event('scrollend'));
    expect(comp.stickMode()).toBe(false);
    expect(scrollBox.scrollTop).toBe(800);
  });

  it('does not spuriously unstick on ResizeObserver resize after a short reply finishes and settles', () => {
    const fixture = TestBed.createComponent(ChatBox);
    const comp = fixture.componentInstance;
    fixture.componentRef.setInput('conversationId', 'conv-idle-resize');
    fixture.componentRef.setInput('messages', [{ role: 'user', text: 'Hi' }]);
    fixture.componentRef.setInput('loading', true);
    fixture.componentRef.setInput('streamingParts', [{ streamTag: 'agent', label: '', text: 'Short reply.' }]);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const scrollBox = host.querySelector('.chat-box') as HTMLElement;
    scrollBox.scrollTo = ((opts?: ScrollToOptions | number) => {
      if (typeof opts === 'object' && opts && typeof opts.top === 'number') {
        scrollBox.scrollTop = opts.top;
      }
    }) as HTMLElement['scrollTo'];

    const liveFinal = scrollBox.querySelector('.chat-row--live [data-final-response="true"]') as HTMLElement;
    expect(liveFinal).not.toBeNull();
    defineGeometry(scrollBox, { clientHeight: 600, scrollHeight: 1000, rectTop: 100 });
    liveFinal.getBoundingClientRect = () =>
      ({
        top: 100 + (500 - scrollBox.scrollTop),
        bottom: 100 + (500 - scrollBox.scrollTop) + 200,
        left: 0,
        right: 600,
        width: 600,
        height: 200,
        x: 0,
        y: 100 + (500 - scrollBox.scrollTop),
        toJSON: () => ({}),
      }) as DOMRect;
    flushRaf();
    expect(comp.stickMode()).toBe(true);

    // Turn finishes and persists the short assistant reply.
    fixture.componentRef.setInput('messages', [
      { role: 'user', text: 'Hi' },
      { role: 'assistant', text: 'Short reply.' },
    ]);
    fixture.componentRef.setInput('loading', false);
    fixture.componentRef.setInput('streamingParts', []);
    fixture.detectChanges();
    const persistedFinal = scrollBox.querySelector('[data-chat-row="1"] [data-final-response="true"]') as HTMLElement;
    expect(persistedFinal).not.toBeNull();
    persistedFinal.getBoundingClientRect = () =>
      ({
        top: 100 + (500 - scrollBox.scrollTop),
        bottom: 100 + (500 - scrollBox.scrollTop) + 200,
        left: 0,
        right: 600,
        width: 600,
        height: 200,
        x: 0,
        y: 100 + (500 - scrollBox.scrollTop),
        toJSON: () => ({}),
      }) as DOMRect;
    flushRaf();
    fixture.detectChanges();
    flushRaf();

    expect(comp.stickMode()).toBe(true);

    // Later while idle, shrinking the viewport (e.g. opening terminal dock) triggers ResizeObserver.
    defineGeometry(scrollBox, { clientHeight: 300, scrollHeight: 1000, rectTop: 100 });
    for (const cb of resizeCallbacks) {
      cb([], {} as ResizeObserver);
    }
    flushRaf();

    expect(comp.stickMode()).toBe(true);
    expect(scrollBox.scrollTop).toBe(1000);
  });

  it('re-aligns scrollTop to the persisted final response top when [DONE] folds work above it', () => {
    const fixture = TestBed.createComponent(ChatBox);
    const comp = fixture.componentInstance;
    fixture.componentRef.setInput('conversationId', 'conv-done-realign');
    fixture.componentRef.setInput('messages', [{ role: 'user', text: 'Investigate' }]);
    fixture.componentRef.setInput('loading', true);
    fixture.componentRef.setInput('streamingParts', [
      { streamTag: 'reasoning', label: 'Model reasoning', text: 'Checking files' },
      { streamTag: 'agent', label: '', text: 'Findings:\n' + 'Detail line\n'.repeat(40) },
    ]);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const scrollBox = host.querySelector('.chat-box') as HTMLElement;
    const liveFinal = scrollBox.querySelector('.chat-row--live [data-final-response="true"]') as HTMLElement;
    expect(liveFinal).not.toBeNull();

    defineGeometry(scrollBox, { clientHeight: 600, scrollHeight: 1800, rectTop: 100 });
    liveFinal.getBoundingClientRect = () =>
      ({
        top: 100 + (900 - scrollBox.scrollTop),
        bottom: 100 + (900 - scrollBox.scrollTop) + 600,
        left: 0,
        right: 600,
        width: 600,
        height: 600,
        x: 0,
        y: 100 + (900 - scrollBox.scrollTop),
        toJSON: () => ({}),
      }) as DOMRect;

    flushRaf();
    expect(scrollBox.scrollTop).toBe(900);
    expect(comp.stickMode()).toBe(false);

    // [DONE]: work folds upward, shifting persisted final response from y=900 to y=520.
    const origGetRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === scrollBox) {
        return {
          top: 100,
          bottom: 700,
          left: 0,
          right: 600,
          width: 600,
          height: 600,
          x: 0,
          y: 100,
          toJSON: () => ({}),
        } as DOMRect;
      }
      if (this.matches('[data-chat-row="1"] [data-final-response="true"]')) {
        return {
          top: 100 + (520 - scrollBox.scrollTop),
          bottom: 100 + (520 - scrollBox.scrollTop) + 600,
          left: 0,
          right: 600,
          width: 600,
          height: 600,
          x: 0,
          y: 100 + (520 - scrollBox.scrollTop),
          toJSON: () => ({}),
        } as DOMRect;
      }
      return origGetRect.call(this);
    });

    fixture.componentRef.setInput('messages', [
      { role: 'user', text: 'Investigate' },
      { role: 'assistant', text: 'Findings:\n' + 'Detail line\n'.repeat(40) },
    ]);
    fixture.componentRef.setInput('loading', false);
    fixture.componentRef.setInput('streamingParts', []);
    defineGeometry(scrollBox, { clientHeight: 600, scrollHeight: 1420, rectTop: 100 });
    fixture.detectChanges();
    flushRaf();
    fixture.detectChanges();
    flushRaf();

    expect(scrollBox.scrollTop).toBe(520);
    expect(comp.stickMode()).toBe(false);
  });
});
