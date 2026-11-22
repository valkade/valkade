import type { ValkAdeThemeDocument } from '../theme-document';

const MONO_STACK = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace";

/**
 * Default dark theme — Valkyrie Gold: forged directly from the ValkAde logo
 * (assets/valkade-logo-gold.svg). Warm obsidian charcoal surfaces (#0e0d0c), crisp ivory ink
 * (#f6f2e9), forged Valkyrie gold (#f5a826) with sunlit gold highlights (#ffde82) and deep
 * bronze accents (#c46d12).
 */
export const VALKADE_DARK_VALKYRIE_GOLD_THEME: ValkAdeThemeDocument = {
  version: 1,
  id: 'valkade-dark-valkyrie-gold',
  name: 'ValkAde Dark Valkyrie Gold',
  description: 'Obsidian charcoal and warm ivory forged with Valkyrie gold and deep bronze, matching the ValkAde emblem.',
  author: 'ValkAde',
  mode: 'dark',
  builtIn: true,
  tokens: {
    // Surfaces — warm obsidian charcoal anchored on the logo tile (#0e0d0c)
    '--t-bg': '#131210',
    '--t-bg-surface': '#1b1916',
    '--t-bg-deep': '#0e0d0c',
    '--t-panel': '#171513',
    '--t-chat-bg': 'color-mix(in srgb, var(--t-bg-surface) 62%, var(--t-bg))',
    '--t-input-bg': '#12110f',
    '--t-composer-bg': '#0e0d0c',
    '--t-composer-input-bg': '#1b1916',
    '--t-composer-input-focus-bg': '#221f1a',
    '--t-surface': 'var(--t-bg-surface)',
    '--t-surface-2': 'var(--t-bg-surface)',
    '--t-surface-3': 'var(--t-panel)',
    '--t-panel-bg': 'var(--t-panel)',

    // Text — logo ivory (#f6f2e9), Valkyrie gold (#f5a826), sunlit gold (#ffde82)
    '--t-fg': '#f6f2e9',
    '--t-primary': '#f5a826',
    '--t-secondary': '#ffde82',
    '--t-text-muted': '#9c9282',
    '--t-input-fg': '#f6f2e9',
    '--t-on-primary': '#120d05',
    '--t-muted': 'var(--t-text-muted)',
    '--t-text': 'var(--t-fg)',
    '--t-heading': 'var(--t-primary)',
    '--t-fg-muted': 'var(--t-text-muted)',

    // Borders & edges — burnished dark bronze and charcoal seams
    '--t-border': '#3a3329',
    '--t-border-subtle': '#26221c',
    '--t-edge-light': '#514636',
    '--t-edge-mid': '#302a22',
    '--t-edge-dark': '#191714',
    '--t-edge-darkest': '#070605',
    '--t-tui-frame': '#f5a82699',
    '--t-tui-user-frame': '#ffde82',
    '--t-tui-clara-frame': '#f5a826',
    '--t-tui-input-frame': '#f5a826cc',

    // Interaction — forged gold sheen
    '--t-hover-bg': 'rgba(245, 168, 38, 0.08)',
    '--t-active-bg': 'rgba(245, 168, 38, 0.15)',
    '--t-selection-bg': 'rgba(245, 168, 38, 0.28)',
    '--t-glow': 'rgba(245, 168, 38, 0.42)',
    '--t-glow-soft': 'rgba(245, 168, 38, 0.16)',
    '--t-elev-shadow': '0 10px 28px color-mix(in srgb, var(--t-edge-darkest) 60%, transparent)',

    // Chat bubbles — your prompts in burnished bronze, ValkAde in obsidian & ivory
    '--t-user-bg': '#211b13',
    '--t-user-fg': '#faf6ee',
    '--t-user-border': '#f5a82655',
    '--t-assistant-bg': '#161412',
    '--t-assistant-fg': '#f6f2e9',
    '--t-assistant-border': '#3d352a',

    // Code
    '--t-code-bg': '#0f0e0c',
    '--t-code-inline-bg': '#242019',
    '--t-code-text': '#f6f2e9',

    // Syntax — forged gold & ivory anchored with sage, patina teal, and bronze
    '--t-hljs-keyword': '#f5a826',
    '--t-hljs-string': '#a9d48b',
    '--t-hljs-number': '#e8874a',
    '--t-hljs-comment': '#766d60',
    '--t-hljs-function': '#ffde82',
    '--t-hljs-class': '#6ec9c4',
    '--t-hljs-attr': '#f3c46b',
    '--t-hljs-params': '#f6f2e9',
    '--t-hljs-property': '#d9c8ae',
    '--t-hljs-punctuation': '#9c9282',
    '--t-hljs-operator': '#c9985a',
    '--t-hljs-meta': '#c49be8',
    '--t-hljs-tag': '#f5a826',
    '--t-hljs-name': '#6ec9c4',
    '--t-hljs-symbol': '#e8874a',
    '--t-hljs-selector': '#a9d48b',

    // Status & decisions
    '--t-confirm': '#4fd18b',
    '--t-caution': '#ffde82',
    '--t-log-level-error': '#ff6b6b',
    '--t-log-level-warning': '#f5a826',
    '--t-log-level-info': '#6ec9c4',
    '--t-log-level-debug': 'var(--t-text-muted)',
    '--t-process-a': '#f5a826',
    '--t-process-b': '#ffde82',
    '--t-process-c': '#6ec9c4',
    '--t-run-command-tab': '#6ec9c4',
    '--t-progress-track': 'var(--t-border-subtle)',
    '--t-progress-fill': 'var(--t-primary)',
    '--t-warn': 'var(--t-log-level-warning)',
    '--t-danger': 'var(--t-log-level-error)',
    '--t-error': 'var(--t-log-level-error)',
    '--t-success': 'var(--t-confirm)',

    // Typography
    '--t-font': MONO_STACK,
    '--t-font-mono': 'var(--t-font)',
    '--t-mono': 'var(--t-font-mono)',
    '--t-mono-font': 'var(--t-font-mono)',

    // Title bar — dark obsidian fading into the logo ground
    '--t-titlebar-start': '#1c1915',
    '--t-titlebar-end': '#0e0d0c',
    '--t-titlebar-text': '#f6f2e9',
  },
  groups: {
    // Crisp forged-gold hairline beneath the title bar.
    'shell.titlebar': {
      css: '& { box-shadow: inset 0 -1px 0 rgba(245, 168, 38, 0.38); }',
    },
    // Match the winged-V transcript badge directly to the Valkyrie Gold logo.
    'chat.assistant-bubble': {
      css: [
        '.clara-badge__stem { fill: #f6f2e9; }',
        '.clara-badge__wing { fill: #f5a826; }',
        '.clara-badge__tip { fill: #c46d12; opacity: 1; }',
      ].join('\n'),
    },
    // Focused composer lights up with a warm forged-gold edge.
    'chat.composer': {
      css: [
        '.composer-input-wrap { transition: box-shadow 0.2s ease; }',
        '.composer-input-wrap:focus-within { box-shadow: 0 0 0 1px rgba(245, 168, 38, 0.58), 0 0 14px rgba(245, 168, 38, 0.14); }',
      ].join('\n'),
    },
  },
  assets: {},
};
