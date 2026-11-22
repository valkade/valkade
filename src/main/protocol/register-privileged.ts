import { protocol } from 'electron';

/**
 * Must run before `app.ready`. `registerSchemesAsPrivileged` may only be called once,
 * so every privileged scheme (TTS audio streaming, workspace image assets, theme background
 * assets) registers here.
 */
export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'valkade-theme',
      privileges: {
        secure: true,
        standard: true,
        stream: true,
      },
    },
    // Legacy theme asset scheme, kept for one release after the ValkAde rename.
    {
      scheme: 'clara-theme',
      privileges: {
        secure: true,
        standard: true,
        stream: true,
      },
    },
    {
      scheme: 'nemo-tts',
      privileges: {
        secure: true,
        standard: true,
        stream: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
    {
      scheme: 'nemo-asset',
      privileges: {
        secure: true,
        standard: true,
        stream: true,
      },
    },
  ]);
}
