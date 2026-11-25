import { Component, ViewEncapsulation, input } from '@angular/core';

/**
 * ValkAde's mark beside its name in the transcript: the logo's winged V
 * (assets/valkade-logo-gold.svg, drawn in the logo's own coordinates). The stem takes the
 * header colour; the wing feathers are the theme's secondary accent and beat while a reply
 * is streaming.
 */
@Component({
  selector: 'app-valkade-badge',
  standalone: true,
  template: `
    <svg
      class="valkade-badge"
      [class.valkade-badge--live]="live()"
      viewBox="10.25 6.75 48 48"
      aria-hidden="true"
    >
      <polygon class="valkade-badge__stem" points="12,12.5 22,14.5 30.5,41 30.5,52 26,52" />
      <g class="valkade-badge__wing">
        <polygon points="32.5,41 38.5,25 45.5,14.5 56.5,9.5 53.2,16.5 46.5,21.5 32.5,45.2" />
        <polygon points="32.5,47.2 45.2,24.5 55,19.5 51.5,26 44.2,30.8 32.5,50.2" />
        <polygon points="33.2,52 43.8,33.5 51.5,29.5 48,35.2 41.2,40 35.5,52" />
        <polygon class="valkade-badge__tip" points="37.5,51.5 43.8,41.5 48.2,38.8 45,44.2 39,51.5" />
      </g>
    </svg>
  `,
  styleUrl: './valkade-badge.css',
  encapsulation: ViewEncapsulation.None,
})
export class ValkAdeBadgeComponent {
  /** The reply is streaming: the wing beats. */
  readonly live = input(false);
}
