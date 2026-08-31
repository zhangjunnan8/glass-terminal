import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import {
  HOST_PROTOCOL_OPTIONS,
  SSH_SHELL_KIND_OPTIONS,
  type HostFolder,
  type HostInput,
  type HostProfile,
  type HostProtocol,
  type SshAuthMethod,
  type SshShellKind,
} from '../shared/host';
import type { RuntimeInfo } from '../shared/ipc';
import { PRODUCT_NAME } from '../shared/product';
import type { AppSettings } from '../shared/settings';
import type { BackupImportChallenge, BackupImportResponse } from '../shared/backup';
import type { SessionRecord } from '../shared/session';
import type { ProviderProfile } from '../shared/provider';
import {
  containsObviousAgentSecret,
  type AgentMemoryCategory,
} from '../shared/agent-memory';
import type {
  AgentAssistantDelta,
  AgentBackendRef,
  AgentFileAccessMode,
  AgentRuntimeState,
  AgentReviewMode,
  AgentSessionView,
} from '../shared/agent';
import type { ShellProfile, TerminalDescriptor } from '../shared/terminal';
import type {
  RemoteWorkspaceAtomicity,
  RemoteWritePolicy,
} from '../shared/tools';
import { mergeAgentAssistantDelta, mergeAgentState } from './agent-state';
import { TerminalPane } from './components/TerminalPane';
import { SftpDrawer } from './components/SftpDrawer';
import { AgentContextMeter } from './components/AgentContextMeter';
import {
  AgentMemoryPanel,
  type AgentMemoryDraftSource,
} from './components/AgentMemoryPanel';
import { AgentReviewModePicker } from './components/AgentReviewModePicker';
import { AgentTurnProcess } from './components/AgentTurnProcess';
import { ToolActivityList } from './components/ToolActivityList';
import {
  isAgentOutputNearBottom,
  scrollAgentOutputToBottom,
} from './agent-scroll';
import { clampAgentPanelWidth, shouldSubmitAgentComposer } from './agent-ui';
import { readUiTheme, resolveUiTheme, useSystemTheme } from './theme';
import type { UiTheme } from './theme';
import {
  agentStateLabel,
  authMethodLabel,
  executionStatusLabel,
  formatClock,
  formatDuration,
  providerStatusLabel,
  roleLabel,
  sessionStatusLabel,
} from './ui-text';

const AgentMessageContent = lazy(async () => {
  const module = await import('./components/AgentMessageContent');
  return { default: module.AgentMessageContent };
});

const SessionHistoryDialog = lazy(async () => {
  const module = await import('./components/SessionHistoryDialog');
  return { default: module.SessionHistoryDialog };
});

interface TerminalTab extends TerminalDescriptor {
  createdAt: number;
  status: 'connected' | 'exited';
}

interface ConnectionSecret {
  password?: string;
  passphrase?: string;
  saveCredential?: boolean;
}

interface UiMessage {
  tone: 'success' | 'error';
  text: string;
}

interface HostCredentialMessage extends UiMessage {
  hostId: string;
}

type HostFolderDialog =
  | { mode: 'create'; folder: null }
  | { mode: 'rename' | 'delete'; folder: HostFolder };

type HostTreeDrag =
  | { kind: 'folder'; id: string }
  | { kind: 'host'; id: string };

interface TrustChallenge {
  host: HostProfile;
  fingerprint: string;
  secret: ConnectionSecret;
  sessionId?: string;
}

interface CompleteAccessChallenge {
  terminalId: string;
  target: string;
  backend: AgentBackendRef;
}

type SidebarView = 'terminals' | 'hosts' | 'history';

function sameAgentBackend(left: AgentBackendRef | undefined, right: AgentBackendRef): boolean {
  return left?.kind === 'generic-provider' && left.providerId === right.providerId;
}

function isBackupImportChallenge(
  response: BackupImportResponse,
): response is BackupImportChallenge {
  return 'challenge' in response;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function agentTurnBusy(state?: AgentRuntimeState): boolean {
  return Boolean(state && [
    'THINKING',
    'WAITING_APPROVAL',
    'AI_CONTROL',
    'RUNNING',
    'WAITING_OUTPUT',
    'WAITING_AUTH',
    'TAKEOVER_PENDING',
  ].includes(state));
}

/** Max composer height in pixels before the textarea stops growing and scrolls. */
const MAX_COMPOSER_HEIGHT_PX = 240;

const THEME_ORDER: AppSettings['theme'][] = ['dark', 'light', 'system'];

function nextThemeSetting(theme: AppSettings['theme']): AppSettings['theme'] {
  const index = THEME_ORDER.indexOf(theme);
  return THEME_ORDER[(index + 1) % THEME_ORDER.length] ?? 'dark';
}

function themeLabel(theme: AppSettings['theme']): string {
  if (theme === 'light') return '☀ 亮色';
  if (theme === 'system') return '◐ 跟随系统';
  return '☾ 深色';
}

function themeActionLabel(theme: AppSettings['theme']): string {
  const next = nextThemeSetting(theme);
  if (next === 'light') return '切换到亮色';
  if (next === 'system') return '切换到跟随系统';
  return '切换到深色';
}

function sessionRecencyLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '时间未知';
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const sameYear = date.getFullYear() === now.getFullYear();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDifference = Math.round((startOfToday - startOfDate) / 86_400_000);
  if (dayDifference === 0) return `今天 ${time}`;
  if (dayDifference === 1) return `昨天 ${time}`;
  return `${sameYear ? `${date.getMonth() + 1}月${date.getDate()}日` : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`} ${time}`;
}

export function App() {
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [uiTheme, setUiTheme] = useState<UiTheme>(() => readUiTheme());
  const systemTheme = useSystemTheme();
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [shells, setShells] = useState<ShellProfile[]>([]);
  const [hosts, setHosts] = useState<HostProfile[]>([]);
  const [hostFolders, setHostFolders] = useState<HostFolder[]>([]);
  const [collapsedHostFolders, setCollapsedHostFolders] = useState<Set<string>>(() => new Set());
  const [hostFolderDialog, setHostFolderDialog] = useState<HostFolderDialog | null>(null);
  const [hostFolderNameDraft, setHostFolderNameDraft] = useState('');
  const [hostFolderError, setHostFolderError] = useState<string | null>(null);
  const [hostFolderActionPending, setHostFolderActionPending] = useState(false);
  const [hostTreeDrag, setHostTreeDrag] = useState<HostTreeDrag | null>(null);
  const [hostBackupNotice, setHostBackupNotice] = useState<string | null>(null);
  const [hostBackupExportOpen, setHostBackupExportOpen] = useState(false);
  const [hostBackupIncludeCredentials, setHostBackupIncludeCredentials] = useState(false);
  const [hostBackupPassphrase, setHostBackupPassphrase] = useState('');
  const [hostBackupPassphraseConfirmation, setHostBackupPassphraseConfirmation] = useState('');
  const [hostBackupImportChallenge, setHostBackupImportChallenge] = useState<BackupImportChallenge | null>(null);
  const [hostBackupImportPassphrase, setHostBackupImportPassphrase] = useState('');
  const [hostBackupPending, setHostBackupPending] = useState(false);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [providers, setProviders] = useState<ProviderProfile[]>([]);
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [sidebarView, setSidebarView] = useState<SidebarView>('terminals');
  const [sidebarSearch, setSidebarSearch] = useState('');
  const [newTerminalOpen, setNewTerminalOpen] = useState(false);
  const [sftpOpen, setSftpOpen] = useState(false);
  const agentBodyRef = useRef<HTMLDivElement>(null);
  const agentComposerRef = useRef<HTMLTextAreaElement>(null);
  const agentStickToBottomRef = useRef(true);
  const agentResizeCleanupRef = useRef<(() => void) | null>(null);
  const sshConnectionLock = useRef(false);
  const [agentStates, setAgentStates] = useState<Record<string, AgentSessionView>>({});
  const agentStatesRef = useRef<Record<string, AgentSessionView>>({});
  const agentDeltaQueueRef = useRef<AgentAssistantDelta[]>([]);
  const agentDeltaFrameRef = useRef<number | null>(null);
  const agentDeltaResyncRef = useRef<Set<string>>(new Set());
  const [agentUpdatesBelow, setAgentUpdatesBelow] = useState(false);
  const [agentPanelVisible, setAgentPanelVisible] = useState(true);
  const [agentControlsExpanded, setAgentControlsExpanded] = useState(false);
  const [agentPanelWidth, setAgentPanelWidth] = useState(390);
  const [agentPrompt, setAgentPrompt] = useState('');
  const [editingAgentMessageId, setEditingAgentMessageId] = useState<string | null>(null);
  const [editingAgentTerminalId, setEditingAgentTerminalId] = useState<string | null>(null);
  const [agentMessageActionPending, setAgentMessageActionPending] = useState<string | null>(null);
  const [agentMemoryDraftSource, setAgentMemoryDraftSource] = useState<AgentMemoryDraftSource | null>(null);
  const [editedApprovalCommand, setEditedApprovalCommand] = useState('');
  const [editingHost, setEditingHost] = useState<HostProfile | null | undefined>(undefined);
  const [editingHostProtocol, setEditingHostProtocol] = useState<HostProtocol>('ssh');
  const [hostFormAuthMethod, setHostFormAuthMethod] = useState<SshAuthMethod>('password');
  const [hostFormPrivateKeyPath, setHostFormPrivateKeyPath] = useState('');
  const [hostFormShellKind, setHostFormShellKind] = useState<SshShellKind>('posix');
  const [connectingHost, setConnectingHost] = useState<HostProfile | null>(null);
  const [reconnectingSessionId, setReconnectingSessionId] = useState<string | null>(null);
  const [renamingSession, setRenamingSession] = useState<SessionRecord | null>(null);
  const [viewingSessionHistory, setViewingSessionHistory] = useState<SessionRecord | null>(null);
  const [sessionRenameDraft, setSessionRenameDraft] = useState('');
  const [sessionRenameError, setSessionRenameError] = useState<string | null>(null);
  const [sessionRenamePending, setSessionRenamePending] = useState(false);
  const [trustChallenge, setTrustChallenge] = useState<TrustChallenge | null>(null);
  const [completeAccessChallenge, setCompleteAccessChallenge] = useState<CompleteAccessChallenge | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [workspaceActionError, setWorkspaceActionError] = useState<string | null>(null);
  const [remoteAtomicity, setRemoteAtomicity] = useState<RemoteWorkspaceAtomicity | null>(null);
  const [sshConnectionPending, setSshConnectionPending] = useState(false);
  const [hostCredentialMessage, setHostCredentialMessage] = useState<HostCredentialMessage | null>(null);
  const [credentialActionPending, setCredentialActionPending] = useState(false);

  useEffect(() => {
    const settingsBridge = window.aiTerminal.settings;
    if (!settingsBridge) return undefined;
    void settingsBridge.get().then((settings) => {
      setAppSettings(settings);
      setUiTheme(resolveUiTheme(settings.theme));
    }).catch(() => undefined);
    const removeSettingsListener = settingsBridge.onChanged((settings) => {
      setAppSettings(settings);
      setUiTheme(resolveUiTheme(settings.theme));
    });
    return removeSettingsListener;
  }, []);

  useEffect(() => {
    if (appSettings?.theme === 'system') setUiTheme(systemTheme);
  }, [systemTheme, appSettings?.theme]);

  useEffect(() => window.aiTerminal.sessions.onRenamed((session) => {
    setSessions((current) => [
      session,
      ...current.filter((candidate) => candidate.id !== session.id),
    ]);
  }), []);

  useEffect(() => {
    void window.aiTerminal.runtime.getInfo().then(setRuntime);
    void window.aiTerminal.hosts.list().then(setHosts).catch((error) => {
      setStartupError(errorMessage(error));
    });
    void window.aiTerminal.hosts.listFolders().then(setHostFolders).catch((error) => {
      setStartupError(errorMessage(error));
    });
    void window.aiTerminal.sessions.list().then(setSessions).catch((error) => {
      setStartupError(errorMessage(error));
    });
    void window.aiTerminal.providers.list().then(setProviders).catch((error) => {
      setStartupError(errorMessage(error));
    });
    const removeProviderListener = window.aiTerminal.providers.onChanged(setProviders);
    const removeAgentListener = window.aiTerminal.agent.onStateChanged((state) => {
      installAgentSnapshot(state);
      setTabs((current) => current.map((tab) => (
        tab.id === state.terminalId ? { ...tab, sessionId: state.sessionId } : tab
      )));
    });
    const removeAgentDeltaListener = window.aiTerminal.agent.onAssistantDelta((event) => {
      queueAgentAssistantDelta(event);
    });

    let cancelled = false;
    void window.aiTerminal.terminal.listShells()
      .then(async (profiles) => {
        if (cancelled) return;
        setShells(profiles);
        if (profiles.length === 0) throw new Error('未检测到受支持的本地 Shell。');
        const descriptor = await window.aiTerminal.terminal.create({
          profileId: profiles[0].id,
        });
        if (cancelled) {
          await window.aiTerminal.terminal.close(descriptor.id);
          return;
        }
        setTabs([{ ...descriptor, createdAt: Date.now(), status: 'connected' }]);
        setActiveId(descriptor.id);
      })
      .catch((error: unknown) => setStartupError(errorMessage(error)));
    return () => {
      cancelled = true;
      removeAgentListener();
      removeAgentDeltaListener();
      removeProviderListener();
      if (agentDeltaFrameRef.current !== null) {
        cancelAnimationFrame(agentDeltaFrameRef.current);
        agentDeltaFrameRef.current = null;
      }
      agentDeltaQueueRef.current = [];
    };
  }, []);

  function installAgentSnapshot(
    state: AgentSessionView,
    acceptEqualRevision = false,
  ): void {
    const prior = agentStatesRef.current[state.terminalId];
    const merged = acceptEqualRevision && prior?.revision === state.revision
      ? { ...agentStatesRef.current, [state.terminalId]: state }
      : mergeAgentState(agentStatesRef.current, state);
    if (merged === agentStatesRef.current) return;
    agentStatesRef.current = merged;
    setAgentStates(merged);
  }

  function resyncAgentSnapshot(terminalId: string): void {
    if (agentDeltaResyncRef.current.has(terminalId)) return;
    agentDeltaResyncRef.current.add(terminalId);
    void window.aiTerminal.agent.getState(terminalId)
      .then((state) => {
        // Deltas intentionally do not advance snapshot revision. A sequence
        // gap therefore accepts an equal-revision getState response, while an
        // older response still cannot overwrite a newer authority snapshot.
        if (state) installAgentSnapshot(state, true);
      })
      .catch(() => undefined)
      .finally(() => agentDeltaResyncRef.current.delete(terminalId));
  }

  function queueAgentAssistantDelta(event: AgentAssistantDelta): void {
    agentDeltaQueueRef.current.push(event);
    if (agentDeltaFrameRef.current !== null) return;
    agentDeltaFrameRef.current = requestAnimationFrame(() => {
      agentDeltaFrameRef.current = null;
      const batch = agentDeltaQueueRef.current.splice(0);
      let next = agentStatesRef.current;
      const resync = new Set<string>();
      for (const delta of batch) {
        if (resync.has(delta.terminalId)) continue;
        const merged = mergeAgentAssistantDelta(next, delta);
        next = merged.states;
        if (merged.outcome === 'resync') resync.add(delta.terminalId);
      }
      if (next !== agentStatesRef.current) {
        agentStatesRef.current = next;
        setAgentStates(next);
      }
      for (const terminalId of resync) resyncAgentSnapshot(terminalId);
    });
  }

  const subscribedTerminalIds = tabs.map((tab) => tab.id).join('\0');
  useEffect(() => {
    if (!subscribedTerminalIds) return undefined;
    const terminalIds = subscribedTerminalIds.split('\0');
    const removeListeners = terminalIds.map((terminalId) => (
      window.aiTerminal.terminal.onExit(terminalId, (event) => {
        setTabs((current) => current.map((tab) => (
          tab.id === event.terminalId ? { ...tab, status: 'exited' } : tab
        )));
        void refreshSessions();
      })
    ));
    return () => {
      for (const removeListener of removeListeners) removeListener();
    };
  }, [subscribedTerminalIds]);

  useEffect(() => {
    const handleOpenedTerminal = (event: Event) => {
      addTab((event as CustomEvent<TerminalDescriptor>).detail);
    };
    window.addEventListener('ai-terminal:terminal-opened', handleOpenedTerminal);
    return () => window.removeEventListener(
      'ai-terminal:terminal-opened',
      handleOpenedTerminal,
    );
  }, []);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeId) ?? null,
    [activeId, tabs],
  );
  const agentPanelRendered = agentPanelVisible && activeTab !== null;
  const activeSession = useMemo(() => {
    if (!activeTab) return null;
    return sessions.find((session) => session.id === activeTab.sessionId)
      ?? sessions.find((session) => (
        session.runtimeTerminalId === activeTab.id
        && session.connectionState === 'connected'
      ))
      ?? null;
  }, [activeTab, sessions]);
  const activeHost = activeSession?.hostId
    ? hosts.find((host) => host.id === activeSession.hostId) ?? null
    : null;

  useEffect(() => {
    if (
      !activeTab
      || activeTab.transport !== 'ssh'
      || activeTab.status !== 'connected'
      || activeSession?.workspace?.backend !== 'sftp'
    ) {
      setRemoteAtomicity(null);
      return undefined;
    }
    let cancelled = false;
    setRemoteAtomicity(null);
    void (async () => {
      const atomicity = await window.aiTerminal.sessions.remoteWorkspaceAtomicity(activeTab.id);
      if (!cancelled && atomicity) setRemoteAtomicity(atomicity);
    })().catch(() => {
      if (!cancelled) setRemoteAtomicity(null);
    });
    return () => { cancelled = true; };
  }, [
    activeTab?.id,
    activeTab?.status,
    activeTab?.transport,
    activeSession?.workspace?.backend,
    activeSession?.workspace?.root,
    activeSession?.workspace?.remoteWritePolicy,
  ]);
  const normalizedSidebarSearch = sidebarSearch.trim().toLocaleLowerCase('zh-CN');
  const filteredShells = normalizedSidebarSearch
    ? shells.filter((shell) => `${shell.label} ${shell.detail}`.toLocaleLowerCase('zh-CN')
      .includes(normalizedSidebarSearch))
    : shells;
  const filteredTabs = normalizedSidebarSearch
    ? tabs.filter((tab) => tab.title.toLocaleLowerCase('zh-CN').includes(normalizedSidebarSearch))
    : tabs;
  const hostFolderNames = new Map(hostFolders.map((folder) => [folder.id, folder.name]));
  const filteredHosts = [...(normalizedSidebarSearch
    ? hosts.filter((host) => `${host.name} ${host.username} ${host.hostname} ${host.group ?? ''} ${hostFolderNames.get(host.folderId ?? '') ?? ''}`
      .toLocaleLowerCase('zh-CN').includes(normalizedSidebarSearch))
    : hosts)].sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'zh-CN'));
  const orderedHostFolders = [...hostFolders]
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, 'zh-CN'));
  const filteredUngroupedHosts = filteredHosts.filter((host) => !host.folderId);
  const hasMatchingHostFolder = Boolean(normalizedSidebarSearch && orderedHostFolders.some((folder) => (
    folder.name.toLocaleLowerCase('zh-CN').includes(normalizedSidebarSearch)
  )));
  const filteredSessions = normalizedSidebarSearch
    ? sessions.filter((session) => {
      const host = session.hostId ? hosts.find((candidate) => candidate.id === session.hostId) : null;
      return `${session.name} ${host?.name ?? ''} ${session.effectiveUser ?? ''} ${session.cwd ?? ''}`
        .toLocaleLowerCase('zh-CN').includes(normalizedSidebarSearch);
    })
    : sessions;
  const defaultProvider = providers.find((provider) => provider.isDefault) ?? null;
  const activeAgent = activeTab ? agentStates[activeTab.id] : undefined;
  const activeReviewMode: AgentReviewMode = activeAgent?.reviewMode
    ?? (activeAgent?.fullTakeover ? 'complete' : 'all');
  const activeMessages = activeAgent?.messages ?? [];
  const activeActivities = activeAgent?.activities ?? [];
  const activeMessageIds = new Set(activeMessages.flatMap((message) => (
    message.turnId ? [message.id, message.turnId] : [message.id]
  )));
  const unmatchedActivities = activeActivities.filter((activity) => (
    !activity.turnId || !activeMessageIds.has(activity.turnId)
  ));
  const latestUserMessage = activeAgent
    ? [...activeAgent.messages].reverse().find((message) => message.role === 'user')
    : undefined;
  const selectedGenericProvider = defaultProvider;
  const selectedAgentBackend: AgentBackendRef | undefined = selectedGenericProvider
    ? { kind: 'generic-provider', providerId: selectedGenericProvider.id }
    : undefined;
  const activeRuntimeFileAccessMode: AgentFileAccessMode = activeAgent?.fileAccessMode ?? 'off';
  const activeGenericProviderId = activeAgent?.backend.providerId;
  const selectedGenericBackendMatchesActive = Boolean(
    selectedAgentBackend?.kind === 'generic-provider'
    && activeGenericProviderId
    && selectedAgentBackend.providerId === activeGenericProviderId,
  );
  const activeWorkspaceRoot = activeSession?.workspace?.root;
  const selectedAgentBackendReady = selectedGenericProvider?.status === 'ready';
  const selectedAgentBackendStatus = selectedGenericProvider
    ? `${selectedGenericProvider.name} · ${providerStatusLabel(selectedGenericProvider.status)}`
    : '尚未配置默认 Provider。';

  useLayoutEffect(() => {
    agentStickToBottomRef.current = true;
    setAgentUpdatesBelow(false);
    if (agentBodyRef.current) scrollAgentOutputToBottom(agentBodyRef.current);
  }, [activeId]);

  useLayoutEffect(() => {
    activeIdRef.current = activeId;
    setEditingAgentMessageId(null);
    setEditingAgentTerminalId(null);
    setAgentPrompt('');
  }, [activeId]);

  // Grow the composer with its content up to a threshold; beyond that it scrolls.
  useLayoutEffect(() => {
    const composer = agentComposerRef.current;
    if (!composer) return;
    composer.style.height = 'auto';
    composer.style.height = `${Math.min(composer.scrollHeight, MAX_COMPOSER_HEIGHT_PX)}px`;
  }, [agentPrompt]);

  useLayoutEffect(() => {
    const element = agentBodyRef.current;
    if (!element) return;
    if (agentStickToBottomRef.current) {
      scrollAgentOutputToBottom(element);
      setAgentUpdatesBelow(false);
    } else {
      setAgentUpdatesBelow(true);
    }
  }, [activeId, activeAgent?.revision, agentPanelVisible]);

  useEffect(() => {
    const clampForViewport = () => {
      setAgentPanelWidth((current) => clampAgentPanelWidth(current, window.innerWidth));
    };
    clampForViewport();
    window.addEventListener('resize', clampForViewport);
    return () => window.removeEventListener('resize', clampForViewport);
  }, []);

  useEffect(() => () => {
    agentResizeCleanupRef.current?.();
    document.body.classList.remove('agent-panel-resizing');
  }, []);

  function handleAgentBodyScroll() {
    const element = agentBodyRef.current;
    if (!element) return;
    const follows = isAgentOutputNearBottom(element);
    agentStickToBottomRef.current = follows;
    if (follows) setAgentUpdatesBelow(false);
  }

  function followLatestAgentOutput() {
    const element = agentBodyRef.current;
    if (!element) return;
    agentStickToBottomRef.current = true;
    scrollAgentOutputToBottom(element);
    setAgentUpdatesBelow(false);
  }

  function beginAgentPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    agentResizeCleanupRef.current?.();
    const separator = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = agentPanelWidth;
    const resize = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const requested = startWidth + startX - moveEvent.clientX;
      setAgentPanelWidth(clampAgentPanelWidth(requested, window.innerWidth));
    };
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      agentResizeCleanupRef.current = null;
      document.body.classList.remove('agent-panel-resizing');
      window.removeEventListener('pointermove', resize);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('blur', stop);
      separator.removeEventListener('lostpointercapture', stop);
      if (separator.hasPointerCapture?.(pointerId)) separator.releasePointerCapture(pointerId);
    };
    agentResizeCleanupRef.current = stop;
    document.body.classList.add('agent-panel-resizing');
    try {
      separator.setPointerCapture(pointerId);
    } catch {
      // Window-level listeners remain a safe fallback for synthetic/older pointer implementations.
    }
    separator.addEventListener('lostpointercapture', stop, { once: true });
    window.addEventListener('pointermove', resize);
    window.addEventListener('pointerup', stop, { once: true });
    window.addEventListener('pointercancel', stop, { once: true });
    window.addEventListener('blur', stop, { once: true });
  }

  function handleAgentComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (!shouldSubmitAgentComposer({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
    })) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }
  const activeInputMode = activeAgent?.terminalInputMode ?? 'human';
  const foregroundRunning = activeAgent?.state === 'PAUSED'
    && activeAgent.activeExecution?.status === 'running';
  const composerBlocked = agentTurnBusy(activeAgent?.state)
    || foregroundRunning;
  const workspaceChangeDisabledReason = !activeTab
    ? '请先选择终端'
    : activeTab.status !== 'connected'
      ? '终端已断开，不能修改工作区'
      : composerBlocked
          ? 'AI 正在运行，暂时不能修改工作区'
          : null;

  useEffect(() => {
    if (!activeId) return;
    void window.aiTerminal.agent.getState(activeId).then((state) => {
      if (state) installAgentSnapshot(state);
    });
  }, [activeId]);

  useEffect(() => {
    setEditedApprovalCommand(activeAgent?.pendingApproval?.command ?? '');
  }, [activeAgent?.pendingApproval?.id]);

  function addTab(descriptor: TerminalDescriptor) {
    const tab: TerminalTab = {
      ...descriptor,
      createdAt: Date.now(),
      status: 'connected',
    };
    setTabs((current) => [...current, tab]);
    setActiveId(tab.id);
  }

  async function openTerminal(profileId: string) {
    setNewTerminalOpen(false);
    try {
      addTab(await window.aiTerminal.terminal.create({ profileId }));
    } catch (error) {
      setStartupError(errorMessage(error));
    }
  }

  function closeTerminal(terminalId: string) {
    void window.aiTerminal.terminal.close(terminalId).catch(() => undefined);
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === terminalId);
      const remaining = current.filter((tab) => tab.id !== terminalId);
      if (activeId === terminalId) {
        setActiveId(remaining[Math.max(0, index - 1)]?.id ?? remaining[0]?.id ?? null);
      }
      return remaining;
    });
  }

  async function refreshHosts() {
    const next = await window.aiTerminal.hosts.list();
    setHosts(next);
    return next;
  }

  async function refreshHostFolders() {
    const next = await window.aiTerminal.hosts.listFolders();
    setHostFolders(next);
    return next;
  }

  async function exportHosts() {
    if (hostBackupIncludeCredentials && hostBackupPassphrase.trim().length < 12) {
      setHostBackupNotice('包含 SSH 凭据时，备份口令至少需要 12 个字符。');
      return;
    }
    if (
      hostBackupIncludeCredentials
      && hostBackupPassphrase !== hostBackupPassphraseConfirmation
    ) {
      setHostBackupNotice('两次输入的备份口令不一致。');
      return;
    }
    setHostBackupNotice(null);
    setHostBackupPending(true);
    try {
      const result = await window.aiTerminal.hostBackup.export({
        includeCredentials: hostBackupIncludeCredentials,
        ...(hostBackupIncludeCredentials ? {
          passphrase: hostBackupPassphrase,
          passphraseConfirmation: hostBackupPassphraseConfirmation,
        } : {}),
      });
      if (result) {
        setHostBackupNotice(
          `已导出 ${result.sections.length} 个分区${result.encrypted ? '，整包已加密' : '，未包含 SSH 凭据'}。`,
        );
        setHostBackupExportOpen(false);
        setHostBackupPassphrase('');
        setHostBackupPassphraseConfirmation('');
      }
    } catch (error) {
      setHostBackupNotice(errorMessage(error));
    } finally {
      setHostBackupPending(false);
    }
  }

  async function applyHostImportResponse(response: BackupImportResponse): Promise<void> {
    if (isBackupImportChallenge(response)) {
      setHostBackupImportChallenge(response);
      setHostBackupImportPassphrase('');
      setHostBackupNotice(response.message);
      return;
    }
    setHostBackupImportChallenge(null);
    setHostBackupImportPassphrase('');
    await refreshHosts();
    await refreshHostFolders();
    setHostBackupNotice(
      response.needsRestart
        ? `已导入 ${response.sectionsImported.length} 个分区，重启后生效。`
        : `已导入 ${response.sectionsImported.length} 个分区。`,
    );
  }

  async function importHosts() {
    setHostBackupNotice(null);
    setHostBackupPending(true);
    try {
      const result = await window.aiTerminal.hostBackup.import();
      if (result) await applyHostImportResponse(result);
    } catch (error) {
      setHostBackupNotice(errorMessage(error));
    } finally {
      setHostBackupPending(false);
    }
  }

  async function continueHostImport() {
    if (!hostBackupImportChallenge) return;
    setHostBackupNotice(null);
    setHostBackupPending(true);
    try {
      const result = await window.aiTerminal.hostBackup.import({
        token: hostBackupImportChallenge.token,
        ...(hostBackupImportChallenge.challenge === 'passphrase-required'
          ? { passphrase: hostBackupImportPassphrase }
          : { confirmLegacyPlaintext: true }),
      });
      if (result) await applyHostImportResponse(result);
    } catch (error) {
      setHostBackupNotice(errorMessage(error));
    } finally {
      setHostBackupPending(false);
    }
  }

  async function refreshSessions() {
    setSessions(await window.aiTerminal.sessions.list());
  }

  function upsertSessionBinding(session: SessionRecord) {
    setSessions((current) => [
      session,
      ...current.filter((candidate) => candidate.id !== session.id),
    ]);
    setTabs((current) => current.map((tab) => (
      tab.id === session.runtimeTerminalId ? { ...tab, sessionId: session.id } : tab
    )));
  }

  function openAgentBackendSettings() {
    void window.aiTerminal.settingsWindow.open('ai');
  }

  async function sendAgentPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (composerBlocked && latestUserMessage) {
      await interruptLatestAgentMessage(latestUserMessage.id);
      return;
    }
    if (
      !activeTab
      || !agentPrompt.trim()
      || !selectedAgentBackend
      || !selectedAgentBackendReady
      || agentMessageActionPending
    ) {
      return;
    }
    const requestTerminalId = activeTab.id;
    const replacementMessageId = editingAgentTerminalId === requestTerminalId
      ? editingAgentMessageId
      : null;
    const prompt = agentPrompt.trim();
    setWorkspaceActionError(null);
    setAgentPrompt('');
    setAgentMessageActionPending(replacementMessageId ?? 'send');
    try {
      const state = replacementMessageId
        ? await window.aiTerminal.agent.revisePrompt({
          terminalId: requestTerminalId,
          messageId: replacementMessageId,
          action: 'replace',
          prompt,
        })
        : await window.aiTerminal.agent.sendPrompt({
          terminalId: requestTerminalId,
          prompt,
          backend: selectedAgentBackend,
        });
      setEditingAgentMessageId(null);
      setEditingAgentTerminalId(null);
      installAgentSnapshot(state);
      setTabs((current) => current.map((tab) => (
        tab.id === state.terminalId ? { ...tab, sessionId: state.sessionId } : tab
      )));
      await refreshSessions();
    } catch (error) {
      if (activeIdRef.current === requestTerminalId) setAgentPrompt(prompt);
      setWorkspaceActionError(errorMessage(error));
      if (replacementMessageId) {
        // Refresh append-only conversation state after any failed replacement.
        try {
          const current = await window.aiTerminal.agent.getState(requestTerminalId);
          if (current) {
            installAgentSnapshot(current);
            if (!current.messages.some((message) => message.id === replacementMessageId)) {
              setEditingAgentMessageId(null);
              setEditingAgentTerminalId(null);
            }
          }
        } catch {
          // Keep the editable text available even if the refresh also fails.
        }
      }
    } finally {
      setAgentMessageActionPending(null);
    }
  }

  async function interruptLatestAgentMessage(messageId: string) {
    if (!activeTab || agentMessageActionPending) return;
    setWorkspaceActionError(null);
    setAgentMessageActionPending(messageId);
    try {
      const state = await window.aiTerminal.agent.interruptTurn({
        terminalId: activeTab.id,
        messageId,
      });
      installAgentSnapshot(state);
    } catch (error) {
      setWorkspaceActionError(errorMessage(error));
    } finally {
      setAgentMessageActionPending(null);
    }
  }

  function editLatestAgentMessage(messageId: string, content: string) {
    if (!activeTab || agentMessageActionPending) return;
    setEditingAgentMessageId(messageId);
    setEditingAgentTerminalId(activeTab.id);
    setAgentPrompt(content);
    requestAnimationFrame(() => {
      const composer = agentComposerRef.current;
      composer?.focus();
      composer?.setSelectionRange(composer.value.length, composer.value.length);
    });
  }

  async function saveAgentMemory(input: {
    memoryId?: string;
    category: AgentMemoryCategory;
    content: string;
    sourceMessageIds: string[];
    mergeMemoryIds: string[];
  }): Promise<void> {
    if (!activeTab) throw new Error('当前没有可用终端。');
    if (containsObviousAgentSecret(input.content)) {
      throw new Error('检测到明显凭据；上下文记忆未发送。');
    }
    const state = await window.aiTerminal.agent.saveMemory({
      terminalId: activeTab.id,
      ...input,
    });
    installAgentSnapshot(state);
  }

  async function removeAgentMemory(memoryId: string): Promise<void> {
    if (!activeTab) throw new Error('当前没有可用终端。');
    const state = await window.aiTerminal.agent.removeMemory({
      terminalId: activeTab.id,
      memoryId,
    });
    installAgentSnapshot(state);
  }

  function locateAgentMemorySource(sourceMessageId: string): void {
    const source = [...(agentBodyRef.current?.querySelectorAll<HTMLElement>(
      '[data-agent-message-id]',
    ) ?? [])].find((element) => element.dataset.agentMessageId === sourceMessageId);
    source?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    source?.focus({ preventScroll: true });
  }

  async function resolveAgentApproval(decision: 'execute' | 'edit' | 'reject') {
    if (!activeTab || !activeAgent?.pendingApproval) return;
    setWorkspaceActionError(null);
    try {
      const state = await window.aiTerminal.agent.resolveApproval({
        terminalId: activeTab.id,
        approvalId: activeAgent.pendingApproval.id,
        decision,
        editedCommand: decision === 'edit' ? editedApprovalCommand : undefined,
      });
      installAgentSnapshot(state);
    } catch (error) {
      setWorkspaceActionError(errorMessage(error));
    }
  }

  async function setAgentReviewMode(
    mode: AgentReviewMode,
    confirmed = false,
    terminalId = activeTab?.id,
    backend: AgentBackendRef | undefined = activeAgent?.backend ?? selectedAgentBackend,
  ): Promise<void> {
    if (!terminalId || !backend) return;
    setWorkspaceActionError(null);
    try {
      const state = await window.aiTerminal.agent.setReviewMode({
        terminalId,
        mode,
        backend,
        ...(mode === 'complete' ? { completeAccessConfirmed: confirmed } : {}),
      });
      installAgentSnapshot(state);
      setTabs((current) => current.map((tab) => (
        tab.id === state.terminalId ? { ...tab, sessionId: state.sessionId } : tab
      )));
      setCompleteAccessChallenge(null);
      await refreshSessions();
    } catch (error) {
      setWorkspaceActionError(errorMessage(error));
    }
  }

  async function resolveAgentTakeover(action: 'keep' | 'interrupt') {
    if (!activeTab || !activeAgent?.pendingTakeover) return;
    setWorkspaceActionError(null);
    try {
      const state = await window.aiTerminal.agent.resolveTakeover({
        terminalId: activeTab.id,
        takeoverId: activeAgent.pendingTakeover.id,
        executionId: activeAgent.pendingTakeover.executionId,
        action,
      });
      installAgentSnapshot(state);
    } catch (error) {
      setWorkspaceActionError(errorMessage(error));
    }
  }

  async function confirmShellReady(terminalId: string, executionId: string) {
    setWorkspaceActionError(null);
    try {
      const state = await window.aiTerminal.agent.confirmShellReady({
        terminalId,
        executionId,
      });
      installAgentSnapshot(state);
    } catch (error) {
      setWorkspaceActionError(errorMessage(error));
    }
  }

  async function chooseLocalWorkspace() {
    if (!activeTab || activeTab.transport !== 'local' || workspaceChangeDisabledReason) return;
    setWorkspaceActionError(null);
    try {
      const session = await window.aiTerminal.sessions.chooseLocalWorkspace({
        terminalId: activeTab.id,
      });
      if (session) upsertSessionBinding(session);
    } catch (error) {
      setWorkspaceActionError(errorMessage(error));
    }
  }

  async function setRemoteWorkspace(terminalId: string, path: string) {
    if (!activeTab || activeTab.id !== terminalId || activeTab.transport !== 'ssh') {
      throw new Error('工作区请求已过期，请在当前 SSH 终端重试。');
    }
    if (workspaceChangeDisabledReason) throw new Error(workspaceChangeDisabledReason);
    const session = await window.aiTerminal.sessions.setWorkspace({
      terminalId,
      root: path,
    });
    upsertSessionBinding(session);
  }

  async function setRemoteWritePolicy(policy: RemoteWritePolicy) {
    if (
      !activeTab
      || activeTab.transport !== 'ssh'
      || activeSession?.workspace?.backend !== 'sftp'
    ) return;
    if (workspaceChangeDisabledReason) throw new Error(workspaceChangeDisabledReason);
    setWorkspaceActionError(null);
    try {
      const session = await window.aiTerminal.sessions.setWorkspace({
        terminalId: activeTab.id,
        root: activeSession.workspace.root,
        remoteWritePolicy: policy,
      });
      upsertSessionBinding(session);
    } catch (error) {
      setWorkspaceActionError(errorMessage(error));
    }
  }

  async function clearWorkspace() {
    if (!activeTab || !activeSession || workspaceChangeDisabledReason) return;
    setWorkspaceActionError(null);
    try {
      const session = await window.aiTerminal.sessions.clearWorkspace({
        terminalId: activeTab.id,
      });
      upsertSessionBinding(session);
    } catch (error) {
      setWorkspaceActionError(errorMessage(error));
    }
  }

  function openSessionRename(session: SessionRecord) {
    setRenamingSession(session);
    setSessionRenameDraft(session.name);
    setSessionRenameError(null);
  }

  function openSessionHistory(session: SessionRecord) {
    setWorkspaceActionError(null);
    setViewingSessionHistory(session);
  }

  function handleSessionDeleted(sessionId: string) {
    setSessions((current) => current.filter((session) => session.id !== sessionId));
    const remainingTabs = tabs.filter((tab) => tab.sessionId !== sessionId);
    setTabs(remainingTabs);
    if (activeId && tabs.some((tab) => tab.id === activeId && tab.sessionId === sessionId)) {
      setActiveId(remainingTabs.at(-1)?.id ?? null);
    }
    setViewingSessionHistory(null);
  }

  function closeSessionRename() {
    if (sessionRenamePending) return;
    setRenamingSession(null);
    setSessionRenameDraft('');
    setSessionRenameError(null);
  }

  async function renameSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!renamingSession || sessionRenamePending) return;
    const name = sessionRenameDraft.trim();
    if (!name) {
      setSessionRenameError('请输入会话名称。');
      return;
    }
    if (name === renamingSession.name) {
      closeSessionRename();
      return;
    }
    setSessionRenamePending(true);
    setSessionRenameError(null);
    try {
      const renamed = await window.aiTerminal.sessions.rename({
        sessionId: renamingSession.id,
        name,
      });
      setSessions((current) => current.map((session) => (
        session.id === renamed.id ? renamed : session
      )));
      setTabs((current) => current.map((tab) => (
        tab.sessionId === renamed.id || tab.id === renamed.runtimeTerminalId
          ? { ...tab, title: renamed.name }
          : tab
      )));
      await refreshSessions();
      setRenamingSession(null);
      setSessionRenameDraft('');
    } catch (error) {
      setSessionRenameError(errorMessage(error));
    } finally {
      setSessionRenamePending(false);
    }
  }

  function openHostEditor(host: HostProfile | null) {
    setConnectionError(null);
    setEditingHostProtocol('ssh');
    setHostFormAuthMethod(host?.authMethod ?? 'password');
    setHostFormPrivateKeyPath(host?.privateKeyPath ?? '');
    setHostFormShellKind(host?.shellKind ?? 'posix');
    setEditingHost(host);
  }

  async function choosePrivateKeyFile() {
    try {
      const path = await window.aiTerminal.hosts.choosePrivateKeyPath();
      if (path) setHostFormPrivateKeyPath(path);
    } catch (error) {
      setConnectionError(errorMessage(error));
    }
  }

  function openHostFolderDialog(mode: HostFolderDialog['mode'], folder?: HostFolder) {
    if (mode !== 'create' && !folder) return;
    const dialog: HostFolderDialog = mode === 'create'
      ? { mode, folder: null }
      : { mode, folder: folder! };
    setHostFolderDialog(dialog);
    setHostFolderNameDraft(dialog.folder?.name ?? '');
    setHostFolderError(null);
  }

  function closeHostFolderDialog() {
    if (hostFolderActionPending) return;
    setHostFolderDialog(null);
    setHostFolderNameDraft('');
    setHostFolderError(null);
  }

  async function submitHostFolderDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hostFolderDialog || hostFolderActionPending) return;
    const name = hostFolderNameDraft.trim();
    if (hostFolderDialog.mode !== 'delete' && !name) {
      setHostFolderError('请输入文件夹名称。');
      return;
    }
    setHostFolderActionPending(true);
    setHostFolderError(null);
    try {
      if (hostFolderDialog.mode === 'create') {
        const created = await window.aiTerminal.hosts.createFolder({ name });
        setCollapsedHostFolders((current) => {
          const next = new Set(current);
          next.delete(created.id);
          return next;
        });
      } else if (hostFolderDialog.mode === 'rename') {
        await window.aiTerminal.hosts.renameFolder({
          folderId: hostFolderDialog.folder.id,
          name,
        });
      } else {
        await window.aiTerminal.hosts.removeFolder(hostFolderDialog.folder.id);
        setCollapsedHostFolders((current) => {
          const next = new Set(current);
          next.delete(hostFolderDialog.folder.id);
          return next;
        });
      }
      await refreshHostFolders();
      setHostFolderDialog(null);
      setHostFolderNameDraft('');
    } catch (error) {
      setHostFolderError(errorMessage(error));
    } finally {
      setHostFolderActionPending(false);
    }
  }

  function toggleHostFolder(folderId: string) {
    setCollapsedHostFolders((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }

  function startHostTreeDrag(
    event: ReactDragEvent<HTMLElement>,
    item: HostTreeDrag,
  ) {
    setHostTreeDrag(item);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', `${item.kind}:${item.id}`);
  }

  function allowHostTreeDrop(event: ReactDragEvent<HTMLElement>) {
    if (!hostTreeDrag) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }

  async function moveDraggedHost(folderId: string | null, beforeHostId: string | null) {
    if (hostTreeDrag?.kind !== 'host') return;
    const hostId = hostTreeDrag.id;
    setHostTreeDrag(null);
    setWorkspaceActionError(null);
    try {
      await window.aiTerminal.hosts.moveHost({ hostId, folderId, beforeHostId });
      await refreshHosts();
      if (folderId) {
        setCollapsedHostFolders((current) => {
          const next = new Set(current);
          next.delete(folderId);
          return next;
        });
      }
    } catch (error) {
      setWorkspaceActionError(errorMessage(error));
    }
  }

  async function dropOnHostFolder(folder: HostFolder, beforeFolder = false) {
    if (!hostTreeDrag) return;
    if (hostTreeDrag.kind === 'host') {
      await moveDraggedHost(folder.id, null);
      return;
    }
    const folderId = hostTreeDrag.id;
    setHostTreeDrag(null);
    setWorkspaceActionError(null);
    try {
      const next = await window.aiTerminal.hosts.moveFolder({
        folderId,
        beforeFolderId: beforeFolder ? folder.id : null,
      });
      setHostFolders(next);
    } catch (error) {
      setWorkspaceActionError(errorMessage(error));
    }
  }

  async function moveDraggedFolderToEnd() {
    if (hostTreeDrag?.kind !== 'folder') return;
    const folderId = hostTreeDrag.id;
    setHostTreeDrag(null);
    setWorkspaceActionError(null);
    try {
      setHostFolders(await window.aiTerminal.hosts.moveFolder({
        folderId,
        beforeFolderId: null,
      }));
    } catch (error) {
      setWorkspaceActionError(errorMessage(error));
    }
  }

  async function saveHost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editingHostProtocol !== 'ssh') return;
    const data = new FormData(event.currentTarget);
    const input: HostInput = {
      id: editingHost?.id,
      protocol: 'ssh',
      name: String(data.get('name') ?? ''),
      hostname: String(data.get('hostname') ?? ''),
      port: Number(data.get('port') ?? 22),
      username: String(data.get('username') ?? ''),
      authMethod: hostFormAuthMethod,
      privateKeyPath: hostFormAuthMethod === 'private-key'
        ? hostFormPrivateKeyPath
        : undefined,
      shellKind: hostFormShellKind,
      folderId: String(data.get('folderId') ?? '') || null,
      favorite: data.get('favorite') === 'on',
    };
    try {
      const saved = await window.aiTerminal.hosts.save(input);
      if (editingHost?.credentialConfigured && !saved.credentialConfigured) {
        setHostCredentialMessage({
          hostId: saved.id,
          tone: 'success',
          text: 'SSH 连接身份已变更，旧的已保存凭据已停用。',
        });
      }
      await refreshHosts();
      setSelectedHostId(saved.id);
      setEditingHost(undefined);
    } catch (error) {
      setConnectionError(errorMessage(error));
    }
  }

  async function removeHost(host: HostProfile) {
    if (!window.confirm(`确定删除主机“${host.name}”吗？`)) return;
    const previouslySelectedHostId = selectedHostId;
    setWorkspaceActionError(null);
    setHosts((current) => current.filter((candidate) => candidate.id !== host.id));
    setSelectedHostId((current) => current === host.id ? null : current);
    setHostCredentialMessage(null);
    try {
      await window.aiTerminal.hosts.remove(host.id);
    } catch (error) {
      const message = errorMessage(error);
      setHosts((current) => current.some((candidate) => candidate.id === host.id)
        ? current
        : [...current, host]);
      if (previouslySelectedHostId === host.id) {
        setSelectedHostId((current) => current ?? host.id);
      }
      setHostCredentialMessage({
        hostId: host.id,
        tone: 'error',
        text: message,
      });
      setWorkspaceActionError(message);
      await refreshHosts().catch(() => undefined);
    }
  }

  function openSshConnection(host: HostProfile, sessionId?: string) {
    setConnectionError(null);
    setReconnectingSessionId(sessionId ?? null);
    if (
      host.credentialConfigured
      || host.authMethod === 'agent'
      || host.authMethod === 'private-key'
    ) {
      void establishSsh(host, {}, undefined, sessionId);
      return;
    }
    setConnectingHost(host);
  }

  async function forgetHostCredential(host: HostProfile) {
    if (credentialActionPending) return;
    if (!window.confirm(`确定删除“${host.name}”已保存的 SSH 凭据吗？`)) return;
    setCredentialActionPending(true);
    setConnectionError(null);
    try {
      await window.aiTerminal.hosts.forgetCredential(host.id);
      const nextHosts = await refreshHosts();
      const updated = nextHosts.find((candidate) => candidate.id === host.id);
      setConnectingHost((current) => (
        current?.id === host.id && updated ? updated : current
      ));
      setHostCredentialMessage({
        hostId: host.id,
        tone: 'success',
        text: '已从本机密钥库删除 SSH 凭据。',
      });
    } catch (error) {
      const message = errorMessage(error);
      setConnectionError(message);
      setHostCredentialMessage({ hostId: host.id, tone: 'error', text: message });
    } finally {
      setCredentialActionPending(false);
    }
  }

  async function establishSsh(
    host: HostProfile,
    secret: ConnectionSecret,
    trustHostKey?: string,
    sessionId = reconnectingSessionId ?? undefined,
  ) {
    if (sshConnectionLock.current) return;
    sshConnectionLock.current = true;
    setSshConnectionPending(true);
    setConnectionError(null);
    try {
      const result = await window.aiTerminal.terminal.connectSsh({
        hostId: host.id,
        sessionId,
        ...secret,
        trustHostKey,
      });
      if (result.status === 'host-key-required') {
        setTrustChallenge({ host, fingerprint: result.fingerprint, secret, sessionId });
        setConnectingHost(null);
        return;
      }
      addTab(result.terminal);
      setConnectingHost(null);
      setReconnectingSessionId(null);
      setTrustChallenge(null);
      const nextHosts = await refreshHosts();
      await refreshSessions();
      const updatedHost = nextHosts.find((candidate) => candidate.id === host.id);
      if (result.credentialWarning) {
        setHostCredentialMessage({
          hostId: host.id,
          tone: 'error',
          text: result.credentialWarning,
        });
      } else if (secret.saveCredential && updatedHost?.credentialConfigured) {
        setHostCredentialMessage({
          hostId: host.id,
          tone: 'success',
          text: 'SSH 凭据已保存到本机密钥库。',
        });
      } else if (secret.saveCredential && !updatedHost?.credentialConfigured) {
        setHostCredentialMessage({
          hostId: host.id,
          tone: 'error',
          text: '本次连接没有可保存的密码或私钥口令。',
        });
      }
    } catch (error) {
      setConnectionError(errorMessage(error));
      if (
        !secret.password
        && !secret.passphrase
        && (host.credentialConfigured || host.authMethod === 'private-key')
      ) {
        setConnectingHost(host);
        setReconnectingSessionId(sessionId ?? null);
      }
    } finally {
      sshConnectionLock.current = false;
      setSshConnectionPending(false);
    }
  }

  function submitConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!connectingHost) return;
    const data = new FormData(event.currentTarget);
    void establishSsh(connectingHost, {
      password: String(data.get('password') ?? '') || undefined,
      passphrase: String(data.get('passphrase') ?? '') || undefined,
      saveCredential: data.get('saveCredential') === 'on',
    });
  }

  function toggleSelectedHost(host: HostProfile) {
    setSelectedHostId((current) => current === host.id ? null : host.id);
    if (host.folderId) {
      setCollapsedHostFolders((current) => {
        const next = new Set(current);
        next.delete(host.folderId!);
        return next;
      });
    }
  }

  function renderHostTreeEntry(host: HostProfile, folderId: string | null) {
    const expanded = selectedHostId === host.id;
    const hostSessions = sessions.filter((session) => session.hostId === host.id);
    return (
      <div
        className={`host-tree-item ${hostTreeDrag?.kind === 'host' && hostTreeDrag.id === host.id ? 'dragging' : ''}`}
        data-host-id={host.id}
        key={host.id}
        onDragOver={(event) => {
          if (hostTreeDrag?.kind === 'host') allowHostTreeDrop(event);
        }}
        onDrop={(event) => {
          if (hostTreeDrag?.kind !== 'host') return;
          event.preventDefault();
          event.stopPropagation();
          void moveDraggedHost(folderId, host.id);
        }}
      >
        <div className="host-row-shell">
          <button
            className={`host-row ${expanded ? 'active' : ''}`}
            aria-expanded={expanded}
            onClick={() => toggleSelectedHost(host)}
          >
            <span className="host-icon">{host.favorite ? '★' : '◇'}</span>
            <span>
              <strong>{host.name}</strong>
              <small>{host.username}@{host.hostname}:{host.port}</small>
            </span>
          </button>
          <button
            type="button"
            className="host-drag-handle"
            draggable
            aria-label={`拖拽排序 ${host.name}`}
            title="按住拖拽排序或移入文件夹"
            data-action="drag-host"
            onClick={(event) => event.stopPropagation()}
            onDragStart={(event) => startHostTreeDrag(event, { kind: 'host', id: host.id })}
            onDragEnd={() => setHostTreeDrag(null)}
          ><span aria-hidden="true" /></button>
        </div>
        <div
          className={`host-details-collapse ${expanded ? 'open' : ''}`}
          aria-hidden={!expanded}
          data-testid={`host-details-${host.id}`}
        >
          <div className="host-details-collapse-inner">
            <div className="selected-host-card">
              <div className="host-card-summary">
                <div className="host-card-identity">
                  <strong>{host.name}</strong>
                  <span>{authMethodLabel(host.authMethod)} · {host.hostKeyFingerprint ? '已信任' : '未验证'}</span>
                </div>
                <div className="host-card-actions">
                  <button
                    className="compact-text-action"
                    data-action="connect-host"
                    title={sshConnectionPending ? '正在连接' : '连接主机'}
                    aria-label={sshConnectionPending ? '正在连接' : `连接主机 ${host.name}`}
                    disabled={sshConnectionPending}
                    onClick={() => openSshConnection(host)}
                  >{sshConnectionPending ? '连接中' : '连接'}</button>
                  <button
                    className="compact-text-action"
                    title="编辑主机"
                    aria-label="编辑主机"
                    onClick={() => openHostEditor(host)}
                  >编辑</button>
                  <button
                    className="compact-text-action danger"
                    data-action="remove-host"
                    title="删除主机"
                    aria-label="删除主机"
                    onClick={() => void removeHost(host)}
                  >删除</button>
                </div>
              </div>
              {host.authMethod !== 'agent' && (
                <div className="host-credential-row">
                  <small title="凭据保存在本机密钥库中">
                    {host.credentialConfigured ? '凭据已保存' : '凭据未保存'}
                  </small>
                  {host.credentialConfigured && (
                    <button
                      className="compact-text-action"
                      type="button"
                      title="删除已保存凭据"
                      aria-label="删除已保存凭据"
                      data-action="forget-host-credential"
                      disabled={credentialActionPending}
                      onClick={() => void forgetHostCredential(host)}
                    >{credentialActionPending ? '删除中' : '删除凭据'}</button>
                  )}
                </div>
              )}
              {hostCredentialMessage?.hostId === host.id && (
                <div
                  className={`host-credential-message ${hostCredentialMessage.tone}`}
                  role={hostCredentialMessage.tone === 'error' ? 'alert' : 'status'}
                >{hostCredentialMessage.text}</div>
              )}
              <div className="host-session-history">
                <small>会话历史</small>
                {hostSessions.map((session) => {
                  const liveTab = tabs.find((tab) => (
                    tab.status === 'connected'
                    && (tab.sessionId === session.id || tab.id === session.runtimeTerminalId)
                  ));
                  return (
                    <div
                      className="session-history-row"
                      key={session.id}
                      title={`${sessionStatusLabel(session.status)} · ${new Date(session.updatedAt).toLocaleString('zh-CN')}`}
                    >
                      <span className="session-history-name" title={session.name}>{session.name}</span>
                      <span className="session-history-actions">
                        <button
                          className="compact-text-action"
                          type="button"
                          title="查看历史"
                          aria-label="查看历史"
                          data-action="view-session-history"
                          data-session-id={session.id}
                          onClick={() => openSessionHistory(session)}
                        >历史</button>
                        <button
                          className="compact-text-action"
                          type="button"
                          title="重命名会话"
                          aria-label="重命名会话"
                          data-action="rename-session"
                          data-session-id={session.id}
                          onClick={() => openSessionRename(session)}
                        >重命名</button>
                        <button
                          className="compact-text-action"
                          type="button"
                          title={liveTab ? '打开' : '重连'}
                          aria-label={liveTab ? '打开' : '重连'}
                          data-action="reconnect-session"
                          data-session-id={session.id}
                          disabled={sshConnectionPending}
                          onClick={() => {
                            if (liveTab) setActiveId(liveTab.id);
                            else openSshConnection(host, session.id);
                          }}
                        >{liveTab ? '打开' : '重连'}</button>
                      </span>
                    </div>
                  );
                })}
                {hostSessions.length === 0 && <small>尚无正式会话。</small>}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`app-shell ${agentPanelRendered ? '' : 'agent-panel-hidden'}`}
      data-locale={appSettings?.language ?? 'zh-CN'}
      data-theme={uiTheme}
      data-agent-panel-visible={agentPanelRendered ? 'true' : 'false'}
      style={{ '--agent-panel-width': `${agentPanelWidth}px` } as CSSProperties}
    >
      <header className="titlebar">
        <div className="brand-mark" aria-hidden="true">&gt;_</div>
        <div className="brand-copy">
          <strong>{PRODUCT_NAME}</strong>
          <span>共享终端智能体</span>
        </div>
        <div className="workspace-title">本地工作区</div>
        <button
          type="button"
          className="theme-toggle"
          data-action="toggle-theme"
          data-theme-setting={appSettings?.theme ?? 'dark'}
          aria-label={themeActionLabel(appSettings?.theme ?? 'dark')}
          title={themeActionLabel(appSettings?.theme ?? 'dark')}
          onClick={() => {
            const current = appSettings?.theme ?? 'dark';
            const next = nextThemeSetting(current);
            setUiTheme(resolveUiTheme(next));
            setAppSettings((prev) => (prev ? { ...prev, theme: next } : prev));
            void Promise.resolve(window.aiTerminal.settings?.update({ theme: next }))
              .catch(() => undefined);
          }}
        >{themeLabel(appSettings?.theme ?? 'dark')}</button>
        <div className="runtime-pill">
          <span className="status-dot" />
          {runtime ? `${runtime.platform} · ${runtime.arch}` : '正在启动…'}
        </div>
      </header>

      {workspaceActionError && (
        <div className="workspace-action-error" role="alert" data-testid="workspace-action-error">
          <span>{workspaceActionError}</span>
          <button
            type="button"
            aria-label="关闭操作错误"
            onClick={() => setWorkspaceActionError(null)}
          >×</button>
        </div>
      )}

      <aside className="activitybar" aria-label="主导航">
        <button
          className={`activity ${sidebarView === 'terminals' ? 'active' : ''}`}
          title="终端"
          data-action="show-terminals"
          aria-pressed={sidebarView === 'terminals'}
          onClick={() => {
            setSidebarView('terminals');
            setSidebarSearch('');
          }}
        >⌁</button>
        <button
          className={`activity ${sidebarView === 'hosts' ? 'active' : ''}`}
          title="主机"
          data-action="show-hosts"
          aria-pressed={sidebarView === 'hosts'}
          onClick={() => {
            setSidebarView('hosts');
            setSidebarSearch('');
          }}
        >▦</button>
        <button
          className={`activity ${sftpOpen ? 'active' : ''}`}
          title="SFTP 文件与传输"
          data-action="toggle-sftp"
          onClick={() => setSftpOpen((open) => !open)}
        >⇅</button>
        <button
          className={`activity ${sidebarView === 'history' ? 'active' : ''}`}
          title="会话历史"
          data-action="show-history"
          aria-pressed={sidebarView === 'history'}
          onClick={() => {
            setSidebarView('history');
            setSidebarSearch('');
          }}
        >◷</button>
        <div className="activity-spacer" />
        <button className="activity" title="设置" data-action="open-settings" onClick={() => {
          void window.aiTerminal.settingsWindow.open();
        }}>⚙</button>
      </aside>

      <aside className="sidebar">
        <div className="panel-heading">
          <span>{sidebarView === 'terminals'
            ? '终端'
            : sidebarView === 'hosts' ? '主机' : '会话历史'}</span>
          {sidebarView === 'hosts' && (
            <>
              <button title="导出主机配置" onClick={() => {
                setHostBackupIncludeCredentials(false);
                setHostBackupPassphrase('');
                setHostBackupPassphraseConfirmation('');
                setHostBackupExportOpen(true);
              }}>⇩</button>
              <button title="导入主机配置" disabled={hostBackupPending} onClick={() => void importHosts()}>⇧</button>
              <button title="添加主机" onClick={() => openHostEditor(null)}>＋</button>
            </>
          )}
        </div>
        {sidebarView === 'hosts' && hostBackupNotice && (
          <div className="host-backup-notice" role="status">{hostBackupNotice}</div>
        )}
        <label className="search-box">
          <span>⌕</span>
          <input
            aria-label="筛选当前列表"
            placeholder={sidebarView === 'terminals'
              ? '搜索 Shell 或终端'
              : sidebarView === 'hosts' ? '搜索主机或文件夹' : '搜索会话历史'}
            value={sidebarSearch}
            onChange={(event) => setSidebarSearch(event.target.value)}
          />
        </label>

        <div className="sidebar-view-body" data-sidebar-view={sidebarView}>
          {sidebarView === 'terminals' && (
            <>
              <div className="section-label">本地 SHELL</div>
              <div className="host-list compact">
                {filteredShells.map((shell) => (
                  <button className="host-row" key={shell.id} onClick={() => void openTerminal(shell.id)}>
                    <span className="host-icon">{shell.kind === 'wsl' ? '◈' : '⌘'}</span>
                    <span>
                      <strong>{shell.label}</strong>
                      <small>{shell.detail}</small>
                    </span>
                  </button>
                ))}
                {filteredShells.length === 0 && <div className="empty-list">没有匹配的本地 Shell</div>}
              </div>
              <div className="section-label">已打开终端</div>
              <div className="host-list open-terminal-list">
                {filteredTabs.map((tab) => (
                  <button
                    className={`host-row ${tab.id === activeId ? 'active' : ''}`}
                    key={tab.id}
                    onClick={() => setActiveId(tab.id)}
                  >
                    <span className="host-icon">{tab.transport === 'ssh' ? '◇' : '⌘'}</span>
                    <span>
                      <strong>{tab.title}</strong>
                      <small>{tab.transport === 'ssh' ? 'SSH' : '本地'} · {tab.status === 'connected' ? '已连接' : '已退出'}</small>
                    </span>
                  </button>
                ))}
                {filteredTabs.length === 0 && <div className="empty-list">没有匹配的已打开终端</div>}
              </div>
            </>
          )}

          {sidebarView === 'hosts' && (
            <>
              <div className="section-label section-with-action">
                <span>主机</span>
                <span className="host-section-actions">
                  <button
                    className="icon-btn"
                    data-action="create-host-folder"
                    title="新建主机文件夹"
                    aria-label="新建主机文件夹"
                    onClick={() => openHostFolderDialog('create')}
                  >▣</button>
                  <button
                    className="icon-btn"
                    title="添加主机"
                    aria-label="添加主机"
                    onClick={() => openHostEditor(null)}
                  >＋</button>
                </span>
              </div>
              <div
                className={`host-tree host-list ${hostTreeDrag ? `drag-${hostTreeDrag.kind}` : ''}`}
                data-testid="host-tree"
              >
                {orderedHostFolders.map((folder) => {
                  const allFolderHosts = hosts.filter((host) => host.folderId === folder.id)
                    .sort((left, right) => left.sortOrder - right.sortOrder);
                  const folderMatchesSearch = normalizedSidebarSearch
                    && folder.name.toLocaleLowerCase('zh-CN').includes(normalizedSidebarSearch);
                  const folderHosts = folderMatchesSearch
                    ? allFolderHosts
                    : filteredHosts.filter((host) => host.folderId === folder.id);
                  if (normalizedSidebarSearch && folderHosts.length === 0 && !folderMatchesSearch) {
                    return null;
                  }
                  const collapsed = normalizedSidebarSearch
                    ? false
                    : collapsedHostFolders.has(folder.id);
                  const isDragged = hostTreeDrag?.kind === 'folder' && hostTreeDrag.id === folder.id;
                  return (
                    <section
                      className={`host-folder ${isDragged ? 'dragging' : ''}`}
                      data-folder-id={folder.id}
                      key={folder.id}
                      onDragOver={allowHostTreeDrop}
                      onDrop={(event) => {
                        event.preventDefault();
                        void dropOnHostFolder(folder, hostTreeDrag?.kind === 'folder');
                      }}
                    >
                      <div className="host-folder-heading">
                        <button
                          type="button"
                          className="host-folder-toggle"
                          aria-expanded={!collapsed}
                          onClick={() => toggleHostFolder(folder.id)}
                        >
                          <span className="host-folder-chevron" aria-hidden="true">›</span>
                          <span aria-hidden="true">▣</span>
                          <strong>{folder.name}</strong>
                          <small>{allFolderHosts.length}</small>
                        </button>
                        <span className="host-folder-actions">
                          <button
                            type="button"
                            title="重命名文件夹"
                            aria-label={`重命名文件夹 ${folder.name}`}
                            onClick={() => openHostFolderDialog('rename', folder)}
                          >✎</button>
                          <button
                            type="button"
                            className="danger-text"
                            title={allFolderHosts.length > 0 ? '请先移出文件夹中的主机' : '删除空文件夹'}
                            aria-label={`删除文件夹 ${folder.name}`}
                            disabled={allFolderHosts.length > 0}
                            onClick={() => openHostFolderDialog('delete', folder)}
                          >×</button>
                        </span>
                        <button
                          type="button"
                          className="host-drag-handle folder-drag-handle"
                          draggable
                          aria-label={`拖拽排序文件夹 ${folder.name}`}
                          title="按住拖拽文件夹排序"
                          data-action="drag-host-folder"
                          onDragStart={(event) => startHostTreeDrag(event, { kind: 'folder', id: folder.id })}
                          onDragEnd={() => setHostTreeDrag(null)}
                        ><span aria-hidden="true" /></button>
                      </div>
                      <div className={`host-folder-contents ${collapsed ? '' : 'open'}`} aria-hidden={collapsed}>
                        <div>
                          {folderHosts.map((host) => renderHostTreeEntry(host, folder.id))}
                          {folderHosts.length === 0 && <div className="host-folder-empty">拖拽主机到此文件夹</div>}
                        </div>
                      </div>
                    </section>
                  );
                })}

                {filteredUngroupedHosts.map((host) => renderHostTreeEntry(host, null))}

                <div
                  className="host-root-drop"
                  data-drop-zone="host-root"
                  onDragOver={(event) => {
                    if (hostTreeDrag?.kind === 'host') allowHostTreeDrop(event);
                  }}
                  onDrop={(event) => {
                    if (hostTreeDrag?.kind !== 'host') return;
                    event.preventDefault();
                    void moveDraggedHost(null, null);
                  }}
                >拖到此处移出文件夹</div>

                <div
                  className="host-folder-end-drop"
                  data-drop-zone="folder-end"
                  onDragOver={(event) => {
                    if (hostTreeDrag?.kind === 'folder') allowHostTreeDrop(event);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    void moveDraggedFolderToEnd();
                  }}
                >拖到此处将文件夹移到末尾</div>
                {filteredHosts.length === 0 && normalizedSidebarSearch && !hasMatchingHostFolder && (
                  <div className="empty-list">没有匹配的主机或文件夹</div>
                )}
              </div>
            </>
          )}

          {sidebarView === 'history' && (
            <div className="history-sidebar-list">
              <div className="history-sidebar-summary">
                <span>{filteredSessions.length} 个会话</span>
                <small>按最近更新排列</small>
              </div>
              {filteredSessions.map((session) => {
                const host = session.hostId
                  ? hosts.find((candidate) => candidate.id === session.hostId)
                  : undefined;
                const runtimeTab = tabs.find((tab) => (
                  tab.status === 'connected'
                  && (tab.sessionId === session.id || tab.id === session.runtimeTerminalId)
                ));
                return (
                  <article
                    className={`history-sidebar-row ${runtimeTab ? 'live' : ''}`}
                    data-session-status={session.status}
                    key={session.id}
                  >
                    <button
                      className="history-session-main"
                      data-action="view-session-history"
                      data-session-id={session.id}
                      aria-label={`查看会话：${session.name}`}
                      onClick={() => openSessionHistory(session)}
                    >
                      <span className="history-session-heading">
                        <span className="history-session-status-dot" aria-hidden="true" />
                        <strong title={session.name}>{session.name}</strong>
                        {runtimeTab && <em>已打开</em>}
                      </span>
                      <span className="history-session-target">
                        <span aria-hidden="true">{session.transport === 'ssh' ? '◇' : '⌘'}</span>
                        {host?.name ?? (session.transport === 'ssh' ? session.targetSnapshot.label : '本地 Shell')}
                        {session.effectiveUser ? ` · ${session.effectiveUser}` : ''}
                      </span>
                      {(session.workspace?.root || session.cwd) && (
                        <code title={session.workspace?.root ?? session.cwd}>
                          {session.workspace?.root ?? session.cwd}
                        </code>
                      )}
                      <span className="history-session-meta">
                        <span>{sessionStatusLabel(session.status)}</span>
                        <time
                          dateTime={session.updatedAt}
                          title={new Date(session.updatedAt).toLocaleString('zh-CN')}
                        >{sessionRecencyLabel(session.updatedAt)}</time>
                      </span>
                    </button>
                    <div className="history-session-actions">
                      <button
                        className="compact-text-action"
                        type="button"
                        title="查看会话"
                        aria-label={`查看会话 ${session.name}`}
                        onClick={() => openSessionHistory(session)}
                      >历史</button>
                      <button
                        className="compact-text-action"
                        type="button"
                        title="重命名会话"
                        aria-label={`重命名会话 ${session.name}`}
                        onClick={() => openSessionRename(session)}
                      >重命名</button>
                      {host && (
                        <button
                          className="compact-text-action"
                          type="button"
                          title={runtimeTab ? '打开终端' : '重连会话'}
                          aria-label={`${runtimeTab ? '打开终端' : '重连会话'} ${session.name}`}
                          disabled={sshConnectionPending}
                          onClick={() => {
                            if (runtimeTab) setActiveId(runtimeTab.id);
                            else openSshConnection(host, session.id);
                          }}
                        >{runtimeTab ? '打开' : '重连'}</button>
                      )}
                    </div>
                  </article>
                );
              })}
              {filteredSessions.length === 0 && <div className="empty-list">没有匹配的正式会话</div>}
            </div>
          )}
        </div>
        <div className="sidebar-footer">无遥测 · 主机、会话与终端互相独立</div>
      </aside>

      <main className="workspace">
        <nav className="tabs" aria-label="终端标签页">
          {tabs.map((tab) => (
            <button
              className={`tab ${tab.id === activeId ? 'active' : ''}`}
              key={tab.id}
              onClick={() => setActiveId(tab.id)}
            >
              <span className={`tab-state ${tab.status}`} />
              <span className="tab-title">{tab.title}</span>
              <span
                className="tab-close"
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTerminal(tab.id);
                }}
              >×</span>
            </button>
          ))}
          <div className="new-tab-wrap">
            <button className="new-tab" title="新建终端" onClick={() => setNewTerminalOpen((open) => !open)}>＋</button>
            {newTerminalOpen && (
              <div className="shell-menu">
                {shells.map((shell) => (
                  <button key={shell.id} onClick={() => void openTerminal(shell.id)}>
                    <strong>{shell.label}</strong>
                    <span>{shell.detail}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </nav>

        <section
          className={[
            'terminal-stage',
            activeInputMode === 'locked' ? 'agent-controlled' : '',
            activeInputMode === 'secure-human' ? 'auth-required' : '',
            activeReviewMode === 'complete' ? 'complete-access' : '',
          ].filter(Boolean).join(' ')}
          data-agent-state={activeAgent?.state ?? 'USER_CONTROL'}
          data-input-mode={activeInputMode}
          data-review-mode={activeReviewMode}
        >
          <div className="terminal-toolbar">
            <span>
              {activeAgent ? agentStateLabel(activeAgent.state) : '用户控制'}
              {activeReviewMode === 'complete'
                ? ' · 完全访问'
                : activeReviewMode === 'risky' ? ' · 风险审核' : activeAgent ? ' · 全部审核' : ''}
            </span>
            <div className="terminal-actions">
              <span>{activeTab?.status === 'exited'
                ? '已断开'
                : activeTab?.transport === 'ssh' ? 'SSH' : activeTab ? '本地' : '无终端'}</span>
              {activeTab?.status === 'exited' && activeTab.hostId && (
                <button onClick={() => {
                  const host = hosts.find((item) => item.id === activeTab.hostId);
                  if (host) openSshConnection(host, activeTab.sessionId);
                }}>重连</button>
              )}
              <button title="搜索终端">⌕</button>
              <button title="终端操作">⋯</button>
            </div>
          </div>
          <div className="terminal-stack">
            {tabs.map((tab) => (
              <TerminalPane
                key={tab.id}
                terminalId={tab.id}
                active={tab.id === activeId}
                inputMode={agentStates[tab.id]?.terminalInputMode ?? 'human'}
                uiTheme={uiTheme}
              />
            ))}
            {tabs.length === 0 && !startupError && (
              <div className="terminal-placeholder">请选择本地 Shell 或主机以打开终端。</div>
            )}
            {startupError && <div className="terminal-error">{startupError}</div>}
          </div>
          <footer className="terminal-statusbar">
            <div className="terminal-workspace-binding" data-testid="terminal-workspace-binding">
              <span>Workspace:</span>
              <code title={activeSession?.workspace?.root ?? '当前会话未设置工作区'}>
                {activeSession?.workspace?.root ?? '未设置'}
              </code>
              {activeTab && (
                <button
                  type="button"
                  data-action="choose-workspace"
                  aria-label={activeTab.transport === 'ssh' ? '选择远程工作区' : '选择本地工作区'}
                  disabled={Boolean(workspaceChangeDisabledReason)}
                  title={workspaceChangeDisabledReason
                    ?? (activeTab.transport === 'ssh'
                      ? '在 SFTP 面板中选择远程工作区'
                      : '选择本地工作区')}
                  onClick={() => {
                    if (activeTab.transport === 'ssh') setSftpOpen(true);
                    else void chooseLocalWorkspace();
                  }}
                >选择…</button>
              )}
              {activeSession?.workspace && (
                <button
                  type="button"
                  data-action="clear-workspace"
                  aria-label="清除工作区"
                  disabled={Boolean(workspaceChangeDisabledReason)}
                  title={workspaceChangeDisabledReason ?? '清除当前工作区'}
                  onClick={() => void clearWorkspace()}
                >清除</button>
              )}
              {activeSession?.workspace?.backend === 'sftp' && (
                <details className="remote-atomicity" data-testid="remote-atomicity">
                  <summary>
                    远程写入：{(activeSession.workspace.remoteWritePolicy ?? 'strict') === 'strict'
                      ? '严格'
                      : '兼容'}
                  </summary>
                  <div className="remote-atomicity-popover">
                    <strong>远程发布策略</strong>
                    <label>
                      <span>当前策略</span>
                      <select
                        aria-label="远程写入策略"
                        value={activeSession.workspace.remoteWritePolicy ?? 'strict'}
                        disabled={Boolean(workspaceChangeDisabledReason)}
                        onChange={(event) => void setRemoteWritePolicy(
                          event.target.value as RemoteWritePolicy,
                        )}
                      >
                        <option value="strict">严格（能力不足时拒绝）</option>
                        <option value="compatible">兼容（接受降级风险）</option>
                      </select>
                    </label>
                    <div className="remote-capability-list" aria-label="服务器远程发布能力">
                      {([
                        ['hardlink', 'hardlink'],
                        ['fsync', 'fsync'],
                        ['posixRename', 'posix-rename'],
                      ] as const).map(([key, label]) => (
                        <span
                          key={key}
                          data-supported={remoteAtomicity?.capabilities[key] ? 'true' : 'false'}
                        >{label}: {remoteAtomicity
                            ? remoteAtomicity.capabilities[key] ? '支持' : '不支持'
                            : '检测中'}</span>
                      ))}
                    </div>
                    {remoteAtomicity?.capabilities.detection === 'unknown' && (
                      <p>能力探测未知；严格模式按“不支持”处理并拒绝不安全写入。</p>
                    )}
                    {(activeSession.workspace.remoteWritePolicy ?? 'strict') === 'strict' ? (
                      <p>
                        新建需要 hardlink 原子无覆盖发布；覆盖需要 posix-rename 原子替换。
                        该策略不提供服务器端 CAS。
                      </p>
                    ) : (
                      <p className="risk">
                        降级新建仍禁止覆盖，但中断可能留下部分文件；普通 rename 不保证原子替换，
                        且不提供服务器端 CAS。
                      </p>
                    )}
                  </div>
                </details>
              )}
            </div>
            <div className="terminal-status-meta">
              <span>UTF-8</span>
              <span>{activeTab?.transport === 'ssh' ? 'SSH PTY' : 'ConPTY'}</span>
              <span>{activeSession ? '正式会话' : '临时终端'}</span>
            </div>
          </footer>
        </section>
        {sftpOpen && (
          <SftpDrawer
            terminal={activeTab}
            workspaceRoot={activeSession?.workspace?.root}
            onSetWorkspace={activeTab?.transport === 'ssh' && !workspaceChangeDisabledReason
              ? setRemoteWorkspace
              : undefined}
            onClose={() => setSftpOpen(false)}
          />
        )}
        {activeTab && !agentPanelVisible && (
          <button
            className="show-agent-panel"
            data-action="show-agent-panel"
            onClick={() => setAgentPanelVisible(true)}
          >显示 AI</button>
        )}
      </main>

      {agentPanelRendered && (
      <aside className="agent-panel">
        <div
          className="agent-panel-resizer"
          role="separator"
          aria-label="调整 AI 栏宽度"
          aria-orientation="vertical"
          aria-valuemin={300}
          aria-valuemax={720}
          aria-valuenow={agentPanelWidth}
          tabIndex={0}
          onPointerDown={beginAgentPanelResize}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const delta = event.key === 'ArrowLeft' ? 24 : -24;
            setAgentPanelWidth((current) => clampAgentPanelWidth(
              current + delta,
              window.innerWidth,
            ));
          }}
        />
        <div className="agent-header">
          <div className="agent-heading">
            <div className="agent-heading-title-row">
              <strong>AI 智能体</strong>
              <span className="agent-heading-actions">
                <button
                  type="button"
                  title={agentControlsExpanded ? '收起智能体设置' : '展开智能体设置'}
                  aria-label={agentControlsExpanded ? '收起智能体设置' : '展开智能体设置'}
                  aria-expanded={agentControlsExpanded}
                  data-action="toggle-agent-controls"
                  onClick={() => setAgentControlsExpanded((current) => !current)}
                ><span aria-hidden>{agentControlsExpanded ? '▴' : '▾'}</span></button>
                <button
                  type="button"
                  title="隐藏 AI 栏"
                  aria-label="隐藏 AI 栏"
                  data-action="hide-agent-panel"
                  onClick={() => setAgentPanelVisible(false)}
                >×</button>
              </span>
            </div>
            {agentControlsExpanded && (
              <div className="agent-backend-picker">
                <span>当前 Provider</span>
                <strong>{defaultProvider?.name ?? '尚未配置'}</strong>
                <AgentReviewModePicker
                  value={activeReviewMode}
                  disabled={!activeTab || composerBlocked || !selectedAgentBackendReady}
                  onSelect={(mode) => {
                    if (mode !== 'complete') {
                      void setAgentReviewMode(mode);
                      return;
                    }
                    if (!activeTab || !selectedAgentBackend) return;
                    setCompleteAccessChallenge({
                      terminalId: activeTab.id,
                      target: activeTab.title,
                      backend: activeAgent?.backend ?? selectedAgentBackend,
                    });
                  }}
                />
              </div>
            )}
            <span
              id="agent-backend-status"
              className={`agent-backend-status ${selectedAgentBackendReady ? 'ready' : 'unavailable'}`}
              data-testid="agent-backend-status"
              role="status"
            >{selectedAgentBackendStatus}</span>
          </div>
          {agentControlsExpanded && (
            <div className="agent-controls">
              <div className="agent-context-and-memory">
                <AgentContextMeter
                  usage={selectedGenericBackendMatchesActive
                    ? activeAgent?.contextUsage
                    : undefined}
                  contextWindowTokens={selectedGenericProvider?.contextWindowTokens}
                />
                <AgentMemoryPanel
                  memories={selectedGenericBackendMatchesActive
                    ? activeAgent?.memories ?? []
                    : []}
                  messages={selectedGenericBackendMatchesActive
                    ? activeAgent?.messages ?? []
                    : []}
                  disabled={!activeTab || composerBlocked || !selectedGenericBackendMatchesActive}
                  draftSource={agentMemoryDraftSource}
                  onDraftConsumed={() => setAgentMemoryDraftSource(null)}
                  onSave={saveAgentMemory}
                  onRemove={removeAgentMemory}
                  onLocate={locateAgentMemorySource}
                />
              </div>
              <span className="agent-file-access-root" data-testid="agent-file-access-status">
                {activeWorkspaceRoot
                  ? `工作范围提示：${activeWorkspaceRoot}（不限制文件权限）`
                  : '未设置工作范围提示；文件工具仍可直接使用'}
              </span>
            </div>
          )}
        </div>
        <div className="agent-body-shell">
          <div
            className="agent-body"
            data-testid="agent-scroll-container"
            ref={agentBodyRef}
            onScroll={handleAgentBodyScroll}
          >
          {!activeAgent?.messages.length && !activeAgent?.activities?.length && (
            <div className={`agent-empty ${selectedGenericProvider ? '' : 'provider-onboarding'}`}>
              <div className="agent-glyph">✦</div>
              <strong>{selectedGenericProvider ? '理解终端上下文的 AI 助手' : '首次使用：配置 AI Provider'}</strong>
              <p>{selectedGenericProvider
                ? '智能体会读取当前会话；默认“全部审核”，也可切换为“风险审核”或橙色“完全访问”。'
                : '添加 OpenAI 兼容 API 后，即可在当前终端中使用 AI。保存时会自动检测连接，无需重启软件。'}</p>
              <div className="guardrail"><span>✓</span> {selectedGenericProvider
                ? '同一审核模式同时管理终端命令和文件工具'
                : '支持 OpenAI 兼容接口与手动模型 ID'}</div>
              <button
                className="provider-configure primary"
                data-action="open-agent-provider-settings"
                data-testid="open-agent-backend-settings"
                onClick={openAgentBackendSettings}
              >
                {selectedGenericProvider ? '管理 AI Provider' : '立即配置 AI 服务'}
              </button>
            </div>
          )}
          {activeAgent?.messages.map((message, index) => {
            const latestUser = message.role === 'user' && message.id === latestUserMessage?.id;
            const latestUserRunning = latestUser && (
              agentTurnBusy(activeAgent.state) || foregroundRunning
            );
            const previousMessage = activeAgent.messages[index - 1];
            const turnDurationMs = message.role === 'assistant'
              && previousMessage?.role === 'user'
              ? new Date(message.createdAt).getTime() - new Date(previousMessage.createdAt).getTime()
              : undefined;
            const turnKey = message.turnId ?? message.id;
            const turnActivities = message.role === 'assistant'
              ? activeActivities.filter((activity) => activity.turnId === turnKey)
              : [];
            if (message.role === 'assistant' && message.presentation === 'intermediate') {
              const firstProcessIndex = activeAgent.messages.findIndex((candidate) => (
                candidate.role === 'assistant'
                && candidate.presentation === 'intermediate'
                && candidate.turnId === message.turnId
              ));
              if (firstProcessIndex !== index) return null;
              const processMessages = activeAgent.messages.filter((candidate) => (
                candidate.role === 'assistant'
                && candidate.presentation === 'intermediate'
                && candidate.turnId === message.turnId
              ));
              const processCompleted = activeAgent.messages.some((candidate) => (
                candidate.role === 'assistant'
                && candidate.presentation === 'summary'
                && candidate.turnId === message.turnId
              ));
              return (
                <AgentTurnProcess
                  key={`${turnKey}:process`}
                  completed={processCompleted}
                  stageCount={processMessages.length}
                  activities={turnActivities}
                >
                  {processMessages.map((processMessage) => (
                    <div className="agent-turn-process-message" key={processMessage.id}>
                      <Suspense fallback={<p className="agent-plain-message">{processMessage.content}</p>}>
                        <AgentMessageContent role="assistant" content={processMessage.content} />
                      </Suspense>
                    </div>
                  ))}
                </AgentTurnProcess>
              );
            }
            return (
            <article
              className={`agent-message ${message.role}`}
              key={message.id}
              data-agent-message-id={message.id}
              tabIndex={-1}
            >
              <header className="agent-message-header">
                <span className="agent-message-avatar" aria-hidden="true">
                  {message.role === 'user' ? '你' : message.role === 'assistant' ? '✦' : 'i'}
                </span>
                <span className="agent-message-role">
                  <strong>{roleLabel(message.role)}</strong>
                  <span className="agent-message-meta">
                    <time className="agent-message-time">{formatClock(message.createdAt)}</time>
                    {turnDurationMs !== undefined && turnDurationMs >= 0 && (
                      <small className="agent-message-duration">耗时 {formatDuration(turnDurationMs)}</small>
                    )}
                  </span>
                </span>
              </header>
              <div className="agent-message-content">
                <Suspense fallback={<p className="agent-plain-message">{message.content}</p>}>
                  <AgentMessageContent
                    role={message.role}
                    content={message.content}
                    streaming={activeAgent.streamingMessageId === message.id}
                  />
                </Suspense>
              </div>
              <div className="agent-message-memory-action">
                <button
                  type="button"
                  className="agent-message-icon-btn"
                  data-action="pin-agent-memory"
                  disabled={
                    composerBlocked
                    || containsObviousAgentSecret(message.content)
                  }
                  title={containsObviousAgentSecret(message.content)
                    ? '检测到明显凭据，不能保存到上下文记忆'
                    : '提炼并保存为当前 AI 对话的持久上下文记忆卡片'}
                  aria-label="存为记忆"
                  onClick={() => setAgentMemoryDraftSource({
                    id: message.id,
                    content: message.content,
                  })}
                >◈</button>
              </div>
              {turnActivities.length > 0 && !activeAgent.messages.some((candidate) => (
                candidate.presentation === 'intermediate' && candidate.turnId === turnKey
              )) && (
                <ToolActivityList
                  activities={turnActivities}
                  testId={`tool-activity-list-${message.id}`}
                  compact
                />
              )}
              {latestUser && (
                !latestUserRunning && (
                  <div className="agent-message-actions" data-testid="latest-user-message-actions">
                    <small title="终端输出、命令执行和审计记录都会保留">
                      仅调整对话，不回滚终端
                    </small>
                    <button
                      type="button"
                      className="agent-message-icon-btn"
                      data-action="edit-agent-message"
                      title="修改并重发"
                      aria-label="修改并重发"
                      disabled={Boolean(agentMessageActionPending)}
                      onClick={() => editLatestAgentMessage(message.id, message.content)}
                    >✎</button>
                  </div>
                )
              )}
            </article>
            );
          })}
          <ToolActivityList activities={unmatchedActivities} />
          {activeAgent?.authRequest && (
            <section className="auth-card" data-auth-interaction={activeAgent.authRequest.id}>
              <strong>需要安全认证</strong>
              <p>请直接在当前终端输入凭据并按 Enter。智能体随后会自动继续。首个 Enter 后的同次粘贴内容会被丢弃；凭据不会进入 AI 上下文、会话日志、结构化输出或审计记录。</p>
            </section>
          )}
          {activeAgent?.activeExecution && (
            <section className={`execution-card ${activeAgent.activeExecution.status}`}>
              <strong>{executionStatusLabel(activeAgent.activeExecution.status)}</strong>
              <code>{activeAgent.activeExecution.command}</code>
              {activeAgent.activeExecution.exitCode !== undefined && (
                <span>退出码 {activeAgent.activeExecution.exitCode} · {activeAgent.activeExecution.durationMs ?? 0} 毫秒</span>
              )}
              {activeAgent.state === 'PAUSED'
                && activeAgent.activeExecution.status === 'running'
                && activeAgent.activeExecution.interruptRequestedAt && (
                <button onClick={() => void confirmShellReady(
                  activeAgent.terminalId,
                  activeAgent.activeExecution!.id,
                )} data-action="confirm-shell-ready">已看到 Shell 提示符 · 解除运行跟踪</button>
              )}
            </section>
          )}
            {activeAgent?.error && <div className="agent-error">{activeAgent.error}</div>}
          </div>
          {agentUpdatesBelow && (
            <button
              className="agent-follow-output"
              data-action="follow-agent-output"
              onClick={followLatestAgentOutput}
            >↓ 回到底部 · 查看新输出</button>
          )}
        </div>
        {activeAgent?.pendingApproval?.status === 'waiting' && (
          <section className="approval-card approval-card-pinned" data-testid="pinned-agent-approval">
            <div>
              <strong>{activeAgent.pendingApproval.kind === 'file-operation'
                ? '文件操作审批'
                : '终端命令审批'}</strong>
              <span>{activeAgent.pendingApproval.reason ?? '智能体请求执行操作'}</span>
            </div>
            {activeAgent.pendingApproval.fileOperation ? (
              <div className="approval-file-operation">
                <code>{activeAgent.pendingApproval.fileOperation.toolName}</code>
                <span>{activeAgent.pendingApproval.fileOperation.target}</span>
                {activeAgent.pendingApproval.fileOperation.sensitive && (
                  <p>敏感提示：批准后读取到的内容会发送给当前 AI Provider。</p>
                )}
                {activeAgent.pendingApproval.fileOperation.recursive && (
                  <p>递归删除：本次批准只适用于这里显示的精确操作。</p>
                )}
              </div>
            ) : (
              <textarea
                aria-label="待审批命令"
                value={editedApprovalCommand}
                onChange={(event) => setEditedApprovalCommand(event.target.value)}
                spellCheck={false}
              />
            )}
            <div className="approval-actions">
              <button data-action="reject-command" onClick={() => void resolveAgentApproval('reject')}>拒绝</button>
              {!activeAgent.pendingApproval.fileOperation && (
                <button data-action="edit-command" onClick={() => void resolveAgentApproval('edit')}>编辑并执行</button>
              )}
              <button className="execute" data-action="execute-command" onClick={() => void resolveAgentApproval('execute')}>
                批准本次
              </button>
            </div>
          </section>
        )}
        <form className="composer" onSubmit={(event) => void sendAgentPrompt(event)}>
          {editingAgentMessageId && (
            <div className="composer-editing" role="status">
              <span>正在修改上一条消息；发送后会重新执行，已发生的终端操作不会撤销</span>
              <button
                type="button"
                data-action="cancel-edit-agent-message"
                onClick={() => {
                  setEditingAgentMessageId(null);
                  setEditingAgentTerminalId(null);
                  setAgentPrompt('');
                }}
              >取消</button>
            </div>
          )}
          <textarea
            ref={agentComposerRef}
            aria-label="向 AI 发送消息"
            data-testid="agent-composer"
            placeholder="让智能体检查或操作当前终端…"
            value={agentPrompt}
            onChange={(event) => setAgentPrompt(event.target.value)}
            onKeyDown={handleAgentComposerKeyDown}
            disabled={!selectedAgentBackendReady || !activeTab || activeTab.status !== 'connected' || composerBlocked}
          />
          <div>
            <span title="Enter 发送，Shift+Enter 换行">{selectedAgentBackendReady
              ? activeAgent
                ? `${agentStateLabel(activeAgent.state)} · ${activeReviewMode === 'complete'
                  ? '完全访问'
                  : activeReviewMode === 'risky' ? '风险审核' : '全部审核'}`
                : '已就绪 · 全部审核'
              : selectedAgentBackendStatus}</span>
            <button
              type="submit"
              className={composerBlocked ? 'agent-stop-submit' : ''}
              aria-label={composerBlocked
                ? '停止当前任务'
                : editingAgentMessageId ? '修改并重新发送' : '发送消息'}
              title={composerBlocked ? '停止当前任务；已执行的操作不会回滚' : '发送'}
              disabled={composerBlocked
                ? !latestUserMessage || Boolean(agentMessageActionPending)
                : !agentPrompt.trim() || !selectedAgentBackendReady || !activeTab || Boolean(agentMessageActionPending)}
            >{composerBlocked ? '■' : '↑'}</button>
          </div>
        </form>
      </aside>
      )}

      {viewingSessionHistory && (
        <Suspense fallback={(
          <div className="modal-backdrop">
            <div className="modal compact-modal" role="status">正在打开会话历史…</div>
          </div>
        )}>
          <SessionHistoryDialog
            session={viewingSessionHistory}
            onClose={() => setViewingSessionHistory(null)}
            onDeleted={handleSessionDeleted}
            onError={setWorkspaceActionError}
          />
        </Suspense>
      )}

      {renamingSession && (
        <div className="modal-backdrop" data-testid="rename-session-backdrop">
          <form
            className="modal compact-modal session-rename-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="session-rename-title"
            aria-busy={sessionRenamePending}
            data-testid="rename-session-dialog"
            onSubmit={(event) => void renameSession(event)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              closeSessionRename();
            }}
          >
            <div className="modal-header">
              <strong id="session-rename-title">重命名会话</strong>
              <button
                type="button"
                aria-label="关闭重命名会话"
                data-action="cancel-session-rename"
                disabled={sessionRenamePending}
                onClick={closeSessionRename}
              >×</button>
            </div>
            <label htmlFor="session-rename-input">会话名称</label>
            <input
              id="session-rename-input"
              name="sessionName"
              value={sessionRenameDraft}
              autoFocus
              autoComplete="off"
              aria-invalid={Boolean(sessionRenameError)}
              aria-describedby={sessionRenameError ? 'session-rename-error' : undefined}
              data-testid="rename-session-input"
              onChange={(event) => {
                setSessionRenameDraft(event.target.value);
                if (sessionRenameError) setSessionRenameError(null);
              }}
            />
            {sessionRenameError && (
              <div
                id="session-rename-error"
                className="form-error"
                role="alert"
                data-testid="rename-session-error"
              >{sessionRenameError}</div>
            )}
            <div className="modal-actions">
              <button
                type="button"
                data-action="cancel-session-rename"
                disabled={sessionRenamePending}
                onClick={closeSessionRename}
              >取消</button>
              <button
                className="primary"
                type="submit"
                data-action="confirm-session-rename"
                disabled={sessionRenamePending}
              >{sessionRenamePending ? '正在保存…' : '保存'}</button>
            </div>
          </form>
        </div>
      )}

      {hostFolderDialog && (
        <div className="modal-backdrop">
          <form
            className="modal compact-modal host-folder-modal"
            data-testid="host-folder-dialog"
            onSubmit={(event) => void submitHostFolderDialog(event)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              closeHostFolderDialog();
            }}
          >
            <div className="modal-header">
              <strong>{hostFolderDialog.mode === 'create'
                ? '新建主机文件夹'
                : hostFolderDialog.mode === 'rename'
                  ? '重命名主机文件夹'
                  : '删除主机文件夹'}</strong>
              <button type="button" disabled={hostFolderActionPending} onClick={closeHostFolderDialog}>×</button>
            </div>
            {hostFolderDialog.mode === 'delete' ? (
              <p>确定删除空文件夹“{hostFolderDialog.folder.name}”吗？主机数据不会被删除。</p>
            ) : (
              <label>文件夹名称
                <input
                  autoFocus
                  autoComplete="off"
                  value={hostFolderNameDraft}
                  aria-invalid={Boolean(hostFolderError)}
                  onChange={(event) => {
                    setHostFolderNameDraft(event.target.value);
                    setHostFolderError(null);
                  }}
                />
              </label>
            )}
            {hostFolderError && <div className="form-error" role="alert">{hostFolderError}</div>}
            <div className="modal-actions">
              <button type="button" disabled={hostFolderActionPending} onClick={closeHostFolderDialog}>取消</button>
              <button
                className={hostFolderDialog.mode === 'delete' ? 'danger-action' : 'primary'}
                type="submit"
                disabled={hostFolderActionPending}
              >{hostFolderActionPending
                  ? '正在处理…'
                  : hostFolderDialog.mode === 'delete' ? '删除文件夹' : '保存'}</button>
            </div>
          </form>
        </div>
      )}

      {editingHost !== undefined && (
        <div className="modal-backdrop">
          <form className="modal host-editor-modal" onSubmit={(event) => void saveHost(event)}>
            <div className="modal-header">
              <strong>{editingHost ? '编辑主机' : '添加主机'}</strong>
              <button type="button" onClick={() => setEditingHost(undefined)}>×</button>
            </div>
            <div className="host-protocol-tabs" role="tablist" aria-label="主机协议">
              {HOST_PROTOCOL_OPTIONS.map((option) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={editingHostProtocol === option.protocol}
                  className={editingHostProtocol === option.protocol ? 'active' : ''}
                  data-protocol={option.protocol}
                  key={option.protocol}
                  onClick={() => {
                    setEditingHostProtocol(option.protocol);
                    setConnectionError(null);
                  }}
                >
                  <strong>{option.label}</strong>
                  <small>{option.implemented ? '可用' : '尚未接入'}</small>
                </button>
              ))}
            </div>

            {editingHostProtocol === 'ssh' && (
              <div className="form-grid" role="tabpanel">
                <label className="span-2">显示名称<input name="name" required defaultValue={editingHost?.name ?? 'Ubuntu 测试机'} /></label>
                <label className="span-2">主机名或 IP 地址<input name="hostname" required defaultValue={editingHost?.hostname ?? ''} /></label>
                <label>端口<input name="port" type="number" min="1" max="65535" required defaultValue={editingHost?.port ?? 22} /></label>
                <label>用户名<input name="username" required defaultValue={editingHost?.username ?? ''} /></label>
                <label className="span-2">远程 Shell
                  <select
                    name="shellKind"
                    value={hostFormShellKind}
                    onChange={(event) => setHostFormShellKind(event.target.value as SshShellKind)}
                  >
                    {SSH_SHELL_KIND_OPTIONS.map((option) => (
                      <option value={option.kind} key={option.kind}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="span-2">认证方式
                  <select
                    name="authMethod"
                    value={hostFormAuthMethod}
                    onChange={(event) => setHostFormAuthMethod(event.target.value as SshAuthMethod)}
                  >
                    <option value="password">用户名和密码</option>
                    <option value="keyboard-interactive">键盘交互认证</option>
                    <option value="private-key">私钥</option>
                    <option value="agent">Windows OpenSSH / Pageant 代理</option>
                  </select>
                </label>
                {hostFormAuthMethod === 'private-key' && (
                  <div className="span-2">
                    <label>私钥文件</label>
                    <div className="host-key-path-row">
                      <input
                        name="privateKeyPath"
                        readOnly
                        value={hostFormPrivateKeyPath}
                        placeholder="未选择私钥文件"
                      />
                      <button type="button" onClick={() => void choosePrivateKeyFile()}>选择文件…</button>
                    </div>
                  </div>
                )}
                <label>文件夹
                  <select name="folderId" defaultValue={editingHost?.folderId ?? ''}>
                    <option value="">未分组</option>
                    {orderedHostFolders.map((folder) => (
                      <option value={folder.id} key={folder.id}>{folder.name}</option>
                    ))}
                  </select>
                </label>
                <label className="check-label"><input name="favorite" type="checkbox" defaultChecked={editingHost?.favorite} /> 收藏</label>
              </div>
            )}

            {editingHostProtocol === 'vnc' && (
              <div className="form-grid host-protocol-form" role="tabpanel">
                <label className="span-2">显示名称<input defaultValue="VNC 主机" /></label>
                <label className="span-2">主机名或 IP 地址<input placeholder="192.168.1.10" /></label>
                <label>端口<input type="number" min="1" max="65535" defaultValue={5900} /></label>
                <label>用户名（可选）<input /></label>
              </div>
            )}

            {editingHostProtocol === 'rdp' && (
              <div className="form-grid host-protocol-form" role="tabpanel">
                <label className="span-2">显示名称<input defaultValue="RDP 主机" /></label>
                <label className="span-2">主机名或 IP 地址<input placeholder="192.168.1.20" /></label>
                <label>端口<input type="number" min="1" max="65535" defaultValue={3389} /></label>
                <label>用户名<input /></label>
                <label className="span-2">域（可选）<input /></label>
              </div>
            )}

            {editingHostProtocol === 'serial' && (
              <div className="form-grid host-protocol-form" role="tabpanel">
                <label className="span-2">显示名称<input defaultValue="串口终端" /></label>
                <label className="span-2">设备路径<input placeholder="COM3" /></label>
                <label>波特率
                  <select defaultValue="115200">
                    <option value="9600">9600</option>
                    <option value="57600">57600</option>
                    <option value="115200">115200</option>
                  </select>
                </label>
                <label>数据位<select defaultValue="8"><option>8</option><option>7</option><option>6</option><option>5</option></select></label>
                <label>停止位<select defaultValue="1"><option>1</option><option>1.5</option><option>2</option></select></label>
                <label>校验<select defaultValue="none"><option value="none">无</option><option value="even">偶校验</option><option value="odd">奇校验</option></select></label>
                <label className="span-2">流控制<select defaultValue="none"><option value="none">无</option><option value="hardware">硬件</option><option value="software">软件</option></select></label>
              </div>
            )}

            {editingHostProtocol !== 'ssh' && (
              <div className="host-protocol-unavailable" role="status">
                <strong>{HOST_PROTOCOL_OPTIONS.find((option) => option.protocol === editingHostProtocol)?.label} 尚未接入</strong>
                <span>{HOST_PROTOCOL_OPTIONS.find((option) => option.protocol === editingHostProtocol)?.description}。当前仅展示配置字段，不会保存或发起虚假连接。</span>
              </div>
            )}
            {connectionError && <div className="form-error">{connectionError}</div>}
            <div className="modal-actions">
              <button type="button" onClick={() => setEditingHost(undefined)}>取消</button>
              <button className="primary" type="submit" disabled={editingHostProtocol !== 'ssh'}>
                {editingHostProtocol === 'ssh' ? '保存主机' : '尚未接入'}
              </button>
            </div>
          </form>
        </div>
      )}

      {connectingHost && (
        <div className="modal-backdrop">
          <form
            key={`${connectingHost.id}:${connectingHost.credentialConfigured}`}
            className="modal compact-modal"
            data-testid="ssh-connect-dialog"
            onSubmit={submitConnection}
          >
            <div className="modal-header">
              <strong>连接到 {connectingHost.name}</strong>
              <button type="button" onClick={() => {
                setConnectingHost(null);
                setReconnectingSessionId(null);
              }} disabled={sshConnectionPending}>×</button>
            </div>
            <div className="connection-summary">{connectingHost.username}@{connectingHost.hostname}:{connectingHost.port}</div>
            {(connectingHost.authMethod === 'password' || connectingHost.authMethod === 'keyboard-interactive') && (
              <label>密码<input
                name="password"
                type="password"
                required={!connectingHost.credentialConfigured}
                placeholder={connectingHost.credentialConfigured ? '留空使用已保存密码' : '请输入 SSH 密码'}
                autoFocus
                autoComplete="off"
              /></label>
            )}
            {connectingHost.authMethod === 'private-key' && (
              <label>私钥口令<input
                name="passphrase"
                type="password"
                placeholder={connectingHost.credentialConfigured ? '留空使用已保存口令' : '私钥没有口令时可留空'}
                autoFocus
                autoComplete="off"
              /></label>
            )}
            {connectingHost.authMethod !== 'agent' && (
              <>
                <label className="credential-save-check">
                  <input
                    name="saveCredential"
                    type="checkbox"
                    defaultChecked={connectingHost.credentialConfigured}
                  />
                  <span>连接成功后保存或更新此凭据</span>
                </label>
                <p className="secure-note">
                  {connectingHost.credentialConfigured
                    ? '已保存的凭据只由主进程从本机密钥库读取；密码框可留空。'
                    : '勾选后仅保存到本机密钥库，不写入主机、会话、终端或审计日志。'}
                </p>
                {connectingHost.credentialConfigured && (
                  <button
                    className="credential-forget-button"
                    type="button"
                    data-action="forget-host-credential"
                    disabled={credentialActionPending || sshConnectionPending}
                    onClick={() => void forgetHostCredential(connectingHost)}
                  >{credentialActionPending ? '正在删除…' : '删除已保存凭据'}</button>
                )}
              </>
            )}
            {connectionError && <div className="form-error">{connectionError}</div>}
            <div className="modal-actions">
              <button type="button" onClick={() => {
                setConnectingHost(null);
                setReconnectingSessionId(null);
              }} disabled={sshConnectionPending}>取消</button>
              <button className="primary" type="submit" disabled={sshConnectionPending}>
                {sshConnectionPending ? '正在连接…' : '连接'}
              </button>
            </div>
          </form>
        </div>
      )}

      {hostBackupExportOpen && (
        <div className="modal-backdrop" data-testid="host-backup-export-dialog">
          <div className="modal compact-modal host-backup-modal">
            <div className="modal-header"><strong>导出 SSH 主机配置</strong></div>
            <p>默认只导出主机元数据，不包含密码或私钥口令。</p>
            <label className="credential-save-check">
              <input
                type="checkbox"
                checked={hostBackupIncludeCredentials}
                onChange={(event) => {
                  setHostBackupIncludeCredentials(event.target.checked);
                  if (!event.target.checked) {
                    setHostBackupPassphrase('');
                    setHostBackupPassphraseConfirmation('');
                  }
                }}
              />
              <span>包含 SSH 凭据（必须整包加密）</span>
            </label>
            {hostBackupIncludeCredentials && (
              <>
                <label>
                  <span>备份口令</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={hostBackupPassphrase}
                    onChange={(event) => setHostBackupPassphrase(event.target.value)}
                  />
                </label>
                <label>
                  <span>再次输入口令</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={hostBackupPassphraseConfirmation}
                    onChange={(event) => setHostBackupPassphraseConfirmation(event.target.value)}
                  />
                </label>
                <p className="risk-note">口令不会保存；遗失后无法恢复加密备份。</p>
              </>
            )}
            <div className="modal-actions">
              <button
                type="button"
                disabled={hostBackupPending}
                onClick={() => setHostBackupExportOpen(false)}
              >取消</button>
              <button
                type="button"
                className="primary"
                disabled={hostBackupPending}
                onClick={() => void exportHosts()}
              >{hostBackupPending ? '正在导出…' : '选择保存位置…'}</button>
            </div>
          </div>
        </div>
      )}

      {hostBackupImportChallenge && (
        <div className="modal-backdrop" data-testid="host-backup-import-challenge">
          <div className="modal compact-modal host-backup-modal">
            <div className="modal-header"><strong>{
              hostBackupImportChallenge.challenge === 'passphrase-required'
                ? '解密主机备份'
                : '旧版明文主机备份风险确认'
            }</strong></div>
            <p>{hostBackupImportChallenge.message}</p>
            {hostBackupImportChallenge.challenge === 'passphrase-required' && (
              <label>
                <span>备份口令</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  autoFocus
                  value={hostBackupImportPassphrase}
                  onChange={(event) => setHostBackupImportPassphrase(event.target.value)}
                />
              </label>
            )}
            <div className="modal-actions">
              <button
                type="button"
                disabled={hostBackupPending}
                onClick={() => {
                  setHostBackupImportChallenge(null);
                  setHostBackupImportPassphrase('');
                }}
              >取消</button>
              <button
                type="button"
                className="danger-action"
                disabled={
                  hostBackupPending
                  || (
                    hostBackupImportChallenge.challenge === 'passphrase-required'
                    && !hostBackupImportPassphrase
                  )
                }
                onClick={() => void continueHostImport()}
              >{hostBackupImportChallenge.challenge === 'passphrase-required'
                  ? '解密并导入'
                  : '确认风险并导入'}</button>
            </div>
          </div>
        </div>
      )}

      {activeAgent?.pendingTakeover && (
        <div className="modal-backdrop">
          <div
            className="modal compact-modal takeover-modal"
            data-terminal-id={activeAgent.terminalId}
            data-takeover-id={activeAgent.pendingTakeover.id}
            data-execution-id={activeAgent.pendingTakeover.executionId}
          >
            <div className="modal-header"><strong>人工接管终端</strong></div>
            <p>{activeAgent.pendingTakeover.reason === 'command-inactivity'
              ? '前台命令已连续 5 分钟没有输出。智能体已暂停，终端仍保持连接。请选择如何处理该命令。'
              : '智能体已暂停。请选择如何处理仍在前台运行的命令。'}</p>
            <code>{activeAgent.activeExecution?.command ?? '前台命令'}</code>
            <div className="modal-actions split-actions">
              <button data-action="keep-process" onClick={() => void resolveAgentTakeover('keep')}>保持进程运行</button>
              <button className="danger-action" data-action="interrupt-process" onClick={() => void resolveAgentTakeover('interrupt')}>发送 Ctrl+C</button>
            </div>
          </div>
        </div>
      )}

      {completeAccessChallenge && (
        <div className="modal-backdrop">
          <div
            className="modal compact-modal complete-access-modal"
            data-terminal-id={completeAccessChallenge.terminalId}
          >
            <div className="modal-header"><strong>启用“完全访问”？</strong></div>
            <p>
              目标：<b>{completeAccessChallenge.target}</b>。智能体可使用当前本机用户或 SSH/SFTP 用户拥有的全部命令与文件权限，不再逐条询问。
            </p>
            <p className="risk-note" data-testid="complete-access-scope-note">
              本次确认只对当前终端运行时生效；新建、重连或重启后的终端默认回到“全部审核”。
            </p>
            <p className="risk-note" data-testid="complete-access-file-policy-note">
              Workspace 只是工作范围提示，不是权限边界。文件工具可访问账号有权访问的路径，但无法越过操作系统权限，也不会自动获得管理员密码、root、OTP 或密钥。
            </p>
            <p className="risk-note">
              递归删除、磁盘、账号、服务、网络下载执行等高风险操作也会自动执行。遇到交互式凭据提示时仍会暂停，由你在终端安全输入。
            </p>
            <div className="modal-actions">
              <button autoFocus onClick={() => setCompleteAccessChallenge(null)}>取消</button>
              <button
                className="danger-action"
                data-action="confirm-complete-access"
                onClick={() => void setAgentReviewMode(
                  'complete',
                  true,
                  completeAccessChallenge.terminalId,
                  completeAccessChallenge.backend,
                )}
              >启用完全访问</button>
            </div>
          </div>
        </div>
      )}

      {trustChallenge && (
        <div className="modal-backdrop">
          <div className="modal compact-modal">
            <div className="modal-header"><strong>信任此主机的 SSH 密钥？</strong></div>
            <p>这是首次连接到 {trustChallenge.host.hostname}。继续前请核对服务器指纹。</p>
            <code className="fingerprint">{trustChallenge.fingerprint}</code>
            <div className="modal-actions">
              <button onClick={() => {
                setTrustChallenge(null);
                setReconnectingSessionId(null);
              }} disabled={sshConnectionPending}>取消</button>
              <button className="primary" disabled={sshConnectionPending} onClick={() => void establishSsh(
                trustChallenge.host,
                trustChallenge.secret,
                trustChallenge.fingerprint,
                trustChallenge.sessionId,
              )}>{sshConnectionPending ? '正在连接…' : '信任并连接'}</button>
            </div>
            {connectionError && <div className="form-error" role="alert">{connectionError}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
