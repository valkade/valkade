import { Injectable, computed, inject, signal } from '@angular/core';
import {
  CLAUDE_CLI_MODELS,
  type ClaudeCliModelOption,
  type ClaudeCliSettings,
  type ClaudeCliStatus,
} from '@shared/index';
import { ElectronService } from './electron.service';

/**
 * Claude Code (Subscription) source state for this window: CLI binary detection,
 * `claude auth status`, live CLI model catalog, real rate-limit events, and local transcript usage.
 */
@Injectable({ providedIn: 'root' })
export class ClaudeCliService {
  private readonly electron = inject(ElectronService);

  readonly status = signal<ClaudeCliStatus | null>(null);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal('');

  readonly models = computed<readonly ClaudeCliModelOption[]>(() => {
    const live = this.status()?.models;
    return live && live.length > 0 ? live : CLAUDE_CLI_MODELS;
  });
  readonly installed = computed(() => this.status()?.installed === true);
  readonly loggedIn = computed(() => this.status()?.loggedIn === true);
  readonly ready = computed(() => this.installed() && this.loggedIn());
  readonly rateLimited = computed(() => {
    const st = this.status();
    const until = st?.rateLimitedUntil;
    if (typeof until === 'number' && until > Date.now()) {
      return true;
    }
    return st?.usage?.fiveHour?.status === 'rejected' || st?.usage?.sevenDay?.status === 'rejected';
  });

  private loadGen = 0;

  async ensureLoaded(): Promise<void> {
    if (!this.status() && !this.loading()) {
      await this.refresh(false);
    }
  }

  async refresh(refresh = true): Promise<void> {
    const gen = ++this.loadGen;
    this.loading.set(true);
    try {
      const res = await this.electron.claudeCliStatus({ refresh });
      if (gen !== this.loadGen) {
        return;
      }
      this.status.set(res.status);
      this.error.set(res.ok ? '' : res.error);
    } catch (err) {
      if (gen === this.loadGen) {
        this.error.set(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (gen === this.loadGen) {
        this.loading.set(false);
      }
    }
  }

  async setModel(modelId: string): Promise<boolean> {
    const res = await this.electron.claudeCliSetModel({ modelId });
    this.error.set(res.ok ? '' : res.error);
    return res.ok;
  }

  async setEffort(effort: string): Promise<boolean> {
    const res = await this.electron.claudeCliSetEffort({ effort });
    this.error.set(res.ok ? '' : res.error);
    return res.ok;
  }

  async updateSettings(settings: Partial<ClaudeCliSettings>): Promise<boolean> {
    this.saving.set(true);
    this.loadGen += 1;
    try {
      const res = await this.electron.claudeCliUpdateSettings({ settings });
      if (res.ok && res.status) {
        this.status.set(res.status);
      }
      this.error.set(res.ok ? '' : res.error);
      return res.ok;
    } finally {
      this.saving.set(false);
    }
  }

  async launchLogin(): Promise<boolean> {
    const res = await this.electron.claudeCliLogin();
    this.error.set(res.ok ? '' : res.error);
    return res.ok;
  }
}
