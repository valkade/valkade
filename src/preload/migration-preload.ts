/**
 * Minimal isolated preload for the pre-boot ValkAde migration prompt window.
 * Exposes only the four actions needed to migrate, start fresh, cancel, or receive progress.
 */
import { contextBridge, ipcRenderer } from 'electron';

export interface MigrationProgressEvent {
  entry: string;
  completed: number;
  total: number;
}

export type MigrationAcceptResponse = { ok: true } | { ok: false; error: string };

contextBridge.exposeInMainWorld('valkadeMigration', {
  accept: (): Promise<MigrationAcceptResponse> => ipcRenderer.invoke('valkade-migration:accept'),
  decline: (): Promise<void> => ipcRenderer.invoke('valkade-migration:decline'),
  cancel: (): Promise<void> => ipcRenderer.invoke('valkade-migration:cancel'),
  onProgress: (callback: (progress: MigrationProgressEvent) => void): (() => void) => {
    const listener = (_event: unknown, progress: MigrationProgressEvent) => callback(progress);
    ipcRenderer.on('valkade-migration:progress', listener);
    return () => {
      ipcRenderer.removeListener('valkade-migration:progress', listener);
    };
  },
});
