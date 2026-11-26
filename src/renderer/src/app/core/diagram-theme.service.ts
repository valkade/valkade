import { Injectable, computed, inject } from '@angular/core';
import { resolveDiagramTheme, type DiagramTheme } from './diagram-palette';
import { ThemeEngineService } from './theme/theme-engine.service';
import { createDomColorResolver } from './theme/theme-dom';

/** The app theme as a {@link DiagramTheme}, re-resolved after every theme apply. */
@Injectable({ providedIn: 'root' })
export class DiagramThemeService {
  private readonly themeEngine = inject(ThemeEngineService);
  private readonly resolver = createDomColorResolver(document);

  readonly theme = computed<DiagramTheme>(() => {
    // `revision` bumps once the theme's tokens are in the DOM, so they resolve to the new colors.
    this.themeEngine.revision();
    return resolveDiagramTheme(this.themeEngine.mode() !== 'light', this.resolver);
  });
}
