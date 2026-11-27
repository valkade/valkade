import { NgTemplateOutlet } from '@angular/common';
import { Component, ViewEncapsulation, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import {
  CLAUDE_CLI_AUTOCOMPACT_OPTIONS,
  CLAUDE_CLI_MODELS,
  DEFAULT_CLAUDE_CLI_MODEL_ID,
  LLM_THINKING_MODE_OPTIONS,
  OPENROUTER_DEFAULT_BASE_URL,
  findClaudeCliModel,
  llmComposerEffortOptions,
  llmComposerEffortValue,
  llmEffortControlVisible,
  llmEffortSelectOptionsFromCaps,
  llmThinkingControlVisible,
  normalizeClaudeCliSettings,
  unwrapSecret,
  type ChatTemplateReasoningCaps,
  type ClaudeCliSettings,
  type LlmProviderConfig,
  type LlmReasoningEffort,
} from '@shared/index';
import { NgxSpinnerComponent } from 'ngx-spinner';
import { LucideAngularModule } from 'lucide-angular';
import { AnthropicService } from '../../../core/anthropic.service';
import { ClaudeCliService } from '../../../core/claude-cli.service';
import { claudeModelOptions, formatClaudeDate, formatClaudeTokens } from '../../../core/claude-models';
import { ElectronService } from '../../../core/electron.service';
import { PillSelectComponent } from '../../../shared/pill-select/pill-select';
import { SettingsStore } from '../settings/settings-store';
import { LlamaRunCommandComponent } from './llama-run-command/llama-run-command';
import { LmStudioDashboardComponent } from './lm-studio-dashboard/lm-studio-dashboard';
import { OpenAiCompatDashboardComponent } from './openai-compat-dashboard/openai-compat-dashboard';
import { TutorialSourceExampleComponent } from './tutorial-source-example/tutorial-source-example';
import {
  OPENROUTER_MODEL_SORT_OPTIONS,
  filterOpenRouterModels,
  formatOpenRouterContext,
  formatOpenRouterPrice,
  maskOpenRouterApiKey,
  openRouterModelIsFree,
  type OpenRouterModelSort,
} from './openrouter-model-search';

/** Cards rendered per "Show more" step; the full tool-capable catalog runs to several hundred. */
const OPENROUTER_GRID_PAGE = 48;

@Component({
  selector: 'app-settings-models',
  imports: [
    FormsModule,
    LlamaRunCommandComponent,
    LmStudioDashboardComponent,
    LucideAngularModule,
    NgTemplateOutlet,
    NgxSpinnerComponent,
    OpenAiCompatDashboardComponent,
    PillSelectComponent,
    TutorialSourceExampleComponent,
  ],
  templateUrl: './settings-models.html',
  styleUrl: './settings-models.css',
  encapsulation: ViewEncapsulation.None,
})
export class SettingsModels {
  protected readonly s = inject(SettingsStore);
  private readonly electron = inject(ElectronService);
  private readonly capsByModel = toSignal(this.electron.chatTemplateReasoning$, {
    initialValue: {} as Readonly<Record<string, ChatTemplateReasoningCaps>>,
  });
  protected readonly thinkingModeOptions = LLM_THINKING_MODE_OPTIONS;
  private readonly liveCaps = computed(() => {
    const id = this.s.selectedModel()?.id;
    return id ? this.capsByModel()[id] : undefined;
  });
  protected readonly thinkingVisible = computed(() =>
    llmThinkingControlVisible(this.s.selectedModel()?.optimizationPreset, this.liveCaps()),
  );
  protected readonly effortVisible = computed(() =>
    llmEffortControlVisible(this.s.selectedModel()?.optimizationPreset, this.liveCaps()),
  );
  /** Scanned efforts only, as in the composer (which would revert a Default picked here). */
  private readonly scannedEffortOptions = computed(() => llmComposerEffortOptions(this.liveCaps()));
  protected readonly reasoningEffortOptions = computed(() => {
    const scanned = this.scannedEffortOptions();
    return scanned.length
      ? scanned
      : llmEffortSelectOptionsFromCaps(this.liveCaps(), this.s.selectedModel()?.optimizationPreset);
  });
  /** Effort the dropdown shows: the composer's pick when the model was scanned, else the saved one. */
  protected readonly reasoningEffortValue = computed(() => {
    const saved = this.s.selectedResolved()?.reasoningEffort || '';
    const scanned = this.scannedEffortOptions();
    return scanned.length ? llmComposerEffortValue(scanned, saved) : saved;
  });
  protected readonly openRouterDefaultBaseUrl = OPENROUTER_DEFAULT_BASE_URL;
  /** Connection fields are drafted here and only reach the config on Save. */
  protected readonly openRouterEditing = signal(false);
  protected readonly openRouterKeyDraft = signal('');
  protected readonly openRouterBaseUrlDraft = signal('');
  protected readonly openRouterSaving = signal(false);
  protected readonly openRouterKeyMask = computed(() => {
    const p = this.s.selectedProvider();
    return p?.provider === 'openrouter' ? maskOpenRouterApiKey(unwrapSecret(p.apiKey)) : '';
  });

  protected readonly openRouterSortOptions = OPENROUTER_MODEL_SORT_OPTIONS;
  protected readonly openRouterQuery = signal('');
  protected readonly openRouterSort = signal<OpenRouterModelSort>('newest');
  protected readonly openRouterFreeOnly = signal(false);
  protected readonly openRouterReasoningOnly = signal(false);
  private readonly openRouterLimit = signal(OPENROUTER_GRID_PAGE);
  protected readonly openRouterResults = computed(() =>
    filterOpenRouterModels(this.s.openRouterModels(), {
      query: this.openRouterQuery(),
      sort: this.openRouterSort(),
      freeOnly: this.openRouterFreeOnly(),
      reasoningOnly: this.openRouterReasoningOnly(),
    }),
  );
  protected readonly openRouterVisible = computed(() => this.openRouterResults().slice(0, this.openRouterLimit()));
  /** Catalog row for the saved model id, if the catalog lists it. */
  protected readonly openRouterCurrent = computed(() => {
    const id = this.s.selectedModel()?.model ?? '';
    return id ? (this.s.openRouterModels().find((m) => m.id === id) ?? null) : null;
  });
  /** A typed id that looks like ``vendor/model`` but is not in the catalog can still be used as-is. */
  protected readonly openRouterCustomId = computed(() => {
    const q = this.openRouterQuery().trim();
    if (!q.includes('/') || /\s/.test(q)) {
      return '';
    }
    return this.s.openRouterModels().some((m) => m.id === q) ? '' : q;
  });
  private readonly openRouterSourceId = computed(() => {
    const p = this.s.selectedProvider();
    return p?.provider === 'openrouter' ? p.id : null;
  });

  protected readonly claude = inject(AnthropicService);
  /** The key is write-only here: Edit opens an empty field, and Save hands it to main. */
  protected readonly claudeEditing = signal(false);
  protected readonly claudeKeyDraft = signal('');
  private readonly claudeSourceId = computed(() => {
    const p = this.s.selectedProvider();
    return p?.provider === 'anthropic' ? p.id : null;
  });
  protected readonly claudeModelId = computed(() => {
    const p = this.s.selectedProvider();
    return p?.provider === 'anthropic' ? (p.models[0]?.model ?? '') : '';
  });
  protected readonly claudeModelOptions = computed(() => claudeModelOptions(this.claude.models(), this.claudeModelId()));
  /** Catalog row for the saved model id, if the catalog lists it. */
  protected readonly claudeCurrent = computed(() => {
    const id = this.claudeModelId();
    return id ? (this.claude.models().find((m) => m.id === id) ?? null) : null;
  });
  protected readonly claudeVerifiedAt = computed(() => {
    const at = this.claude.status()?.verifiedAt;
    return at ? new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  });
  protected readonly formatTokens = formatClaudeTokens;
  protected readonly formatDate = formatClaudeDate;

  protected readonly claudeCli = inject(ClaudeCliService);
  protected readonly claudeCliConfigDirEditing = signal(false);
  protected readonly claudeCliConfigDirDraft = signal('');
  private readonly claudeCliSourceId = computed(() => {
    const p = this.s.selectedProvider();
    return p?.provider === 'claude-cli' ? p.id : null;
  });
  protected readonly claudeCliSettings = computed<ClaudeCliSettings>(() => {
    const p = this.s.selectedProvider();
    return normalizeClaudeCliSettings(p?.provider === 'claude-cli' ? p.claudeCli : undefined);
  });
  protected readonly claudeCliModelId = computed(() => {
    const p = this.s.selectedProvider();
    return p?.provider === 'claude-cli' ? (p.models[0]?.model || DEFAULT_CLAUDE_CLI_MODEL_ID) : DEFAULT_CLAUDE_CLI_MODEL_ID;
  });
  protected readonly claudeCliEffort = computed(() => {
    const p = this.s.selectedProvider();
    return p?.provider === 'claude-cli' ? (p.models[0]?.reasoningEffort || 'high') : 'high';
  });
  protected readonly claudeCliModelOptions = computed(() => {
    const live = this.claudeCli.models();
    const currentId = this.claudeCliModelId();
    const opts = live.map((m) => ({
      id: m.id,
      label: m.recommended ? `${m.displayName} (Recommended)` : m.displayName,
    }));
    if (currentId && !opts.some((o) => o.id === currentId)) {
      opts.unshift({ id: currentId, label: currentId });
    }
    return opts;
  });
  protected readonly claudeCliEffortOptions = computed(() => {
    const model = this.claudeCliCurrentModel();
    return model.effortLevels.map((lvl) => ({
      id: lvl,
      label: lvl === 'xhigh' ? 'Extra High' : lvl.charAt(0).toUpperCase() + lvl.slice(1),
    }));
  });
  protected readonly claudeCliCurrentModel = computed(() => {
    const live = this.claudeCli.models();
    return findClaudeCliModel(this.claudeCliModelId(), live) ?? live[0] ?? CLAUDE_CLI_MODELS[0];
  });
  protected readonly claudeCliAutoCompactOptions = computed(() => {
    const maxCtx = this.claudeCliCurrentModel().contextWindowTokens || 200_000;
    return CLAUDE_CLI_AUTOCOMPACT_OPTIONS.filter((o) => o.tokens === 0 || o.tokens <= maxCtx).map((o) => ({
      id: o.id,
      label: o.label,
    }));
  });
  protected readonly claudeCliAutoCompactValue = computed(() => {
    const saved = this.claudeCliSettings().autoCompact;
    return this.claudeCliAutoCompactOptions().some((o) => o.id === saved) ? saved : 'auto';
  });
  protected readonly claudeCliSubscriptionBadge = computed(() => {
    const raw = (this.claudeCli.status()?.subscriptionType ?? '').trim();
    if (!raw) {
      return 'Subscription';
    }
    return /^claude\b/i.test(raw) ? raw : `Claude ${raw.charAt(0).toUpperCase()}${raw.slice(1)}`;
  });
  protected readonly claudeCliResetCountdown = computed(() => {
    const st = this.claudeCli.status();
    const target = st?.rateLimitedUntil ?? st?.usage?.fiveHour?.resetsAt ?? 0;
    return this.formatResetCountdown(target);
  });
  protected formatResetCountdown(targetMs: number | undefined): string {
    if (!targetMs || targetMs <= Date.now()) {
      return '';
    }
    const mins = Math.max(1, Math.ceil((targetMs - Date.now()) / 60_000));
    const days = Math.floor(mins / (60 * 24));
    const hrs = Math.floor((mins % (60 * 24)) / 60);
    const rem = mins % 60;
    if (days > 0) {
      return `${days}d ${hrs}h`;
    }
    return hrs > 0 ? `${hrs}h ${rem}m` : `${rem}m`;
  }
  protected claudeCliWindowStatusLabel(status: 'allowed' | 'allowed_warning' | 'rejected' | 'unknown'): string {
    switch (status) {
      case 'allowed':
        return 'Within limit';
      case 'allowed_warning':
        return 'Near limit';
      case 'rejected':
        return 'Limit reached';
      default:
        return 'Updates on turn';
    }
  }
  protected readonly claudeCliCheckedAt = computed(() => {
    const at = this.claudeCli.status()?.checkedAt;
    return at ? new Date(at).toLocaleTimeString(undefined, { timeStyle: 'short' }) : '';
  });

  protected beginClaudeCliDirEdit(): void {
    this.claudeCliConfigDirDraft.set(this.claudeCliSettings().configDir || '~/.claude');
    this.claudeCliConfigDirEditing.set(true);
  }

  protected cancelClaudeCliDirEdit(): void {
    this.claudeCliConfigDirEditing.set(false);
    this.claudeCliConfigDirDraft.set('');
  }

  protected async saveClaudeCliDir(): Promise<void> {
    const raw = this.claudeCliConfigDirDraft().trim();
    const nextDir = raw === '~/.claude' ? '' : raw;
    if (await this.claudeCli.updateSettings({ configDir: nextDir })) {
      this.s.mirrorClaudeCliSettings({ configDir: nextDir });
      this.cancelClaudeCliDirEdit();
    }
  }

  protected async pickClaudeCliModel(modelId: string): Promise<void> {
    const model = findClaudeCliModel(modelId, this.claudeCli.models());
    if (!model || modelId === this.claudeCliModelId()) {
      return;
    }
    if (await this.claudeCli.setModel(modelId)) {
      this.s.mirrorClaudeCliModel(model);
    }
  }

  protected async pickClaudeCliEffort(effort: string): Promise<void> {
    if (!effort || effort === this.claudeCliEffort()) {
      return;
    }
    if (await this.claudeCli.setEffort(effort)) {
      this.s.mirrorClaudeCliEffort(effort as LlmReasoningEffort);
    }
  }

  protected async pickClaudeCliAutoCompact(autoCompact: string): Promise<void> {
    if (!autoCompact || autoCompact === this.claudeCliSettings().autoCompact) {
      return;
    }
    if (await this.claudeCli.updateSettings({ autoCompact })) {
      this.s.mirrorClaudeCliSettings({ autoCompact });
    }
  }

  protected async toggleClaudeCliSetting(
    key: 'fastMode' | 'routeApprovals' | 'captureTurnDiffs' | 'promptIdleCompaction' | 'bridgeWorkspaceTools',
    value: boolean,
  ): Promise<void> {
    if (await this.claudeCli.updateSettings({ [key]: value })) {
      this.s.mirrorClaudeCliSettings({ [key]: value });
    }
  }

  protected async launchClaudeCliLogin(): Promise<void> {
    await this.claudeCli.launchLogin();
  }

  protected beginClaudeEdit(): void {
    this.claude.error.set('');
    this.claudeKeyDraft.set('');
    this.claudeEditing.set(true);
  }

  protected cancelClaudeEdit(): void {
    this.claudeEditing.set(false);
    this.claudeKeyDraft.set('');
  }

  protected async saveClaudeKey(): Promise<void> {
    const key = this.claudeKeyDraft().trim();
    if (!key || this.claude.saving()) {
      return;
    }
    const accepted = await this.claude.saveKey(key);
    // Drop the plaintext from this window as soon as main has it (or rejected it).
    this.claudeKeyDraft.set('');
    if (accepted) {
      this.claudeEditing.set(false);
    }
  }

  protected async removeClaudeKey(): Promise<void> {
    await this.claude.clearKey();
    this.cancelClaudeEdit();
  }

  protected async pickClaudeModel(modelId: string): Promise<void> {
    const model = this.claude.models().find((m) => m.id === modelId);
    if (!model || modelId === this.claudeModelId()) {
      return;
    }
    if (await this.claude.setModel(modelId)) {
      this.s.mirrorClaudeModel(model);
    }
  }

  protected readonly formatContext = formatOpenRouterContext;
  protected readonly formatPrice = formatOpenRouterPrice;
  protected readonly isFree = openRouterModelIsFree;

  protected managedModelOptions(): { id: string; label: string }[] {
    const rows = this.s.managedInventoryModels().map((model) => ({
      id: this.s.managedInventoryOptionValue(model),
      label: `${model.fileName} · ${this.s.formatModelBytes(model.sizeBytes)} · ${this.s.managedInventoryFamilyLabel(model)}`,
    }));
    const picked = this.s.managedPickerValue();
    if (picked.startsWith('hf:') && !rows.some((row) => row.id === picked)) {
      rows.push({ id: picked, label: `${picked.slice(3)} (HF)` });
    }
    return [{ id: '', label: 'Select a model' }, ...rows];
  }

  protected presetOptions(provider: LlmProviderConfig['provider']): { id: string; label: string; title: string }[] {
    return this.s.presetsFor(provider).map((preset) => ({
      id: preset.id,
      label: preset.label,
      title: preset.summary,
    }));
  }

  protected beginOpenRouterEdit(provider: LlmProviderConfig): void {
    this.openRouterKeyDraft.set(unwrapSecret(provider.apiKey));
    this.openRouterBaseUrlDraft.set(provider.baseUrl);
    this.openRouterEditing.set(true);
  }

  protected cancelOpenRouterEdit(): void {
    this.openRouterEditing.set(false);
    this.openRouterKeyDraft.set('');
    this.openRouterBaseUrlDraft.set('');
  }

  protected async saveOpenRouterEdit(): Promise<void> {
    if (this.openRouterSaving()) {
      return;
    }
    this.openRouterSaving.set(true);
    try {
      await this.s.saveOpenRouterConnection({
        apiKey: this.openRouterKeyDraft(),
        baseUrl: this.openRouterBaseUrlDraft(),
      });
      this.cancelOpenRouterEdit();
    } finally {
      this.openRouterSaving.set(false);
    }
  }

  protected onOpenRouterQueryChange(query: string): void {
    this.openRouterQuery.set(query);
    this.openRouterLimit.set(OPENROUTER_GRID_PAGE);
  }

  protected toggleOpenRouterFreeOnly(): void {
    this.openRouterFreeOnly.update((on) => !on);
    this.openRouterLimit.set(OPENROUTER_GRID_PAGE);
  }

  protected toggleOpenRouterReasoningOnly(): void {
    this.openRouterReasoningOnly.update((on) => !on);
    this.openRouterLimit.set(OPENROUTER_GRID_PAGE);
  }

  protected showMoreOpenRouterModels(): void {
    this.openRouterLimit.update((n) => n + OPENROUTER_GRID_PAGE);
  }

  constructor() {
    effect(() => {
      const id = this.s.selectedModel()?.id;
      if (id) {
        void this.electron.refreshChatTemplateReasoning(id);
      }
    });
    // Opening the Claude card loads its status (key hint + model catalog) and closes a stale edit.
    effect(() => {
      const sourceId = this.claudeSourceId();
      untracked(() => {
        this.cancelClaudeEdit();
        if (sourceId) {
          void this.claude.ensureLoaded();
        }
      });
    });
    // Opening the Claude Code (Subscription) card probes local CLI status and closes stale dir edits.
    effect(() => {
      const sourceId = this.claudeCliSourceId();
      untracked(() => {
        this.cancelClaudeCliDirEdit();
        if (sourceId) {
          void this.claudeCli.ensureLoaded();
        }
      });
    });
    // Opening the OpenRouter card loads the catalog (it lists without a key) and drops any
    // half-edited connection left from an earlier visit.
    effect(() => {
      const sourceId = this.openRouterSourceId();
      untracked(() => {
        this.cancelOpenRouterEdit();
        if (sourceId && !this.s.openRouterModels().length && !this.s.openRouterModelsListInFlight()) {
          void this.s.refreshOpenRouterModels();
        }
      });
    });
  }
}
