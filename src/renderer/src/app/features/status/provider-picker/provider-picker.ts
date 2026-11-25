import { NgStyle } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  LM_STUDIO_PLACEHOLDER_API_KEY,
  OPENROUTER_DEFAULT_BASE_URL,
  activeConversationModel,
  anthropicSourceLabel,
  effectiveLmStudioContextTokens,
  findLlmModelLocation,
  lmStudioLoadOptions,
  managedLlamaSourceDisplayName,
  normalizeLmStudioSettings,
  openAiCompatBaseUrl,
  openRouterSourceLabel,
  unwrapSecret,
  type AppConfig,
  type LlmProviderConfig,
  type LmStudioModelCard,
  type ModelManagerFileEntry,
  type OpenAiCompatModel,
  type OpenRouterCatalogModel,
} from '@shared/index';
import { subagentSources } from '@shared/subagent-sources';
import { AnthropicService } from '../../../core/anthropic.service';
import { claudeLineLabel, claudeModelOptions, formatClaudeTokens } from '../../../core/claude-models';
import { ElectronService } from '../../../core/electron.service';
import { SubagentSourceStatusService, type SourcePhase } from '../../../core/subagent-source-status.service';
import {
  formatLmStudioTokens,
  lmStudioIsEmbedding,
  lmStudioIsLoaded,
  lmStudioModelName,
} from '../../settings/settings-models/lm-studio-dashboard/lm-studio-models';
import {
  filterOpenRouterModels,
  formatOpenRouterContext,
  formatOpenRouterPrice,
  openRouterModelIsFree,
} from '../../settings/settings-models/openrouter-model-search';
import {
  LOCAL_LLAMACPP_RAIL_ID,
  buildProviderRailItems,
  formatActiveTriggerLabel,
  formatContextShort,
  isManagedLocalLlamaProvider,
  loadRecentOpenRouterModels,
  managedLocalLlamaProviders,
  railIdForProvider,
  recordRecentOpenRouterModel,
  type ProviderRailItem,
} from './provider-picker.utils';

/** How long the status bar trigger glows after the active model changes (matches CSS animation). */
export const MODEL_GLOW_MS = 1600;
const OPENROUTER_PAGE_SIZE = 80;
const PROBE_COOLDOWN_MS = 5000;
const LM_STUDIO_REFRESH_COOLDOWN_MS = 5000;
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_REMOTE_LLAMACPP_BASE_URL = 'http://127.0.0.1:8080/v1';

export type TriggerDotState = 'on' | 'starting' | 'error' | 'off';

export interface LocalLlamaModelRow {
  providerId: string;
  modelId: string;
  label: string;
  meta: string;
  phase: SourcePhase;
  downloading: boolean;
  error: boolean;
  active: boolean;
  canStart: boolean;
  port: number;
}

interface CustomEndpointState {
  loading: boolean;
  loaded: boolean;
  models: OpenAiCompatModel[];
  error: string;
}

/**
 * Two-pane Mini Provider Select popover for the workspace status bar and Home Runtime panel.
 *
 * - Left rail lists every configured provider (with all managed local `llama.cpp` sources
 *   aggregated under a single `llama.cpp (Local)` provider). Clicking a provider only browses it.
 * - Right pane lists models for the browsed provider:
 *   - `llama.cpp (Local)` and `LM Studio` (v1 REST) use Option B (Select + Action Footer) for
 *     multi-instance Start / Start & Switch / Switch / Stop / Cancel (or Load / Unload).
 *   - `Claude`, `OpenRouter` (with search + Recent / Free / Reasoning pills), and Custom OpenAI /
 *     remote URL endpoints swap immediately on click while keeping the panel open.
 */
@Component({
  selector: 'app-provider-picker',
  imports: [NgStyle],
  templateUrl: './provider-picker.html',
  styleUrl: './provider-picker.css',
})
export class ProviderPickerComponent implements OnDestroy {
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);
  private readonly electron = inject(ElectronService);
  protected readonly anthropic = inject(AnthropicService);
  private readonly sourceStatus = inject(SubagentSourceStatusService);

  /** Live app config from shell or home panel. */
  readonly appConfig = input<AppConfig | null>(null);
  /** `status-bar`: compact trigger for the workspace footer; `default`: Home Runtime panel. */
  readonly layout = input<'default' | 'status-bar'>('default');

  protected readonly localRailId = LOCAL_LLAMACPP_RAIL_ID;
  protected readonly open = signal(false);
  protected readonly panelStyle = signal<Record<string, string>>({});
  private readonly panelRef = viewChild<ElementRef<HTMLElement>>('panel');

  /** Currently browsed left-rail provider id (does not change the active model). */
  protected readonly browsingRailId = signal('');
  /** Focused managed local llama.cpp model id (Option B footer target). */
  protected readonly focusedLocalModelId = signal('');
  /** Focused LM Studio model id (Option B footer target when v1 API is available). */
  protected readonly focusedLmStudioModelId = signal('');

  /** Local custom-models directory inventory (for managed llama.cpp display labels). */
  protected readonly inventory = signal<ModelManagerFileEntry[]>([]);
  protected readonly customModelsDir = computed(() => this.appConfig()?.modelManager.customModelsDir?.trim() ?? '');

  /** Per-modelId start/stop/error state for managed local llama.cpp servers. */
  protected readonly localErrors = signal<Readonly<Record<string, boolean>>>({});
  protected readonly localActingIds = signal<Readonly<Record<string, boolean>>>({});
  protected readonly localStoppingIds = signal<Readonly<Record<string, boolean>>>({});
  protected readonly stoppingAnyLocal = computed(() =>
    Object.values(this.localStoppingIds()).some(Boolean),
  );
  private readonly localStartGen = new Map<string, number>();
  private readonly cancelledLocalStarts = new Set<string>();
  private readonly manuallyStoppedLocals = new Set<string>();

  /** LM Studio live state. */
  protected readonly lmStudioLoading = signal(false);
  protected readonly lmStudioSource = signal<'v1' | 'v0' | null>(null);
  protected readonly lmStudioModels = signal<LmStudioModelCard[]>([]);
  protected readonly lmStudioError = signal('');
  protected readonly lmStudioActionError = signal(false);
  protected readonly lmStudioBusyIds = signal<Readonly<Record<string, boolean>>>({});
  private lmStudioLoadedKey = '';
  private lmStudioLoadingKey = '';
  private lmStudioLoadedAt = 0;
  private lmStudioLoadGen = 0;

  /** OpenRouter catalog + search/filter state. */
  protected readonly openRouterLoading = signal(false);
  protected readonly openRouterModels = signal<OpenRouterCatalogModel[]>([]);
  protected readonly openRouterError = signal('');
  protected readonly openRouterQuery = signal('');
  protected readonly openRouterRecentOnly = signal(false);
  protected readonly openRouterFreeOnly = signal(false);
  protected readonly openRouterReasoningOnly = signal(false);
  protected readonly openRouterLimit = signal(OPENROUTER_PAGE_SIZE);
  protected readonly recentOpenRouterIds = signal<string[]>(loadRecentOpenRouterModels());
  private openRouterLoadedKey = '';
  private openRouterLoadingKey = '';
  private openRouterLoadGen = 0;

  /** Custom OpenAI / remote URL models cache keyed by provider id. */
  protected readonly customEndpoints = signal<Readonly<Record<string, CustomEndpointState>>>({});
  private readonly customEndpointKeys = new Map<string, string>();
  private readonly customEndpointLoadingKeys = new Map<string, string>();
  private readonly customEndpointGens = new Map<string, number>();

  /** Switching guard for immediate-click providers. */
  protected readonly switchingModel = signal(false);

  /** Status bar glow when the active model changes (e.g., conversation switch). */
  protected readonly modelGlow = signal(false);
  private readonly shownModelKey = computed(() => {
    const cfg = this.appConfig();
    const model = cfg ? activeConversationModel(cfg) : {};
    const activeModel = this.activeLocation()?.model.model ?? '';
    return `${model.modelId ?? ''}|${model.claudeModel ?? ''}|${activeModel}`;
  });
  private lastShownModelKey: string | null = null;
  private glowTimers: ReturnType<typeof setTimeout>[] = [];
  private lastProbeAt = 0;
  private lastProbeKey = '';
  private inventoryGen = 0;

  protected readonly statusBar = computed(() => this.layout() === 'status-bar');
  protected readonly railItems = computed(() => buildProviderRailItems(this.appConfig()));
  protected readonly show = computed(() => this.railItems().length > 0);
  protected readonly localProviders = computed(() => managedLocalLlamaProviders(this.appConfig()));

  /** Active provider + model profile from `AppConfig`. */
  protected readonly activeLocation = computed(() => {
    const cfg = this.appConfig();
    const mid = cfg?.activeLlmModelId?.trim();
    if (!cfg || !mid) {
      return null;
    }
    return findLlmModelLocation(cfg.llmProviders, mid);
  });

  protected readonly activeProvider = computed(() => this.activeLocation()?.provider ?? null);
  protected readonly activeModelId = computed(() => this.activeLocation()?.model.id ?? '');
  protected readonly activeRailId = computed(() => railIdForProvider(this.activeProvider()));

  /** All sources in the shape `SubagentSourceStatusService` probes. */
  private readonly probedSources = computed(() => {
    const cfg = this.appConfig();
    if (!cfg) {
      return [];
    }
    return subagentSources(cfg.llmProviders, (p) => this.providerDisplayLabel(p));
  });

  /** Managed local llama.cpp rows with live phase, port, and error state. */
  protected readonly localRows = computed<LocalLlamaModelRow[]>(() => {
    const activeMid = this.activeModelId();
    const inv = this.inventory();
    const errors = this.localErrors();
    return this.localProviders()
      .filter((p) => p.models.length > 0)
      .map((provider) => {
        const profile = provider.models[0];
        const modelId = profile.id;
        const phase = this.sourceStatus.serverPhase({ connectionId: modelId });
        const downloading = this.sourceStatus.isDownloading(modelId);
        const port = this.sourceStatus.serverPort(modelId);
        const canStart = (profile.llamaCppManaged?.chatRunCommand ?? '').trim() !== '';
        const ctx = formatContextShort(profile.contextWindowTokens);
        const stateText = !canStart
          ? 'no run command'
          : phase === 'running'
            ? port > 0
              ? `:${port}`
              : 'running'
            : phase === 'loading' && downloading
              ? 'downloading…'
              : phase === 'loading'
                ? 'starting…'
                : 'stopped';
        return {
          providerId: provider.id,
          modelId,
          label: managedLlamaSourceDisplayName(provider, inv),
          meta: [ctx, stateText].filter(Boolean).join(' · '),
          phase,
          downloading,
          error: errors[modelId] === true,
          active: activeMid === modelId,
          canStart,
          port,
        };
      });
  });

  protected readonly runningLocalCount = computed(
    () => this.localRows().filter((r) => r.phase === 'running').length,
  );
  protected readonly activeOrStartingLocalCount = computed(
    () => this.localRows().filter((r) => r.phase === 'running' || r.phase === 'loading').length,
  );

  /** Focused local row for Option B action footer. */
  protected readonly focusedLocalRow = computed<LocalLlamaModelRow | null>(() => {
    const rows = this.localRows();
    if (rows.length === 0) {
      return null;
    }
    const id = this.focusedLocalModelId();
    return rows.find((r) => r.modelId === id) ?? rows.find((r) => r.active) ?? rows[0];
  });

  /** LM Studio chat-only model cards. */
  protected readonly lmStudioChatModels = computed(() =>
    this.lmStudioModels().filter((card) => !lmStudioIsEmbedding(card)),
  );
  protected readonly lmStudioLoadedCount = computed(
    () => this.lmStudioChatModels().filter((card) => lmStudioIsLoaded(card)).length,
  );
  protected readonly lmStudioCanManage = computed(() => this.lmStudioSource() === 'v1');
  protected readonly focusedLmStudioCard = computed<LmStudioModelCard | null>(() => {
    const cards = this.lmStudioChatModels();
    if (cards.length === 0) {
      return null;
    }
    const id = this.focusedLmStudioModelId();
    const activeModel = this.browsedItem()?.provider?.models[0]?.model ?? '';
    return cards.find((c) => c.id === id) ?? cards.find((c) => c.id === activeModel) ?? cards[0];
  });

  /** Browsed left-rail item (defaults to active provider's rail item, then first item). */
  protected readonly browsedItem = computed<ProviderRailItem | null>(() => {
    const items = this.railItems();
    if (items.length === 0) {
      return null;
    }
    const id = this.browsingRailId();
    return items.find((i) => i.id === id) ?? items.find((i) => i.id === this.activeRailId()) ?? items[0];
  });

  /** Trigger display info. */
  protected readonly triggerInfo = computed(() =>
    formatActiveTriggerLabel(this.activeProvider(), this.inventory()),
  );

  /** Status dot for the status bar / Home trigger. */
  protected readonly triggerDot = computed<TriggerDotState>(() => {
    const provider = this.activeProvider();
    const mid = this.activeModelId();
    if (!provider || !mid) {
      return 'off';
    }
    if (isManagedLocalLlamaProvider(provider)) {
      if (this.localErrors()[mid]) {
        return 'error';
      }
      const phase = this.sourceStatus.serverPhase({ connectionId: mid });
      return phase === 'running' ? 'on' : phase === 'loading' ? 'starting' : 'off';
    }
    if (provider.provider === 'anthropic') {
      return this.anthropic.configured() && !!(provider.models[0]?.model ?? '').trim() ? 'on' : 'off';
    }
    const probed = this.probedSources().find((s) => s.id === provider.id);
    if (!probed) {
      return 'off';
    }
    const st = this.sourceStatus.state(probed);
    return st === 'running' ? 'on' : st === 'loading' ? 'starting' : 'off';
  });

  /** Badge on the trigger when >1 local server runs, or ≥1 runs while another provider is active. */
  protected readonly triggerRunningBadge = computed(() => {
    const count = this.runningLocalCount();
    if (count === 0) {
      return '';
    }
    if (count > 1 || this.activeRailId() !== LOCAL_LLAMACPP_RAIL_ID) {
      return `${count} up`;
    }
    return '';
  });

  /** Claude catalog rows for the Claude right pane. */
  protected readonly claudeRows = computed(() => {
    const item = this.browsedItem();
    const currentId = item?.provider?.models[0]?.model ?? '';
    const byId = new Map(this.anthropic.models().map((m) => [m.id, m] as const));
    return claudeModelOptions(this.anthropic.models(), currentId).map((opt) => {
      const metaModel = byId.get(opt.id);
      const tokens = metaModel ? formatClaudeTokens(metaModel.maxInputTokens) : '';
      const line = metaModel ? claudeLineLabel(metaModel.line) : opt.group ?? '';
      return {
        id: opt.id,
        label: opt.label,
        meta: [tokens ? `${tokens} ctx` : '', line].filter(Boolean).join(' · '),
        active: this.activeProvider()?.id === item?.provider?.id && currentId === opt.id,
      };
    });
  });

  /** Filtered OpenRouter rows (with Recent / Free / Reasoning pills + search). */
  protected readonly openRouterFiltered = computed(() => {
    const filtered = filterOpenRouterModels(this.openRouterModels(), {
      query: this.openRouterQuery(),
      freeOnly: this.openRouterFreeOnly(),
      reasoningOnly: this.openRouterReasoningOnly(),
      sort: 'newest',
    });
    if (!this.openRouterRecentOnly()) {
      return filtered;
    }
    const recents = this.recentOpenRouterIds();
    const order = new Map(recents.map((id, idx) => [id, idx] as const));
    const currentModel = this.browsedItem()?.provider?.models[0]?.model?.trim() ?? '';
    if (currentModel && !order.has(currentModel)) {
      order.set(currentModel, recents.length);
    }
    return filtered
      .filter((m) => order.has(m.id))
      .sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));
  });

  protected readonly openRouterVisible = computed(() =>
    this.openRouterFiltered().slice(0, this.openRouterLimit()),
  );

  protected readonly openRouterCustomId = computed(() => {
    const q = this.openRouterQuery().trim();
    if (!q.includes('/') || /\s/.test(q)) {
      return '';
    }
    return this.openRouterModels().some((m) => m.id === q) ? '' : q;
  });

  protected readonly openRouterEmptyMessage = computed(() =>
    this.openRouterRecentOnly() &&
    !this.openRouterQuery().trim() &&
    !this.openRouterFreeOnly() &&
    !this.openRouterReasoningOnly()
      ? 'No recently used models yet.'
      : 'No matching models.',
  );

  /** Custom OpenAI / remote URL rows for the currently browsed endpoint. */
  protected readonly customRows = computed(() => {
    const item = this.browsedItem();
    const provider = item?.provider;
    if (!provider || (item.kind !== 'openai' && item.kind !== 'openai-compatible' && item.kind !== 'remote-llamacpp')) {
      return [];
    }
    const state = this.customEndpoints()[provider.id];
    const saved = (provider.models[0]?.model ?? '').trim();
    const baseUrl = this.effectiveCustomBaseUrl(provider);
    const rows = (state?.models ?? []).map((m) => ({
      id: m.id,
      contextLength: m.contextLength ?? 0,
      meta: [formatContextShort(m.contextLength), baseUrl].filter(Boolean).join(' · '),
      active: this.activeProvider()?.id === provider.id && saved === m.id,
    }));
    if (saved && !rows.some((r) => r.id === saved)) {
      rows.unshift({
        id: saved,
        contextLength: provider.models[0]?.contextWindowTokens ?? 0,
        meta: ['Saved model', baseUrl].filter(Boolean).join(' · '),
        active: this.activeProvider()?.id === provider.id,
      });
    }
    return rows;
  });

  constructor() {
    // Track live lifecycle transitions & unexpected exits for all managed local servers.
    this.electron.llamaServerLifecycle$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((ev) => {
        if (ev.phase === 'running') {
          this.cancelledLocalStarts.delete(ev.modelId);
          this.manuallyStoppedLocals.delete(ev.modelId);
          this.setLocalError(ev.modelId, false);
          // Fetch status once so the assigned chat port is populated immediately.
          const cfg = this.appConfig();
          if (cfg) {
            void this.refreshSingleLocalStatus(cfg, ev.modelId);
          }
        } else if (ev.phase === 'starting' || ev.phase === 'downloading') {
          this.cancelledLocalStarts.delete(ev.modelId);
          this.manuallyStoppedLocals.delete(ev.modelId);
          this.setLocalError(ev.modelId, false);
        }
      });

    this.electron.llamaServerProcessExit$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((ev) => {
        if (ev.stream !== 'chat') {
          return;
        }
        const wasCancelled = this.cancelledLocalStarts.delete(ev.modelId);
        const wasManual = this.manuallyStoppedLocals.delete(ev.modelId);
        if (!wasCancelled && !wasManual && ev.code !== null && ev.code !== 0) {
          this.setLocalError(ev.modelId, true);
        }
      });

    // Show the popover in the top layer so transformed or overflow-hidden ancestors never clip it.
    effect(() => {
      const el = this.panelRef()?.nativeElement;
      if (el && typeof el.showPopover === 'function' && !el.matches(':popover-open')) {
        el.showPopover();
        this.keepPanelInViewport(el);
      }
    });

    // Glow status-bar trigger when the active model changes (e.g., conversation switch).
    effect(() => {
      const key = this.shownModelKey();
      const statusBar = this.statusBar();
      untracked(() => {
        const previous = this.lastShownModelKey;
        this.lastShownModelKey = key;
        if (statusBar && previous !== null && previous !== key && this.appConfig()) {
          this.glowModel();
        }
      });
    });

    // Keep local model inventory synced with customModelsDir.
    effect(() => {
      const dir = this.customModelsDir();
      if (!dir) {
        this.inventoryGen += 1;
        this.inventory.set([]);
        return;
      }
      void this.refreshInventory(dir);
    });

    // Load Anthropic status when Claude is active or configured so trigger dot stays accurate.
    effect(() => {
      if (this.activeProvider()?.provider === 'anthropic') {
        void this.anthropic.ensureLoaded();
      }
    });

    // Probe sources when the source list or connections change.
    effect(() => {
      const key = this.probedSources()
        .map((s) => `${s.id}:${s.connectionId}:${s.launchable}`)
        .join('|');
      if (key && key !== this.lastProbeKey) {
        this.lastProbeKey = key;
        untracked(() => this.probeSources(true));
      }
    });

    // Close panel only when an ancestor scroller moves the trigger away.
    const onScroll = (event: Event): void => {
      if (!this.open()) {
        return;
      }
      const target = event.target;
      if (target instanceof Node && target.contains(this.host.nativeElement)) {
        this.open.set(false);
      }
    };
    document.addEventListener('scroll', onScroll, true);
    this.destroyRef.onDestroy(() => document.removeEventListener('scroll', onScroll, true));
  }

  ngOnDestroy(): void {
    this.clearGlowTimers();
  }

  protected groupHeading(index: number): string {
    const items = this.railItems();
    const group = items[index]?.group ?? '';
    const prev = index > 0 ? items[index - 1]?.group ?? '' : '';
    return group && group !== prev ? group : '';
  }

  protected railDotState(item: ProviderRailItem): TriggerDotState {
    if (item.kind === 'local-llamacpp') {
      if (this.runningLocalCount() > 0) {
        return 'on';
      }
      if (this.localRows().some((r) => r.phase === 'loading')) {
        return 'starting';
      }
      if (this.localRows().some((r) => r.error)) {
        return 'error';
      }
      return 'off';
    }
    if (item.kind === 'anthropic') {
      return this.anthropic.configured() ? 'on' : 'off';
    }
    const probed = this.probedSources().find((s) => s.id === item.id);
    const probedState = probed ? this.sourceStatus.state(probed) : 'off';
    if (item.kind === 'lmstudio') {
      if (this.lmStudioError()) {
        return 'off';
      }
      if (probedState === 'off') {
        return 'off';
      }
      if (this.lmStudioSource() !== null) {
        return 'on';
      }
      return probedState === 'running' ? 'on' : probedState === 'loading' ? 'starting' : 'off';
    }
    if (item.kind === 'openrouter') {
      const hasKey = !!(item.provider && unwrapSecret(item.provider.apiKey).trim());
      if (!hasKey || this.openRouterError()) {
        return 'off';
      }
      return probedState === 'running' ? 'on' : probedState === 'loading' ? 'starting' : 'off';
    }
    if (!probed) {
      return 'off';
    }
    return probedState === 'running' ? 'on' : probedState === 'loading' ? 'starting' : 'off';
  }

  protected railDimmed(item: ProviderRailItem): boolean {
    if (item.kind === 'local-llamacpp') {
      return false;
    }
    return this.railDotState(item) === 'off';
  }

  protected railBadge(item: ProviderRailItem): string {
    if (item.kind === 'local-llamacpp') {
      const n = this.runningLocalCount();
      return n > 0 ? String(n) : '';
    }
    if (item.kind === 'lmstudio') {
      const n = this.lmStudioLoadedCount();
      return n > 0 ? String(n) : '';
    }
    return '';
  }

  protected togglePanel(event: Event): void {
    event.stopPropagation();
    if (this.open()) {
      this.open.set(false);
      return;
    }
    const initialRail = this.activeRailId() || this.railItems()[0]?.id || '';
    this.browsingRailId.set(initialRail);
    this.lmStudioActionError.set(false);
    if (initialRail === LOCAL_LLAMACPP_RAIL_ID) {
      this.focusedLocalModelId.set(this.activeModelId() || this.localRows()[0]?.modelId || '');
    }
    this.placePanel();
    this.open.set(true);
    this.probeSources(false);
    if (this.railItems().some((i) => i.kind === 'anthropic')) {
      void this.anthropic.ensureLoaded();
    }
    this.loadBrowsedProviderData(false);
  }

  protected browseProvider(railId: string): void {
    this.browsingRailId.set(railId);
    if (railId === LOCAL_LLAMACPP_RAIL_ID) {
      const currentFocus = this.focusedLocalModelId();
      if (!this.localRows().some((r) => r.modelId === currentFocus)) {
        this.focusedLocalModelId.set(this.activeModelId() || this.localRows()[0]?.modelId || '');
      }
    }
    this.loadBrowsedProviderData(false);
  }

  protected focusLocalModel(modelId: string): void {
    this.focusedLocalModelId.set(modelId);
  }

  protected focusLmStudioModel(card: LmStudioModelCard): void {
    if (this.lmStudioCanManage()) {
      this.focusedLmStudioModelId.set(card.id);
      this.lmStudioActionError.set(false);
      return;
    }
    void this.switchToLmStudioModel(card);
  }

  // ---- Managed local llama.cpp actions ----

  protected async startLocal(row: LocalLlamaModelRow, switchAfter: boolean): Promise<void> {
    const cfg = this.appConfig();
    if (!cfg || !row.canStart || this.localActingIds()[row.modelId] || this.localStoppingIds()[row.modelId]) {
      return;
    }
    const gen = (this.localStartGen.get(row.modelId) ?? 0) + 1;
    this.localStartGen.set(row.modelId, gen);
    this.setLocalActing(row.modelId, true);
    this.setLocalError(row.modelId, false);
    this.cancelledLocalStarts.delete(row.modelId);
    this.manuallyStoppedLocals.delete(row.modelId);
    try {
      let startCfg = cfg;
      if (switchAfter && !row.active) {
        const next = await this.electron.setActiveLlmModel(row.modelId);
        startCfg = next ?? { ...cfg, activeLlmModelId: row.modelId };
      }
      if (this.localStartGen.get(row.modelId) !== gen) {
        return;
      }
      this.sourceStatus.setServerPhase(row.modelId, 'loading');
      const res = await this.electron.llamaServerStart({ modelId: row.modelId, config: startCfg });
      if (this.localStartGen.get(row.modelId) !== gen) {
        return;
      }
      if (!res.ok) {
        this.sourceStatus.setServerPhase(row.modelId, 'off');
        this.setLocalError(row.modelId, true);
      } else {
        void this.refreshSingleLocalStatus(startCfg, row.modelId);
      }
    } catch {
      if (this.localStartGen.get(row.modelId) !== gen) {
        return;
      }
      this.sourceStatus.setServerPhase(row.modelId, 'off');
      this.setLocalError(row.modelId, true);
    } finally {
      if (this.localStartGen.get(row.modelId) === gen) {
        this.setLocalActing(row.modelId, false);
      }
    }
  }

  protected async switchLocal(row: LocalLlamaModelRow): Promise<void> {
    if (row.active || this.localActingIds()[row.modelId] || this.localStoppingIds()[row.modelId]) {
      return;
    }
    this.setLocalActing(row.modelId, true);
    try {
      await this.electron.setActiveLlmModel(row.modelId);
    } catch {
      // IPC failure ignored; active config remains unchanged.
    } finally {
      this.setLocalActing(row.modelId, false);
    }
  }

  protected async stopLocal(row: LocalLlamaModelRow): Promise<void> {
    const cfg = this.appConfig();
    if (!cfg || (row.phase !== 'running' && row.phase !== 'loading') || this.localStoppingIds()[row.modelId]) {
      return;
    }
    this.localStartGen.set(row.modelId, (this.localStartGen.get(row.modelId) ?? 0) + 1);
    if (row.phase === 'loading') {
      this.cancelledLocalStarts.add(row.modelId);
    }
    this.manuallyStoppedLocals.add(row.modelId);
    this.setLocalError(row.modelId, false);
    this.setLocalActing(row.modelId, false);
    this.setLocalStopping(row.modelId, true);
    try {
      await this.electron.llamaServerStop({ modelId: row.modelId, config: cfg });
      this.sourceStatus.setServerPhase(row.modelId, 'off');
    } catch {
      this.sourceStatus.setServerPhase(row.modelId, 'off');
    } finally {
      this.setLocalStopping(row.modelId, false);
    }
  }

  protected async stopAllLocal(): Promise<void> {
    const activeRows = this.localRows().filter(
      (r) => (r.phase === 'running' || r.phase === 'loading') && !this.localStoppingIds()[r.modelId],
    );
    await Promise.all(activeRows.map((row) => this.stopLocal(row)));
  }

  protected dismissLocalError(modelId: string): void {
    this.setLocalError(modelId, false);
  }

  // ---- LM Studio actions ----

  protected async loadLmStudio(card: LmStudioModelCard, switchAfter: boolean): Promise<void> {
    const provider = this.browsedItem()?.provider;
    if (!provider || provider.provider !== 'lmstudio' || this.lmStudioBusyIds()[card.id]) {
      return;
    }
    this.setLmStudioBusy(card.id, true);
    this.lmStudioActionError.set(false);
    try {
      const settings = normalizeLmStudioSettings(provider.models[0]?.lmStudio);
      const res = await this.electron.lmStudioLoadModel({
        baseUrl: provider.baseUrl,
        model: card.id,
        apiKey: this.lmStudioApiKey(provider),
        options: lmStudioLoadOptions(settings, card.max_context_length),
      });
      await this.refreshLmStudio(provider, true);
      if (!res.ok) {
        this.lmStudioActionError.set(true);
        return;
      }
      if (switchAfter) {
        const refreshed = this.lmStudioChatModels().find((c) => c.id === card.id) ?? card;
        await this.switchToLmStudioModel(refreshed, provider);
      }
    } catch {
      this.lmStudioActionError.set(true);
    } finally {
      this.setLmStudioBusy(card.id, false);
    }
  }

  protected async unloadLmStudio(card: LmStudioModelCard): Promise<void> {
    const provider = this.browsedItem()?.provider;
    if (!provider || provider.provider !== 'lmstudio' || !card.instanceId || this.lmStudioBusyIds()[card.id]) {
      return;
    }
    this.setLmStudioBusy(card.id, true);
    this.lmStudioActionError.set(false);
    try {
      const res = await this.electron.lmStudioUnloadModel({
        baseUrl: provider.baseUrl,
        instanceId: card.instanceId,
        apiKey: this.lmStudioApiKey(provider),
      });
      await this.refreshLmStudio(provider, true);
      if (!res.ok) {
        this.lmStudioActionError.set(true);
      }
    } catch {
      this.lmStudioActionError.set(true);
    } finally {
      this.setLmStudioBusy(card.id, false);
    }
  }

  protected async switchToLmStudioModel(card: LmStudioModelCard, targetProvider?: LlmProviderConfig): Promise<void> {
    const provider = targetProvider ?? this.browsedItem()?.provider;
    if (!provider || provider.provider !== 'lmstudio' || this.switchingModel()) {
      return;
    }
    this.switchingModel.set(true);
    try {
      const ctx = effectiveLmStudioContextTokens(card);
      await this.electron.selectLlmSourceModel({
        providerId: provider.id,
        model: card.id,
        name: lmStudioModelName(card),
        ...(ctx > 0 ? { contextWindowTokens: ctx } : {}),
      });
    } catch {
      this.lmStudioActionError.set(true);
    } finally {
      this.switchingModel.set(false);
    }
  }

  protected lmStudioCardName(card: LmStudioModelCard): string {
    return lmStudioModelName(card);
  }

  protected lmStudioCardLoaded(card: LmStudioModelCard): boolean {
    return lmStudioIsLoaded(card);
  }

  protected lmStudioCardMeta(card: LmStudioModelCard): string {
    const ctx = effectiveLmStudioContextTokens(card);
    return [card.quantization, ctx > 0 ? `${formatLmStudioTokens(ctx)} ctx` : ''].filter(Boolean).join(' · ');
  }

  protected isLmStudioActive(card: LmStudioModelCard): boolean {
    const provider = this.browsedItem()?.provider;
    return !!provider && this.activeProvider()?.id === provider.id && provider.models[0]?.model === card.id;
  }

  // ---- Immediate-swap providers (Claude, OpenRouter, Custom OpenAI) ----

  protected async pickClaudeModel(modelId: string): Promise<void> {
    const provider = this.browsedItem()?.provider;
    const profileId = provider?.models[0]?.id;
    if (!provider || !profileId || this.switchingModel()) {
      return;
    }
    this.switchingModel.set(true);
    try {
      const ok = await this.anthropic.setModel(modelId);
      if (ok && this.activeModelId() !== profileId) {
        await this.electron.setActiveLlmModel(profileId);
      }
    } catch {
      // AnthropicService records error state; avoid unhandled rejection.
    } finally {
      this.switchingModel.set(false);
    }
  }

  protected async pickOpenRouterModel(model: OpenRouterCatalogModel): Promise<void> {
    const provider = this.browsedItem()?.provider;
    if (!provider || this.switchingModel()) {
      return;
    }
    this.switchingModel.set(true);
    try {
      const updated = await this.electron.selectLlmSourceModel({
        providerId: provider.id,
        model: model.id,
        name: model.name || model.id,
        ...(model.contextLength > 0 ? { contextWindowTokens: model.contextLength } : {}),
      });
      if (updated) {
        this.recentOpenRouterIds.set(recordRecentOpenRouterModel(this.recentOpenRouterIds(), model.id));
      }
    } catch {
      // IPC failure ignored; active config remains unchanged.
    } finally {
      this.switchingModel.set(false);
    }
  }

  protected async pickOpenRouterCustomId(modelId: string): Promise<void> {
    const provider = this.browsedItem()?.provider;
    const id = modelId.trim();
    if (!provider || !id || this.switchingModel()) {
      return;
    }
    this.switchingModel.set(true);
    try {
      const updated = await this.electron.selectLlmSourceModel({
        providerId: provider.id,
        model: id,
        name: id,
      });
      if (updated) {
        this.recentOpenRouterIds.set(recordRecentOpenRouterModel(this.recentOpenRouterIds(), id));
      }
    } catch {
      // IPC failure ignored; active config remains unchanged.
    } finally {
      this.switchingModel.set(false);
    }
  }

  protected async pickCustomModel(modelId: string, contextLength = 0): Promise<void> {
    const provider = this.browsedItem()?.provider;
    if (!provider || !modelId.trim() || this.switchingModel()) {
      return;
    }
    this.switchingModel.set(true);
    try {
      await this.electron.selectLlmSourceModel({
        providerId: provider.id,
        model: modelId.trim(),
        ...(contextLength > 0 ? { contextWindowTokens: contextLength } : {}),
      });
    } catch {
      // IPC failure ignored; active config remains unchanged.
    } finally {
      this.switchingModel.set(false);
    }
  }

  protected isOpenRouterActive(modelId: string): boolean {
    const provider = this.browsedItem()?.provider;
    return !!provider && this.activeProvider()?.id === provider.id && provider.models[0]?.model === modelId;
  }

  protected openRouterMeta(model: OpenRouterCatalogModel): string {
    const ctx = formatOpenRouterContext(model.contextLength);
    const price = openRouterModelIsFree(model)
      ? 'Free'
      : model.pricing
        ? `${formatOpenRouterPrice(model.pricing.prompt)}/${formatOpenRouterPrice(model.pricing.completion)}`
        : '';
    return [ctx ? `${ctx} ctx` : '', price].filter(Boolean).join(' · ');
  }

  protected onOpenRouterQueryInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.openRouterQuery.set(value);
    this.openRouterLimit.set(OPENROUTER_PAGE_SIZE);
  }

  protected toggleOpenRouterFilter(filter: 'recent' | 'free' | 'reasoning'): void {
    if (filter === 'recent') {
      this.openRouterRecentOnly.update((v) => !v);
    } else if (filter === 'free') {
      this.openRouterFreeOnly.update((v) => !v);
    } else {
      this.openRouterReasoningOnly.update((v) => !v);
    }
    this.openRouterLimit.set(OPENROUTER_PAGE_SIZE);
  }

  protected showMoreOpenRouter(): void {
    this.openRouterLimit.update((n) => n + OPENROUTER_PAGE_SIZE);
  }

  protected refreshBrowsedProvider(): void {
    this.loadBrowsedProviderData(true);
  }

  protected openSettingsSources(): void {
    this.open.set(false);
    this.electron.openSettingsWindow('models');
  }

  protected openHealthWindow(): void {
    this.open.set(false);
    this.electron.openHealthWindow();
  }

  protected customEndpointState(providerId: string): CustomEndpointState | null {
    return this.customEndpoints()[providerId] ?? null;
  }

  // ---- Window / document listeners ----

  @HostListener('document:pointerdown', ['$event'])
  protected onDocumentPointerDown(event: PointerEvent): void {
    if (!this.open()) {
      return;
    }
    const target = event.target;
    if (target instanceof Node && this.host.nativeElement.contains(target)) {
      return;
    }
    this.open.set(false);
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.open.set(false);
  }

  @HostListener('window:resize')
  protected onResize(): void {
    if (this.open()) {
      this.placePanel();
    }
  }

  // ---- Internal helpers ----

  private effectiveCustomBaseUrl(provider: LlmProviderConfig): string {
    const raw = (provider.baseUrl ?? '').trim();
    if (raw) {
      return raw;
    }
    if (provider.provider === 'openai') {
      return DEFAULT_OPENAI_BASE_URL;
    }
    if (provider.provider === 'llamacpp') {
      return DEFAULT_REMOTE_LLAMACPP_BASE_URL;
    }
    return '';
  }

  private providerDisplayLabel(provider: LlmProviderConfig): string {
    if (provider.provider === 'openrouter') {
      return openRouterSourceLabel(provider);
    }
    if (provider.provider === 'anthropic') {
      return anthropicSourceLabel(provider);
    }
    return managedLlamaSourceDisplayName(provider, this.inventory());
  }

  private setLocalError(modelId: string, hasError: boolean): void {
    this.localErrors.update((current) => ({ ...current, [modelId]: hasError }));
  }

  private setLocalActing(modelId: string, acting: boolean): void {
    this.localActingIds.update((current) => ({ ...current, [modelId]: acting }));
  }

  private setLocalStopping(modelId: string, stopping: boolean): void {
    this.localStoppingIds.update((current) => ({ ...current, [modelId]: stopping }));
  }

  private setLmStudioBusy(modelId: string, busy: boolean): void {
    this.lmStudioBusyIds.update((current) => ({ ...current, [modelId]: busy }));
  }

  private lmStudioApiKey(provider: LlmProviderConfig): string {
    const raw = unwrapSecret(provider.apiKey).trim();
    return raw === LM_STUDIO_PLACEHOLDER_API_KEY ? '' : raw;
  }

  private probeSources(force: boolean): void {
    const cfg = this.appConfig();
    const now = Date.now();
    if (!cfg || (!force && now - this.lastProbeAt < PROBE_COOLDOWN_MS)) {
      return;
    }
    const sources = this.probedSources();
    if (sources.length === 0) {
      return;
    }
    this.lastProbeAt = now;
    void this.sourceStatus.probe(cfg, sources);
  }

  private async refreshSingleLocalStatus(cfg: AppConfig, modelId: string): Promise<void> {
    try {
      const res = await this.electron.llamaServerStatus({ modelId, config: cfg });
      if (res.ok) {
        this.sourceStatus.setServerPhase(modelId, res.running ? 'running' : res.starting ? 'loading' : 'off');
        this.sourceStatus.setServerPort(modelId, res.running ? res.chat.port : 0);
      }
    } catch {
      // Transient probe failure ignored; next open or lifecycle event reconciles.
    }
  }

  private async refreshInventory(customDir: string): Promise<void> {
    const gen = ++this.inventoryGen;
    try {
      const res = await this.electron.modelManagerListCustomModels({ customDir });
      if (gen !== this.inventoryGen) {
        return;
      }
      this.inventory.set(res.ok ? res.models : []);
    } catch {
      if (gen === this.inventoryGen) {
        this.inventory.set([]);
      }
    }
  }

  private loadBrowsedProviderData(force: boolean): void {
    const item = this.browsedItem();
    if (!item) {
      return;
    }
    if (item.kind === 'local-llamacpp') {
      const cfg = this.appConfig();
      if (cfg) {
        const localSources = this.probedSources().filter((s) => s.launchable);
        if (localSources.length > 0) {
          void this.sourceStatus.probe(cfg, localSources);
        }
      }
      return;
    }
    if (item.kind === 'anthropic') {
      if (force) {
        void this.anthropic.refresh(true);
      } else {
        void this.anthropic.ensureLoaded();
      }
      return;
    }
    if (!item.provider) {
      return;
    }
    if (item.kind === 'lmstudio') {
      void this.refreshLmStudio(item.provider, force);
      return;
    }
    if (item.kind === 'openrouter') {
      void this.refreshOpenRouter(item.provider, force);
      return;
    }
    void this.refreshCustomEndpoint(item.provider, force);
  }

  private async refreshLmStudio(provider: LlmProviderConfig, force: boolean): Promise<void> {
    const key = `${provider.id}|${provider.baseUrl}|${unwrapSecret(provider.apiKey)}`;
    const now = Date.now();
    if (!force && this.lmStudioLoading() && this.lmStudioLoadingKey === key) {
      return;
    }
    if (
      !force &&
      this.lmStudioLoadedKey === key &&
      now - this.lmStudioLoadedAt < LM_STUDIO_REFRESH_COOLDOWN_MS
    ) {
      return;
    }
    const gen = ++this.lmStudioLoadGen;
    this.lmStudioLoadingKey = key;
    this.lmStudioLoading.set(true);
    this.lmStudioError.set('');
    if (force) {
      this.lmStudioActionError.set(false);
    }
    try {
      const res = await this.electron.lmStudioListModels({
        baseUrl: provider.baseUrl,
        apiKey: this.lmStudioApiKey(provider),
      });
      if (gen !== this.lmStudioLoadGen) {
        return;
      }
      if (res.ok) {
        this.lmStudioLoadedKey = key;
        this.lmStudioLoadedAt = Date.now();
        this.lmStudioSource.set(res.source);
        this.lmStudioModels.set(res.models);
        const chatCards = res.models.filter((c) => !lmStudioIsEmbedding(c));
        const curFocus = this.focusedLmStudioModelId();
        if (!chatCards.some((c) => c.id === curFocus)) {
          const activeModel = provider.models[0]?.model ?? '';
          this.focusedLmStudioModelId.set(
            chatCards.find((c) => c.id === activeModel)?.id ?? chatCards[0]?.id ?? '',
          );
        }
      } else {
        this.lmStudioLoadedKey = '';
        this.lmStudioLoadedAt = 0;
        this.lmStudioSource.set(null);
        this.lmStudioModels.set([]);
        this.lmStudioError.set(res.error);
      }
    } catch (err) {
      if (gen !== this.lmStudioLoadGen) {
        return;
      }
      this.lmStudioLoadedKey = '';
      this.lmStudioLoadedAt = 0;
      this.lmStudioSource.set(null);
      this.lmStudioModels.set([]);
      this.lmStudioError.set(err instanceof Error ? err.message : String(err));
    } finally {
      if (gen === this.lmStudioLoadGen) {
        this.lmStudioLoadingKey = '';
        this.lmStudioLoading.set(false);
      }
    }
  }

  private async refreshOpenRouter(provider: LlmProviderConfig, force: boolean): Promise<void> {
    const apiKey = unwrapSecret(provider.apiKey).trim();
    const baseUrl = provider.baseUrl?.trim() || OPENROUTER_DEFAULT_BASE_URL;
    const key = `${provider.id}|${baseUrl}|${apiKey}`;
    if (!force && this.openRouterLoading() && this.openRouterLoadingKey === key) {
      return;
    }
    if (!force && this.openRouterLoadedKey === key && this.openRouterModels().length > 0) {
      return;
    }
    if (!apiKey) {
      this.openRouterLoadGen += 1;
      this.openRouterLoadedKey = '';
      this.openRouterLoadingKey = '';
      this.openRouterLoading.set(false);
      this.openRouterModels.set([]);
      this.openRouterError.set('Add an OpenRouter API key in Settings to browse and use models.');
      return;
    }
    const gen = ++this.openRouterLoadGen;
    this.openRouterLoadingKey = key;
    this.openRouterLoading.set(true);
    this.openRouterError.set('');
    try {
      const res = await this.electron.openRouterListModels({ baseUrl, apiKey });
      if (gen !== this.openRouterLoadGen) {
        return;
      }
      if (res.ok) {
        this.openRouterLoadedKey = key;
        this.openRouterModels.set(res.models);
      } else {
        this.openRouterLoadedKey = '';
        this.openRouterModels.set([]);
        this.openRouterError.set(res.error);
      }
    } catch (err) {
      if (gen !== this.openRouterLoadGen) {
        return;
      }
      this.openRouterLoadedKey = '';
      this.openRouterModels.set([]);
      this.openRouterError.set(err instanceof Error ? err.message : String(err));
    } finally {
      if (gen === this.openRouterLoadGen) {
        this.openRouterLoadingKey = '';
        this.openRouterLoading.set(false);
      }
    }
  }

  private async refreshCustomEndpoint(provider: LlmProviderConfig, force: boolean): Promise<void> {
    const baseUrl = this.effectiveCustomBaseUrl(provider);
    const apiKey = unwrapSecret(provider.apiKey).trim();
    const headers = (provider.customHeaders ?? []).map((h) => ({ key: h.key, value: unwrapSecret(h.value) }));
    const key = `${baseUrl}|${apiKey}|${headers.map((h) => `${h.key}:${h.value}`).join(',')}`;
    const existing = this.customEndpoints()[provider.id];
    if (!force && existing?.loading && this.customEndpointLoadingKeys.get(provider.id) === key) {
      return;
    }
    if (!force && this.customEndpointKeys.get(provider.id) === key && existing?.loaded) {
      return;
    }
    if (!baseUrl || !openAiCompatBaseUrl(baseUrl)) {
      this.customEndpointKeys.delete(provider.id);
      this.customEndpointLoadingKeys.delete(provider.id);
      this.customEndpoints.update((map) => ({
        ...map,
        [provider.id]: { loading: false, loaded: true, models: [], error: 'Configure a valid base URL in Settings.' },
      }));
      return;
    }
    const gen = (this.customEndpointGens.get(provider.id) ?? 0) + 1;
    this.customEndpointGens.set(provider.id, gen);
    this.customEndpointLoadingKeys.set(provider.id, key);
    this.customEndpoints.update((map) => ({
      ...map,
      [provider.id]: { loading: true, loaded: false, models: existing?.models ?? [], error: '' },
    }));
    try {
      const res = await this.electron.openAiCompatListModels({ baseUrl, apiKey, headers });
      if (this.customEndpointGens.get(provider.id) !== gen) {
        return;
      }
      if (res.ok) {
        this.customEndpointKeys.set(provider.id, key);
        this.customEndpoints.update((map) => ({
          ...map,
          [provider.id]: { loading: false, loaded: true, models: res.models, error: '' },
        }));
      } else {
        this.customEndpointKeys.delete(provider.id);
        this.customEndpoints.update((map) => ({
          ...map,
          [provider.id]: { loading: false, loaded: true, models: [], error: res.error },
        }));
      }
    } catch (err) {
      if (this.customEndpointGens.get(provider.id) !== gen) {
        return;
      }
      this.customEndpointKeys.delete(provider.id);
      this.customEndpoints.update((map) => ({
        ...map,
        [provider.id]: {
          loading: false,
          loaded: true,
          models: [],
          error: err instanceof Error ? err.message : String(err),
        },
      }));
    } finally {
      if (this.customEndpointGens.get(provider.id) === gen) {
        this.customEndpointLoadingKeys.delete(provider.id);
      }
    }
  }

  private glowModel(): void {
    this.clearGlowTimers();
    this.modelGlow.set(false);
    this.glowTimers.push(
      setTimeout(() => this.modelGlow.set(true), 0),
      setTimeout(() => this.modelGlow.set(false), MODEL_GLOW_MS),
    );
  }

  private clearGlowTimers(): void {
    for (const timer of this.glowTimers) {
      clearTimeout(timer);
    }
    this.glowTimers = [];
  }

  private placePanel(): void {
    const trigger = this.host.nativeElement.querySelector('.provider-picker__trigger');
    if (!(trigger instanceof HTMLElement)) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const availW = Math.max(0, window.innerWidth - 16);
    const maxW = availW > 0 ? Math.min(600, availW) : 320;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const openUp = this.statusBar() || (spaceBelow < 360 && spaceAbove > spaceBelow);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - maxW - 8));
    const availH = (openUp ? spaceAbove : spaceBelow) - 12;
    const maxHeight = availH > 0 ? Math.min(360, Math.max(80, availH)) : 220;
    this.panelStyle.set(
      openUp
        ? {
            position: 'fixed',
            left: `${left}px`,
            width: `${maxW}px`,
            bottom: `${window.innerHeight - rect.top + 6}px`,
            top: 'auto',
            height: `${maxHeight}px`,
            zIndex: '10000',
          }
        : {
            position: 'fixed',
            left: `${left}px`,
            width: `${maxW}px`,
            top: `${rect.bottom + 6}px`,
            bottom: 'auto',
            height: `${maxHeight}px`,
            zIndex: '10000',
          },
    );
  }

  private keepPanelInViewport(panel: HTMLElement): void {
    const r = panel.getBoundingClientRect();
    const maxLeft = window.innerWidth - r.width - 8;
    if (r.left > maxLeft) {
      this.panelStyle.update((style) => ({ ...style, left: `${Math.max(8, maxLeft)}px` }));
    }
  }
}
