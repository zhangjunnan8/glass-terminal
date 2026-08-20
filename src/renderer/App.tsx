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
  CODEX_APP_SERVER_AGENT_BACKEND,
  CODEX_APP_SERVER_AGENT_POLICY_VERSION,
} from '../shared/agent';
import {
  containsObviousAgentSecret,
  type AgentMemoryCategory,
} from '../shared/agent-memory';
import type {
  AgentAssistantDelta,
  AgentBackendRef,
  AgentFileAccessMode,
  AgentRuntimeState,
  AgentSessionView,
} from '../shared/agent';
import type { CodexAppServerSnapshot } from '../shared/codex-app-server';
import type { ShellProfile, TerminalDescriptor } from '../shared/terminal';
import { mergeAgentAssistantDelta, mergeAgentState } from './agent-state';
import { TerminalPane } from './components/TerminalPane';
import { SftpDrawer } from './components/SftpDrawer';
import { AgentActivityCard } from './components/AgentActivityCard';
import { AgentContextMeter } from './components/AgentContextMeter';
import {
  AgentMemoryPanel,
  type AgentMemoryDraftSource,
} from './components/AgentMemoryPanel';
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
  codexNativeAgentAvailabilityLabel,
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

interface CodexUiMessage {
  tone: 'success' | 'error';
  text: string;
}

interface HostCredentialMessage extends CodexUiMessage {
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

interface FullTakeoverChallenge {
  terminalId: string;
  target: string;
  backend: AgentBackendRef;
  approvalId?: string;
  command?: string;
  editedCommand?: string;
  hostPreference: boolean;
}

interface FileAccessChallenge {
  terminalId: string;
  target: string;
  root: string;
  mode: Extract<AgentFileAccessMode, 'read-write' | 'full-access'>;
  backend: Extract<AgentBackendRef, { kind: 'generic-provider' }>;
}

type AgentBackendKind = AgentBackendRef['kind'];
type SidebarView = 'terminals' | 'hosts' | 'history';

function isBackupImportChallenge(
  response: BackupImportResponse,
): response is BackupImportChallenge {
  return 'challenge' in response;
}

const CODEX_AGENT_BACKEND: AgentBackendRef = {
  kind: CODEX_APP_SERVER_AGENT_BACKEND,
  policyVersion: CODEX_APP_SERVER_AGENT_POLICY_VERSION,
};

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

function agentBackendActivityLabel(
  backend: AgentBackendRef,
  providers: ProviderProfile[],
): string {
  if (backend.kind === CODEX_APP_SERVER_AGENT_BACKEND) return 'Codex App Server';
  return providers.find((provider) => provider.id === backend.providerId)?.name
    ?? '默认 Provider';
}

function mergeCodexAppServerState(
  current: CodexAppServerSnapshot | null,
  incoming: CodexAppServerSnapshot,
): CodexAppServerSnapshot {
  return current && current.revision >= incoming.revision ? current : incoming;
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
  const [codexAppServer, setCodexAppServer] = useState<CodexAppServerSnapshot | null>(null);
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
  const [agentBackendChoices, setAgentBackendChoices] = useState<Record<string, AgentBackendKind>>({});
  const [agentUpdatesBelow, setAgentUpdatesBelow] = useState(false);
  const [agentPanelVisible, setAgentPanelVisible] = useState(true);
  const [agentControlsExpanded, setAgentControlsExpanded] = useState(true);
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
  const [fullTakeoverChallenge, setFullTakeoverChallenge] = useState<FullTakeoverChallenge | null>(null);
  const [fileAccessChallenge, setFileAccessChallenge] = useState<FileAccessChallenge | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [workspaceActionError, setWorkspaceActionError] = useState<string | null>(null);
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
    void window.aiTerminal.codexAppServer.getState().then((state) => {
      setCodexAppServer((current) => mergeCodexAppServerState(current, state));
    }).catch((error) => {
      setStartupError(errorMessage(error));
    });
    const removeAgentListener = window.aiTerminal.agent.onStateChanged((state) => {
      installAgentSnapshot(state);
      setTabs((current) => current.map((tab) => (
        tab.id === state.terminalId ? { ...tab, sessionId: state.sessionId } : tab
      )));
    });
    const removeAgentDeltaListener = window.aiTerminal.agent.onAssistantDelta((event) => {
      queueAgentAssistantDelta(event);
    });
    const removeCodexAppServerListener = window.aiTerminal.codexAppServer.onStateChanged((state) => {
      setCodexAppServer((current) => mergeCodexAppServerState(current, state));
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
      removeCodexAppServerListener();
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
  const activeFullTakeoverPreference = activeAgent?.fullTakeoverPreference
    ?? activeHost?.fullTakeoverPreference
    ?? false;
  const activeMessages = activeAgent?.messages ?? [];
  const activeActivities = activeAgent?.activities ?? [];
  const activeMessageIds = new Set(activeMessages.map((message) => message.id));
  const unmatchedActivities = activeActivities.filter((activity) => (
    !activity.turnId || !activeMessageIds.has(activity.turnId)
  ));
  const latestUserMessage = activeAgent
    ? [...activeAgent.messages].reverse().find((message) => message.role === 'user')
    : undefined;
  const explicitAgentBackendKind = activeTab
    ? agentBackendChoices[activeTab.id]
    : undefined;
  const selectedAgentBackendKind = explicitAgentBackendKind
    ?? activeAgent?.backend.kind
    ?? 'generic-provider';
  const selectedGenericProvider = defaultProvider;
  const selectedAgentBackend: AgentBackendRef | undefined = selectedAgentBackendKind
    === CODEX_APP_SERVER_AGENT_BACKEND
    ? CODEX_AGENT_BACKEND
    : selectedGenericProvider
      ? { kind: 'generic-provider', providerId: selectedGenericProvider.id }
      : undefined;
  const codexAgentAvailable = codexAppServer?.agentAvailable === true;
  const codexTerminalContextAccess = codexAppServer?.terminalContextAccess;
  const codexBackendSelected = selectedAgentBackendKind === CODEX_APP_SERVER_AGENT_BACKEND;
  const activeRuntimeFileAccessMode: AgentFileAccessMode = activeAgent?.fileAccessMode ?? 'off';
  const activeGenericProviderId = activeAgent?.backend.kind === 'generic-provider'
    ? activeAgent.backend.providerId
    : undefined;
  const selectedGenericBackendMatchesActive = Boolean(
    selectedAgentBackend?.kind === 'generic-provider'
    && activeGenericProviderId
    && selectedAgentBackend.providerId === activeGenericProviderId,
  );
  const selectedFileAccessMode: AgentFileAccessMode = !codexBackendSelected
    && selectedGenericBackendMatchesActive
    ? activeRuntimeFileAccessMode
    : 'off';
  const activeFileAccessProviderLabel = activeGenericProviderId
    ? providers.find((provider) => provider.id === activeGenericProviderId)?.name
      ?? activeGenericProviderId
    : null;
  const activeWorkspaceRoot = activeSession?.workspace?.root;
  const selectedAgentBackendReady = selectedAgentBackendKind
    === CODEX_APP_SERVER_AGENT_BACKEND
    ? codexAgentAvailable
    : selectedGenericProvider?.status === 'ready';
  const activeGenericFileAccessNeedsSeparateRevoke = Boolean(
    activeAgent?.backend.kind === 'generic-provider'
    && activeAgent.fileAccessMode !== 'off'
    && (!selectedGenericBackendMatchesActive || !selectedAgentBackendReady)
  );
  const selectedAgentBackendStatus = selectedAgentBackendKind
    === CODEX_APP_SERVER_AGENT_BACKEND
    ? codexAppServer
      ? `${codexNativeAgentAvailabilityLabel(codexAppServer.agentAvailable)} · ${codexAppServer.agentReason}`
      : '正在读取 Codex App Server 状态。'
    : selectedGenericProvider
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
    || foregroundRunning
    || Boolean(activeAgent?.backendTurnDraining);
  const workspaceChangeDisabledReason = !activeTab
    ? '请先选择终端'
    : activeTab.status !== 'connected'
      ? '终端已断开，不能修改工作区'
      : activeRuntimeFileAccessMode !== 'off'
        ? '请先关闭 AI 文件访问，再修改工作区'
        : composerBlocked
          ? 'AI 正在运行，暂时不能修改工作区'
          : null;
  const fileAccessChallengeIsCurrent = Boolean(
    fileAccessChallenge
    && activeTab?.id === fileAccessChallenge.terminalId
    && activeTab.status === 'connected'
    && !composerBlocked
    && selectedAgentBackendReady
    && selectedAgentBackend?.kind === 'generic-provider'
    && selectedAgentBackend.providerId === fileAccessChallenge.backend.providerId
    && activeWorkspaceRoot === fileAccessChallenge.root
    && (fileAccessChallenge.mode === 'full-access'
      ? selectedFileAccessMode !== 'full-access'
      : selectedFileAccessMode !== 'read-write'
        && selectedFileAccessMode !== 'full-access'),
  );

  useEffect(() => {
    if (!fileAccessChallenge || fileAccessChallengeIsCurrent) return;
    setFileAccessChallenge(null);
    setWorkspaceActionError('文件访问授权目标已变化，请重新选择权限。');
  }, [fileAccessChallenge, fileAccessChallengeIsCurrent]);

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

  async function refreshProviders() {
    setProviders(await window.aiTerminal.providers.list());
  }

  function openAgentBackendSettings() {
    void window.aiTerminal.settingsWindow.open();
  }

  async function sendAgentPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
        // The append-only retract may have succeeded before starting the
        // replacement turn failed. Refresh once so a retry becomes a normal
        // send instead of targeting a message that no longer exists.
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

  async function retractLatestAgentMessage(messageId: string, content: string) {
    if (!activeTab || agentMessageActionPending) return;
    const requestTerminalId = activeTab.id;
    setWorkspaceActionError(null);
    setAgentMessageActionPending(messageId);
    try {
      const state = await window.aiTerminal.agent.revisePrompt({
        terminalId: requestTerminalId,
        messageId,
        action: 'retract',
      });
      installAgentSnapshot(state);
      if (activeIdRef.current === requestTerminalId) {
        setEditingAgentMessageId(null);
        setEditingAgentTerminalId(null);
        setAgentPrompt(content);
        requestAnimationFrame(() => agentComposerRef.current?.focus());
      }
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

  async function setFullTakeover(
    enabled: boolean,
    terminalId = activeTab?.id,
    approvalId?: string,
    editedCommand?: string,
    backend: AgentBackendRef | undefined = activeAgent?.backend ?? selectedAgentBackend,
  ) {
    if (!terminalId || !backend) return;
    setWorkspaceActionError(null);
    try {
      const state = await window.aiTerminal.agent.setFullTakeover({
        terminalId,
        enabled,
        backend,
        approvalId,
        editedCommand,
      });
      installAgentSnapshot(state);
      setTabs((current) => current.map((tab) => (
        tab.id === terminalId ? { ...tab, sessionId: state.sessionId } : tab
      )));
      setFullTakeoverChallenge(null);
      await refreshSessions();
    } catch (error) {
      setWorkspaceActionError(errorMessage(error));
    }
  }

  async function setFullTakeoverPreference(enabled: boolean): Promise<void> {
    if (!activeTab) return;
    setWorkspaceActionError(null);
    try {
      const state = await window.aiTerminal.agent.setFullTakeoverPreference({
        terminalId: activeTab.id,
        enabled,
      });
      if (state) installAgentSnapshot(state);
      await refreshHosts();
    } catch (error) {
      setWorkspaceActionError(errorMessage(error));
    }
  }

  async function setAgentFileAccess(
    mode: AgentFileAccessMode,
    terminalId = activeTab?.id,
    backend = selectedAgentBackend,
    fullAccessConfirmed = false,
    expectedWorkspaceRoot?: string,
  ) {
    if (!terminalId || !backend || backend.kind !== 'generic-provider') return;
    setWorkspaceActionError(null);
    if (
      expectedWorkspaceRoot !== undefined
      && (
        activeTab?.id !== terminalId
        || activeTab.status !== 'connected'
        || selectedAgentBackend?.kind !== 'generic-provider'
        || selectedAgentBackend.providerId !== backend.providerId
        || activeWorkspaceRoot !== expectedWorkspaceRoot
      )
    ) {
      setWorkspaceActionError('文件访问授权目标已变化，请重新选择权限。');
      return;
    }
    if (mode !== 'off') {
      const session = sessions.find((candidate) => (
        candidate.runtimeTerminalId === terminalId
        || candidate.id === tabs.find((tab) => tab.id === terminalId)?.sessionId
      ));
      if (!session?.workspace?.root) {
        setWorkspaceActionError('请先为当前终端设置 Workspace Root，再开启 AI 文件访问。');
        return;
      }
      if (
        expectedWorkspaceRoot !== undefined
        && session.workspace.root !== expectedWorkspaceRoot
      ) {
        setWorkspaceActionError('Workspace Root 已变化，请重新选择文件访问权限。');
        return;
      }
    }
    try {
      const state = await window.aiTerminal.agent.setFileAccess({
        terminalId,
        mode,
        backend,
        ...(mode === 'full-access' ? { fullAccessConfirmed } : {}),
        ...(expectedWorkspaceRoot !== undefined ? { expectedWorkspaceRoot } : {}),
      });
      installAgentSnapshot(state);
      setTabs((current) => current.map((tab) => (
        tab.id === terminalId ? { ...tab, sessionId: state.sessionId } : tab
      )));
      await refreshSessions();
    } catch (error) {
      setWorkspaceActionError(errorMessage(error));
    }
  }

  async function requestAgentTakeover() {
    if (!activeTab) return;
    setWorkspaceActionError(null);
    try {
      const state = await window.aiTerminal.agent.takeover({ terminalId: activeTab.id });
      installAgentSnapshot(state);
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
    if (host.credentialConfigured || host.authMethod === 'agent') {
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
      if (host.credentialConfigured && !secret.password && !secret.passphrase) {
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
              <strong>{host.name}</strong>
              <span>{authMethodLabel(host.authMethod)} · {host.hostKeyFingerprint ? '已信任' : '未验证'}</span>
              <div className="host-card-actions">
                <button
                  data-action="connect-host"
                  disabled={sshConnectionPending}
                  onClick={() => openSshConnection(host)}
                >{sshConnectionPending ? '正在连接…' : '连接'}</button>
                <button
                  className="icon-btn"
                  title="编辑主机"
                  aria-label="编辑主机"
                  onClick={() => openHostEditor(host)}
                >✎</button>
                <button
                  className="icon-btn danger"
                  title="删除主机"
                  aria-label="删除主机"
                  onClick={() => void removeHost(host)}
                >🗑</button>
              </div>
              {host.authMethod !== 'agent' && (
                <div className="host-credential-row">
                  <small title="凭据保存在本机密钥库中">
                    {host.credentialConfigured ? '凭据已保存' : '凭据未保存'}
                  </small>
                  {host.credentialConfigured && (
                    <button
                      className="icon-btn"
                      type="button"
                      title="删除已保存凭据"
                      aria-label="删除已保存凭据"
                      data-action="forget-host-credential"
                      disabled={credentialActionPending}
                      onClick={() => void forgetHostCredential(host)}
                    >{credentialActionPending ? '…' : '🗝'}</button>
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
                          className="icon-btn"
                          type="button"
                          title="查看历史"
                          aria-label="查看历史"
                          data-action="view-session-history"
                          data-session-id={session.id}
                          onClick={() => openSessionHistory(session)}
                        >▤</button>
                        <button
                          className="icon-btn"
                          type="button"
                          title="重命名会话"
                          aria-label="重命名会话"
                          data-action="rename-session"
                          data-session-id={session.id}
                          onClick={() => openSessionRename(session)}
                        >✎</button>
                        <button
                          className="icon-btn"
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
                        >{liveTab ? '↗' : '↻'}</button>
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
      className={`app-shell ${agentPanelVisible ? '' : 'agent-panel-hidden'}`}
      data-locale={appSettings?.language ?? 'zh-CN'}
      data-theme={uiTheme}
      data-agent-panel-visible={agentPanelVisible ? 'true' : 'false'}
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
        <button className="activity" title="AI 服务设置" data-action="open-provider-settings" onClick={() => {
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
                  <button data-action="create-host-folder" onClick={() => openHostFolderDialog('create')}>新建文件夹</button>
                  <button onClick={() => openHostEditor(null)}>添加</button>
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
              {filteredSessions.map((session) => {
                const host = session.hostId
                  ? hosts.find((candidate) => candidate.id === session.hostId)
                  : undefined;
                const runtimeTab = tabs.find((tab) => (
                  tab.status === 'connected'
                  && (tab.sessionId === session.id || tab.id === session.runtimeTerminalId)
                ));
                return (
                  <article className="history-sidebar-row" key={session.id}>
                    <button
                      className="history-session-main"
                      data-action="view-session-history"
                      data-session-id={session.id}
                      onClick={() => openSessionHistory(session)}
                    >
                      <strong>{session.name}</strong>
                      <small>{host?.name ?? (session.transport === 'ssh' ? '主机' : '本地 Shell')}</small>
                      <small>{sessionStatusLabel(session.status)} · {new Date(session.updatedAt).toLocaleString('zh-CN')}</small>
                    </button>
                    <div className="history-session-actions">
                      <button onClick={() => openSessionHistory(session)}>查看内容</button>
                      <button onClick={() => openSessionRename(session)}>重命名</button>
                      {host && (
                        <button
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
            activeAgent?.fullTakeover ? 'full-takeover' : '',
          ].filter(Boolean).join(' ')}
          data-agent-state={activeAgent?.state ?? 'USER_CONTROL'}
          data-input-mode={activeInputMode}
          data-full-takeover={activeAgent?.fullTakeover ? 'true' : 'false'}
        >
          <div className="terminal-toolbar">
            <span>
              {activeAgent ? agentStateLabel(activeAgent.state) : '用户控制'}
              {activeAgent?.fullTakeover ? ' · AI 全接管' : ''}
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
        {!agentPanelVisible && (
          <button
            className="show-agent-panel"
            data-action="show-agent-panel"
            onClick={() => setAgentPanelVisible(true)}
          >显示 AI</button>
        )}
      </main>

      {agentPanelVisible && (
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
                >⚙</button>
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
              <label className="agent-backend-picker">
                <span>当前智能体后端</span>
                <select
                  aria-describedby="agent-backend-status"
                  data-testid="agent-backend-select"
                  data-backend-kind={selectedAgentBackendKind}
                  value={selectedAgentBackendKind}
                  disabled={!activeTab || composerBlocked || activeAgent?.fullTakeover}
                  onChange={(event) => {
                    if (!activeTab) return;
                    const kind = event.target.value as AgentBackendKind;
                    setAgentBackendChoices((current) => ({
                      ...current,
                      [activeTab.id]: kind,
                    }));
                  }}
                >
                  <option value="generic-provider">
                    默认 Provider{defaultProvider ? ` · ${defaultProvider.name}` : '（未配置）'}
                  </option>
                  <option value={CODEX_APP_SERVER_AGENT_BACKEND}>
                    Codex App Server · 原生模式
                  </option>
                </select>
              </label>
            )}
            <span
              id="agent-backend-status"
              className={`agent-backend-status ${selectedAgentBackendReady ? 'ready' : 'unavailable'}`}
              data-testid="agent-backend-status"
              role="status"
            >{selectedAgentBackendStatus}</span>
          </div>
          {agentControlsExpanded && !codexBackendSelected && (
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
              <label
                className="agent-file-access-picker"
                title={activeWorkspaceRoot
                  ? '开启后，读取到的文件内容会发送给当前 Generic Provider；权限仅在本次应用运行中有效。'
                  : '请先为当前终端设置 Workspace Root，再开启 AI 文件访问。'}
              >
                <span>文件访问</span>
                <select
                  aria-label="Generic Provider 文件访问权限"
                  data-testid="agent-file-access-mode"
                  value={selectedFileAccessMode}
                  disabled={
                    !activeTab
                    || activeTab.status !== 'connected'
                    || composerBlocked
                    || !selectedAgentBackendReady
                    || (!activeWorkspaceRoot && activeRuntimeFileAccessMode === 'off')
                  }
                  onChange={(event) => {
                    const mode = event.target.value as AgentFileAccessMode;
                    const workspaceRoot = activeWorkspaceRoot;
                    if (mode !== 'off' && !workspaceRoot) {
                      setWorkspaceActionError(
                        '请先为当前终端设置 Workspace Root，再开启 AI 文件访问。',
                      );
                      return;
                    }
                    const requiresWriteConfirmation = mode === 'read-write'
                      && selectedFileAccessMode !== 'read-write'
                      && selectedFileAccessMode !== 'full-access';
                    const requiresFullAccessConfirmation = mode === 'full-access'
                      && selectedFileAccessMode !== 'full-access';
                    if (
                      (requiresWriteConfirmation || requiresFullAccessConfirmation)
                      && activeTab
                      && workspaceRoot
                      && selectedAgentBackend?.kind === 'generic-provider'
                    ) {
                      setFileAccessChallenge({
                        terminalId: activeTab.id,
                        target: activeTab.title,
                        root: workspaceRoot,
                        mode,
                        backend: selectedAgentBackend,
                      });
                      return;
                    }
                    void setAgentFileAccess(mode);
                  }}
                >
                  <option value="off">关闭</option>
                  <option value="read-only">只读绑定根</option>
                  <option value="read-write">读写绑定根</option>
                  <option value="full-access">FULL FILESYSTEM ACCESS</option>
                </select>
              </label>
              {activeGenericFileAccessNeedsSeparateRevoke
                && activeAgent?.backend.kind === 'generic-provider' && (
                <div className="agent-file-access-detached" data-testid="detached-file-access-grant">
                  <span>
                    当前文件授权属于 {activeFileAccessProviderLabel}，并未授予当前所选 Provider。
                  </span>
                  <button
                    type="button"
                    data-action="disable-active-file-access"
                    disabled={composerBlocked}
                    onClick={() => void setAgentFileAccess(
                      'off',
                      activeTab?.id,
                      activeAgent.backend,
                    )}
                  >关闭现有授权</button>
                </div>
              )}
              {!activeWorkspaceRoot && activeRuntimeFileAccessMode === 'off' && (
                <span className="agent-file-access-root" data-testid="agent-workspace-required">
                  请先设置 Workspace Root
                </span>
              )}
              {selectedFileAccessMode !== 'off' && activeWorkspaceRoot && (
                <span className="agent-file-access-root" title={activeWorkspaceRoot}>
                  绑定根：{activeWorkspaceRoot}
                </span>
              )}
              {activeAgent?.fullTakeover && <span className="takeover-badge">AI 全接管</span>}
              {activeFullTakeoverPreference && (
                <span
                  className="takeover-preference"
                  data-testid="full-takeover-host-preference"
                  title="这是主机偏好，不会自动授权新的终端。"
                >主机偏好：全接管</span>
              )}
              {activeFullTakeoverPreference && (
                <button
                  type="button"
                  data-action="forget-full-takeover-preference"
                  onClick={() => void setFullTakeoverPreference(false)}
                >忘记偏好</button>
              )}
              <button
                className="take-control"
                data-action="take-control"
                disabled={!agentTurnBusy(activeAgent?.state) || activeAgent?.state === 'TAKEOVER_PENDING'}
                onClick={() => void requestAgentTakeover()}
              >人工接管</button>
              <button
                className={activeAgent?.fullTakeover ? 'full-takeover-enabled' : ''}
                disabled={
                  !activeTab
                  || agentTurnBusy(activeAgent?.state)
                  || (!activeAgent?.fullTakeover
                    && (!selectedAgentBackend || !selectedAgentBackendReady))
                }
                onClick={() => {
                  if (!activeTab) return;
                  if (activeAgent?.fullTakeover) {
                    void setFullTakeover(
                      false,
                      activeTab.id,
                      undefined,
                      undefined,
                      activeAgent.backend,
                    );
                  } else if (selectedAgentBackend) {
                    setFullTakeoverChallenge({
                      terminalId: activeTab.id,
                      target: activeTab.title,
                      backend: selectedAgentBackend,
                      hostPreference: activeFullTakeoverPreference,
                    });
                  }
                }}
              >{activeAgent?.fullTakeover
                  ? '关闭当前终端全接管'
                  : activeFullTakeoverPreference
                    ? '为本次终端启用'
                    : 'AI 全接管'}</button>
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
          {selectedAgentBackendKind === CODEX_APP_SERVER_AGENT_BACKEND && (
            <section
              className={`agent-backend-notice ${codexAgentAvailable ? 'ready' : 'unavailable'}`}
              data-testid="agent-codex-boundary"
              data-agent-available={codexAgentAvailable ? 'true' : 'false'}
            >
              <strong>Codex App Server · 原生模式</strong>
              <p>{codexAgentAvailable
                ? `Codex 的内建 Shell/File 在应用独立工作区内执行，不与当前 SSH/本地 Shell 共用。每轮都会告诉它当前终端的类型、目标、目录和用户。${codexTerminalContextAccess?.enabled
                  ? '已额外允许它只读刷新状态并获取近期内容。'
                  : '当前未允许它刷新状态或读取终端内容。'}当前终端始终由你控制。`
                : selectedAgentBackendStatus}</p>
              <button data-action="open-codex-agent-settings" onClick={openAgentBackendSettings}>
                打开 App Server 设置
              </button>
            </section>
          )}
          {!activeAgent?.messages.length && !activeAgent?.activities?.length && (
            <div className="agent-empty">
              <div className="agent-glyph">✦</div>
              <strong>理解终端上下文的 AI 助手</strong>
              <p>{codexBackendSelected
                ? 'Codex 使用应用独立工作区完成任务；它会知道当前终端的身份，开启读取权限后还能获取近期文本。'
                : '智能体会读取当前会话，并在向这个可见终端发送每条命令前请求你的批准。'}</p>
              <div className="guardrail"><span>✓</span> {codexBackendSelected
                ? '当前终端始终由你控制'
                : '默认逐条审批命令'}</div>
              <button
                className="provider-configure"
                data-action="open-agent-provider-settings"
                data-testid="open-agent-backend-settings"
                onClick={openAgentBackendSettings}
              >
                管理智能体后端
              </button>
            </div>
          )}
          {activeAgent?.messages.map((message, index) => {
            const latestUser = message.role === 'user' && message.id === latestUserMessage?.id;
            const latestUserRunning = latestUser && (
              agentTurnBusy(activeAgent.state)
              || Boolean(activeAgent.backendTurnDraining)
              || foregroundRunning
            );
            const interruptAlreadyRequested = foregroundRunning
              && Boolean(activeAgent.activeExecution?.interruptRequestedAt);
            const previousMessage = activeAgent.messages[index - 1];
            const turnDurationMs = message.role === 'assistant'
              && previousMessage?.role === 'user'
              ? new Date(message.createdAt).getTime() - new Date(previousMessage.createdAt).getTime()
              : undefined;
            const turnActivities = message.role === 'assistant'
              ? activeActivities.filter((activity) => activity.turnId === message.id)
              : [];
            return (
            <article
              className={`agent-message ${message.role}`}
              key={message.id}
              data-agent-message-id={message.id}
              tabIndex={-1}
            >
              <span className="agent-message-role">
                {roleLabel(message.role)}
                <time className="agent-message-time">{formatClock(message.createdAt)}</time>
                {turnDurationMs !== undefined && turnDurationMs >= 0 && (
                  <small className="agent-message-duration">{formatDuration(turnDurationMs)}</small>
                )}
              </span>
              <Suspense fallback={<p className="agent-plain-message">{message.content}</p>}>
                <AgentMessageContent
                  role={message.role}
                  content={message.content}
                  streaming={activeAgent.streamingMessageId === message.id}
                />
              </Suspense>
              {!codexBackendSelected && (
                <div className="agent-message-memory-action">
                  <button
                    type="button"
                    data-action="pin-agent-memory"
                    disabled={
                      composerBlocked
                      || containsObviousAgentSecret(message.content)
                    }
                    title={containsObviousAgentSecret(message.content)
                      ? '检测到明显凭据，不能 Pin 到上下文记忆'
                      : '提炼为一张有界上下文记忆卡片'}
                    onClick={() => setAgentMemoryDraftSource({
                      id: message.id,
                      content: message.content,
                    })}
                  >记住</button>
                </div>
              )}
              {turnActivities.length > 0 && (
                <ToolActivityList
                  activities={turnActivities}
                  testId={`tool-activity-list-${message.id}`}
                  compact
                />
              )}
              {latestUser && (
                latestUserRunning ? (
                  <AgentActivityCard
                    phase={activeAgent.backendTurnDraining
                      ? '正在安全停止当前轮次'
                      : interruptAlreadyRequested
                        ? '已发送 Ctrl+C，等待前台进程退出'
                        : foregroundRunning
                          ? '前台命令正在运行'
                          : agentStateLabel(activeAgent.state)}
                    backend={agentBackendActivityLabel(activeAgent.backend, providers)}
                    context={activeTab
                      ? `当前终端：${activeTab.transport === 'ssh' ? 'SSH' : '本地'} · ${activeTab.title}`
                      : '当前无终端'}
                    interruptLabel={activeAgent.backendTurnDraining
                      ? '正在停止…'
                      : interruptAlreadyRequested
                        ? '已发送 Ctrl+C'
                        : foregroundRunning ? '打断前台进程' : '打断'}
                    interruptDisabled={Boolean(agentMessageActionPending)
                      || Boolean(activeAgent.backendTurnDraining)
                      || interruptAlreadyRequested}
                    onInterrupt={() => void interruptLatestAgentMessage(message.id)}
                  />
                ) : (
                  <div className="agent-message-actions" data-testid="latest-user-message-actions">
                    <small title="终端输出、命令执行和审计记录都会保留">
                      仅调整对话，不回滚终端
                    </small>
                    <>
                      <button
                        type="button"
                        data-action="retract-agent-message"
                        disabled={Boolean(agentMessageActionPending)}
                        onClick={() => void retractLatestAgentMessage(message.id, message.content)}
                      >撤回</button>
                      <button
                        type="button"
                        data-action="edit-agent-message"
                        disabled={Boolean(agentMessageActionPending)}
                        onClick={() => editLatestAgentMessage(message.id, message.content)}
                      >修改</button>
                    </>
                  </div>
                )
              )}
            </article>
            );
          })}
          <ToolActivityList activities={unmatchedActivities} />
          {activeAgent?.pendingApproval?.status === 'waiting'
            && activeAgent.backend.kind !== CODEX_APP_SERVER_AGENT_BACKEND && (
            <section className="approval-card">
              <div>
                <strong>命令审批</strong>
                <span>{activeAgent.pendingApproval.reason ?? '智能体请求在终端中执行命令'}</span>
              </div>
              <textarea
                aria-label="待审批命令"
                value={editedApprovalCommand}
                onChange={(event) => setEditedApprovalCommand(event.target.value)}
                spellCheck={false}
              />
              <div className="approval-actions">
                <button data-action="reject-command" onClick={() => void resolveAgentApproval('reject')}>拒绝</button>
                <button data-action="edit-command" onClick={() => void resolveAgentApproval('edit')}>编辑并执行</button>
                <button onClick={() => {
                  if (!activeTab || !activeAgent.pendingApproval) return;
                  setFullTakeoverChallenge({
                    terminalId: activeTab.id,
                    target: activeTab.title,
                    backend: activeAgent.backend,
                    approvalId: activeAgent.pendingApproval.id,
                    command: activeAgent.pendingApproval.command,
                    editedCommand: editedApprovalCommand,
                    hostPreference: activeAgent.fullTakeoverPreference,
                  });
                }} data-action="switch-full-takeover">切换为 AI 全接管…</button>
                <button className="execute" data-action="execute-command" onClick={() => void resolveAgentApproval('execute')}>执行</button>
              </div>
            </section>
          )}
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
            <span title="Enter 发送，Shift+Enter 换行">{activeAgent?.backendTurnDraining
              ? '正在等待 App Server 安全停止旧轮次…'
              : selectedAgentBackendReady
              ? activeAgent
                ? agentStateLabel(activeAgent.state)
                : selectedAgentBackendKind === CODEX_APP_SERVER_AGENT_BACKEND
                  ? '原生 Codex 已就绪 · 不控制当前终端'
                  : '已就绪 · 命令需审批'
              : selectedAgentBackendStatus}</span>
            <button
              type="submit"
              aria-label={editingAgentMessageId ? '修改并重新发送' : '发送消息'}
              disabled={!agentPrompt.trim() || !selectedAgentBackendReady || !activeTab || composerBlocked || Boolean(agentMessageActionPending)}
            >↑</button>
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

      {fileAccessChallenge && (
        <div className="modal-backdrop">
          <div
            className={`modal compact-modal file-access-modal ${
              fileAccessChallenge.mode === 'full-access' ? 'full-access-risk' : ''
            }`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="file-access-confirmation-title"
            data-testid="file-access-confirmation"
            data-access-mode={fileAccessChallenge.mode}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              setFileAccessChallenge(null);
            }}
          >
            <div className="modal-header">
              <strong id="file-access-confirmation-title">
                {fileAccessChallenge.mode === 'full-access'
                  ? '允许 AI 访问完整文件系统？'
                  : '允许 AI 直接修改文件？'}
              </strong>
            </div>
            <p>终端：<b>{fileAccessChallenge.target}</b></p>
            <p>绑定根目录：<code>{fileAccessChallenge.root}</code></p>
            <p className="risk-note">
              {fileAccessChallenge.mode === 'full-access' ? (
                <>
                  允许后，Generic Provider 可读取、创建、修改、重命名或删除当前本机/远程用户能访问的任意路径，
                  软件不再限制 Readable/Writable Paths。它不会提权，仍受本机 OS 或当前 SSH/SFTP 用户权限限制；
                  相对路径仍以上述 Workspace Root 为起点。权限只在本次应用运行期间有效。
                </>
              ) : (
                <>
                  允许后，Generic Provider 可在绑定根目录内创建、修改、重命名或删除文件与目录；这些修改不会经过终端，
                  也不能通过终端撤销。读取到的文件内容会作为 AI 请求上下文发送给当前 Provider。
                  权限只在本次应用运行期间有效。
                </>
              )}
              所有命令仍必须进入可见终端。
            </p>
            <div className="modal-actions">
              <button autoFocus onClick={() => setFileAccessChallenge(null)}>取消</button>
              <button
                className="danger-action"
                data-action={fileAccessChallenge.mode === 'full-access'
                  ? 'confirm-full-filesystem-access'
                  : 'confirm-file-read-write'}
                disabled={!fileAccessChallengeIsCurrent}
                onClick={() => {
                  const challenge = fileAccessChallenge;
                  if (!fileAccessChallengeIsCurrent) {
                    setFileAccessChallenge(null);
                    setWorkspaceActionError('文件访问授权目标已变化，请重新选择权限。');
                    return;
                  }
                  setFileAccessChallenge(null);
                  void setAgentFileAccess(
                    challenge.mode,
                    challenge.terminalId,
                    challenge.backend,
                    challenge.mode === 'full-access',
                    challenge.root,
                  );
                }}
              >{fileAccessChallenge.mode === 'full-access'
                  ? '我已了解风险，允许完整文件系统访问'
                  : '允许本次读写与删除'}</button>
            </div>
          </div>
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

      {activeAgent?.pendingTakeover
        && activeAgent.backend.kind !== CODEX_APP_SERVER_AGENT_BACKEND && (
        <div className="modal-backdrop">
          <div
            className="modal compact-modal takeover-modal"
            data-terminal-id={activeAgent.terminalId}
            data-takeover-id={activeAgent.pendingTakeover.id}
            data-execution-id={activeAgent.pendingTakeover.executionId}
          >
            <div className="modal-header"><strong>人工接管终端</strong></div>
            <p>智能体已暂停。请选择如何处理仍在前台运行的命令。</p>
            <code>{activeAgent.activeExecution?.command ?? '前台命令'}</code>
            <div className="modal-actions split-actions">
              <button data-action="keep-process" onClick={() => void resolveAgentTakeover('keep')}>保持进程运行</button>
              <button className="danger-action" data-action="interrupt-process" onClick={() => void resolveAgentTakeover('interrupt')}>发送 Ctrl+C</button>
            </div>
          </div>
        </div>
      )}

      {fullTakeoverChallenge
        && fullTakeoverChallenge.backend.kind !== CODEX_APP_SERVER_AGENT_BACKEND && (
        <div className="modal-backdrop">
          <div
            className="modal compact-modal full-takeover-modal"
            data-terminal-id={fullTakeoverChallenge.terminalId}
            data-approval-id={fullTakeoverChallenge.approvalId ?? ''}
          >
            <div className="modal-header"><strong>启用 AI 全接管？</strong></div>
            <p>
              目标：<b>{fullTakeoverChallenge.target}</b>。智能体将可以连续运行命令，包括删除、磁盘、网络、服务或重启命令，不再逐条询问。你仍可随时点击“人工接管”立即暂停智能体。
            </p>
            <p className="risk-note" data-testid="full-takeover-scope-note">
              {fullTakeoverChallenge.hostPreference
                ? '此主机已保存全接管偏好，但它没有授权当前终端。'
                : '确认后会为此主机保存全接管偏好。'}
              本次确认只授权当前终端；新建、重连或重启后的终端仍会重新询问。
            </p>
            <p className="risk-note">
              {fullTakeoverChallenge.approvalId
                ? '确认后会立即执行下方命令；在关闭全接管或人工接管前，后续命令都不会再次询问。'
                : ''}
              仅对你信任的终端和任务启用。遇到认证提示时仍会暂停，并让你直接安全输入。
            </p>
            {fullTakeoverChallenge.command && (
              <code>{fullTakeoverChallenge.editedCommand ?? fullTakeoverChallenge.command}</code>
            )}
            <div className="modal-actions">
              <button autoFocus onClick={() => setFullTakeoverChallenge(null)}>取消</button>
              <button
                className="danger-action"
                data-action="confirm-full-takeover"
                onClick={() => void setFullTakeover(
                  true,
                  fullTakeoverChallenge.terminalId,
                  fullTakeoverChallenge.approvalId,
                  fullTakeoverChallenge.editedCommand,
                  fullTakeoverChallenge.backend,
                )}
              >{fullTakeoverChallenge.approvalId
                  ? '启用并执行当前命令'
                  : '启用 AI 全接管'}</button>
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
