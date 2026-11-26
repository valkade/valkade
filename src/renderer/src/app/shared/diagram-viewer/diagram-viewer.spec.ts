import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiagramViewerService } from '../../core/diagram-viewer.service';
import { lucideAppProviders } from '../../lucide-setup';
import { DiagramViewerComponent } from './diagram-viewer';

const SVG = '<svg id="d1" viewBox="0 0 400 300" width="100%" style="max-width: 400px;" xmlns="http://www.w3.org/2000/svg"><g></g></svg>';

describe('DiagramViewerComponent', () => {
  let service: DiagramViewerService;
  let host: HTMLElement;
  let fixture: ReturnType<typeof TestBed.createComponent<DiagramViewerComponent>>;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [...lucideAppProviders] });
    fixture = TestBed.createComponent(DiagramViewerComponent);
    service = TestBed.inject(DiagramViewerService);
    host = fixture.nativeElement as HTMLElement;
    document.body.append(host);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    host.remove();
  });

  function open(returnFocus?: HTMLElement): SVGSVGElement {
    service.open({ svg: SVG, returnFocus });
    fixture.detectChanges();
    TestBed.tick();
    return host.querySelector('.diagram-viewer__canvas svg') as SVGSVGElement;
  }

  function press(key: string, init: KeyboardEventInit = {}): void {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
    fixture.detectChanges();
  }

  function readout(): string {
    return host.querySelector('.diagram-viewer__readout')?.textContent?.trim() ?? '';
  }

  it('renders nothing until a diagram is opened', () => {
    expect(host.querySelector('.diagram-viewer__backdrop')).toBeNull();
  });

  it('mounts the SVG uncapped and sized by the zoom, starting in Fit', () => {
    const svg = open();
    expect(svg).not.toBeNull();
    expect(svg.style.maxWidth).toBe('none');
    // jsdom has no layout, so Fit falls back to 1x.
    expect(svg.getAttribute('width')).toBe('400');
    expect(svg.getAttribute('height')).toBe('300');
    expect(host.querySelector('.diagram-viewer__btn.is-active')?.textContent).toContain('Fit');
    expect(document.activeElement).toBe(host.querySelector('.diagram-viewer__stage'));
  });

  it('zooms with the toolbar and keyboard, resizing the SVG', () => {
    const svg = open();
    (host.querySelector('[aria-label="Zoom in"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(readout()).toBe('125%');
    expect(svg.getAttribute('width')).toBe('500');

    press('-');
    expect(readout()).toBe('100%');
    press('-');
    expect(readout()).toBe('80%');
    press('1');
    expect(svg.getAttribute('width')).toBe('400');
    expect(host.querySelector('.diagram-viewer__btn.is-active')?.textContent).toContain('1:1');

    press('f');
    expect(host.querySelector('.diagram-viewer__btn.is-active')?.textContent).toContain('Fill');
    press('0');
    expect(host.querySelector('.diagram-viewer__btn.is-active')?.textContent).toContain('Fit');
  });

  it('leaves modified shortcuts (browser zoom, etc.) alone', () => {
    open();
    press('+', { ctrlKey: true });
    expect(readout()).toBe('100%');
  });

  it('zooms on Ctrl+wheel only; a plain wheel is left to scroll', () => {
    open();
    const stage = host.querySelector('.diagram-viewer__stage')!;
    const plain = new WheelEvent('wheel', { deltaY: -100, cancelable: true });
    stage.dispatchEvent(plain);
    fixture.detectChanges();
    expect(plain.defaultPrevented).toBe(false);
    expect(readout()).toBe('100%');

    const pinch = new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, cancelable: true });
    stage.dispatchEvent(pinch);
    fixture.detectChanges();
    expect(pinch.defaultPrevented).toBe(true);
    expect(Number.parseInt(readout(), 10)).toBeGreaterThan(100);
  });

  it('closes on Escape and returns focus to the opener', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    open(opener);
    press('Escape');
    expect(service.active()).toBeNull();
    expect(host.querySelector('.diagram-viewer__backdrop')).toBeNull();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('closes from the close button and the backdrop, but not from the panel', () => {
    open();
    (host.querySelector('.diagram-viewer__panel') as HTMLElement).click();
    expect(service.active()).not.toBeNull();
    (host.querySelector('.diagram-viewer__backdrop') as HTMLElement).click();
    expect(service.active()).toBeNull();

    fixture.detectChanges();
    open();
    (host.querySelector('.diagram-viewer__close') as HTMLButtonElement).click();
    expect(service.active()).toBeNull();
  });
});
