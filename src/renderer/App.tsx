import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { HostInput, HostProfile } from '../shared/host';
import type { RuntimeInfo } from '../shared/ipc';
import { PRODUCT_NAME } from '../shared/product';
import type { SessionRecord } from '../shared/session';
import type { ProviderInput, ProviderProfile } from '../shared/provider';
import {
  CODEX_APP_SERVER_AGENT_BACKEND,
  CODEX_APP_SERVER_AGENT_POLICY_VERSION,
} from '../shared/agent';
import type {
  AgentBackendRef,
  AgentRuntimeState,
  AgentSessionView,
} from '../shared/agent';
import type {
  CodexAppServerSnapshot,
  CodexModelInfo,
} from '../shared/codex-app-server';
import type { ShellProfile, TerminalDescriptor } from '../shared/terminal';
import { mergeAgentState } from './agent-state';
import { TerminalPane } from './components/TerminalPane';
import { SftpDrawer } from './components/SftpDrawer';
import { AgentMessageContent } from './components/AgentMessageContent';
import {
  isAgentOutputNearBottom,
  scrollAgentOutputToBottom,
} from './agent-scroll';
import {
  agentStateLabel,
  authMethodLabel,
  codexAgentIsolationAvailabilityLabel,
  codexAgentIsolationViolationKindLabel,
  codexAppServerOperationLabel,
  codexAppServerPhaseLabel,
  codexPlanTypeLabel,
  codexReasoningEffortLabel,
  executionStatusLabel,
  providerStatusLabel,
  roleLabel,
  sessionStatusLabel,
} from './ui-text';

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
}

type AgentBackendKind = AgentBackendRef['kind'];
type SidebarView = 'terminals' | 'hosts' | 'history';

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

function mergeCodexAppServerState(
  current: CodexAppServerSnapshot | null,
  incoming: CodexAppServerSnapshot,
): CodexAppServerSnapshot {
  return current && current.revision >= incoming.revision ? current : incoming;
}

function preferredCodexReasoningEffort(
  model: CodexModelInfo,
  preferred?: string,
): string {
  const efforts = model.supportedReasoningEfforts;
  if (efforts.length === 0) return '';
  if (preferred && efforts.some((effort) => effort.reasoningEffort === preferred)) {
    return preferred;
  }
  if (
    model.defaultReasoningEffort
    && efforts.some((effort) => effort.reasoningEffort === model.defaultReasoningEffort)
  ) return model.defaultReasoningEffort;
  return efforts[0]?.reasoningEffort ?? '';
}

export function App() {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [shells, setShells] = useState<ShellProfile[]>([]);
  const [hosts, setHosts] = useState<HostProfile[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [providers, setProviders] = useState<ProviderProfile[]>([]);
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [sidebarView, setSidebarView] = useState<SidebarView>('terminals');
  const [sidebarSearch, setSidebarSearch] = useState('');
  const [newTerminalOpen, setNewTerminalOpen] = useState(false);
  const [sftpOpen, setSftpOpen] = useState(false);
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [providerSettingsSection, setProviderSettingsSection] = useState<'codex' | 'generic'>('codex');
  const [editingProvider, setEditingProvider] = useState<ProviderProfile | null>(null);
  const [providerMessage, setProviderMessage] = useState<string | null>(null);
  const [codexAppServer, setCodexAppServer] = useState<CodexAppServerSnapshot | null>(null);
  const [codexMessage, setCodexMessage] = useState<CodexUiMessage | null>(null);
  const [codexActionPending, setCodexActionPending] = useState(false);
  const [codexModelId, setCodexModelId] = useState('');
  const [codexReasoningEffort, setCodexReasoningEffort] = useState('');
  const [codexAgentEnableChallenge, setCodexAgentEnableChallenge] = useState(false);
  const [codexAgentBoundaryAcknowledged, setCodexAgentBoundaryAcknowledged] = useState(false);
  const codexActionLock = useRef(false);
  const providerModalRef = useRef<HTMLDivElement>(null);
  const codexAgentConfirmationRef = useRef<HTMLDivElement>(null);
  const agentBodyRef = useRef<HTMLDivElement>(null);
  const agentStickToBottomRef = useRef(true);
  const sshConnectionLock = useRef(false);
  const [agentStates, setAgentStates] = useState<Record<string, AgentSessionView>>({});
  const [agentBackendChoices, setAgentBackendChoices] = useState<Record<string, AgentBackendKind>>({});
  const [agentUpdatesBelow, setAgentUpdatesBelow] = useState(false);
  const [agentPrompt, setAgentPrompt] = useState('');
  const [editedApprovalCommand, setEditedApprovalCommand] = useState('');
  const [editingHost, setEditingHost] = useState<HostProfile | null | undefined>(undefined);
  const [connectingHost, setConnectingHost] = useState<HostProfile | null>(null);
  const [reconnectingSessionId, setReconnectingSessionId] = useState<string | null>(null);
  const [renamingSession, setRenamingSession] = useState<SessionRecord | null>(null);
  const [sessionRenameDraft, setSessionRenameDraft] = useState('');
  const [sessionRenameError, setSessionRenameError] = useState<string | null>(null);
  const [sessionRenamePending, setSessionRenamePending] = useState(false);
  const [trustChallenge, setTrustChallenge] = useState<TrustChallenge | null>(null);
  const [fullTakeoverChallenge, setFullTakeoverChallenge] = useState<FullTakeoverChallenge | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [sshConnectionPending, setSshConnectionPending] = useState(false);
  const [hostCredentialMessage, setHostCredentialMessage] = useState<HostCredentialMessage | null>(null);
  const [credentialActionPending, setCredentialActionPending] = useState(false);

  useEffect(() => {
    void window.aiTerminal.runtime.getInfo().then(setRuntime);
    void window.aiTerminal.hosts.list().then(setHosts).catch((error) => {
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
    const removeExitListener = window.aiTerminal.terminal.onExit((event) => {
      setTabs((current) => current.map((tab) => (
        tab.id === event.terminalId ? { ...tab, status: 'exited' } : tab
      )));
      void refreshSessions();
    });
    const removeAgentListener = window.aiTerminal.agent.onStateChanged((state) => {
      setAgentStates((current) => mergeAgentState(current, state));
      setTabs((current) => current.map((tab) => (
        tab.id === state.terminalId ? { ...tab, sessionId: state.sessionId } : tab
      )));
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
      removeExitListener();
      removeAgentListener();
      removeCodexAppServerListener();
    };
  }, []);

  useEffect(() => {
    if (!codexAppServer) return;
    const { models, selection } = codexAppServer;
    if (models.length === 0) {
      setCodexModelId('');
      setCodexReasoningEffort('');
      return;
    }
    const currentModel = models.find((model) => model.id === codexModelId);
    const selectedModel = models.find((model) => model.id === selection?.modelId);
    const nextModel = currentModel
      ?? selectedModel
      ?? models.find((model) => model.isDefault)
      ?? models[0];
    const preferredEffort = currentModel
      ? codexReasoningEffort
      : nextModel.id === selection?.modelId
        ? selection.reasoningEffort
        : undefined;
    const nextEffort = preferredCodexReasoningEffort(nextModel, preferredEffort);
    if (nextModel.id !== codexModelId) setCodexModelId(nextModel.id);
    if (nextEffort !== codexReasoningEffort) setCodexReasoningEffort(nextEffort);
  }, [codexAppServer?.revision]);

  useEffect(() => {
    if (!providerModalOpen) return undefined;
    const previouslyFocused = document.activeElement;
    providerModalRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (codexAgentEnableChallenge) {
        setCodexAgentEnableChallenge(false);
        setCodexAgentBoundaryAcknowledged(false);
        return;
      }
      setProviderModalOpen(false);
      setCodexMessage(null);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [providerModalOpen, codexAgentEnableChallenge]);

  useEffect(() => {
    if (codexAgentEnableChallenge) codexAgentConfirmationRef.current?.focus();
  }, [codexAgentEnableChallenge]);

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
  const selectedHost = hosts.find((host) => host.id === selectedHostId) ?? null;
  const selectedHostSessions = selectedHost
    ? sessions.filter((session) => session.hostId === selectedHost.id)
    : [];
  const normalizedSidebarSearch = sidebarSearch.trim().toLocaleLowerCase('zh-CN');
  const filteredShells = normalizedSidebarSearch
    ? shells.filter((shell) => `${shell.label} ${shell.detail}`.toLocaleLowerCase('zh-CN')
      .includes(normalizedSidebarSearch))
    : shells;
  const filteredTabs = normalizedSidebarSearch
    ? tabs.filter((tab) => tab.title.toLocaleLowerCase('zh-CN').includes(normalizedSidebarSearch))
    : tabs;
  const filteredHosts = normalizedSidebarSearch
    ? hosts.filter((host) => `${host.name} ${host.username} ${host.hostname} ${host.group ?? ''}`
      .toLocaleLowerCase('zh-CN').includes(normalizedSidebarSearch))
    : hosts;
  const filteredSessions = normalizedSidebarSearch
    ? sessions.filter((session) => {
      const host = session.hostId ? hosts.find((candidate) => candidate.id === session.hostId) : null;
      return `${session.name} ${host?.name ?? ''} ${session.effectiveUser ?? ''} ${session.lastKnownCwd ?? ''}`
        .toLocaleLowerCase('zh-CN').includes(normalizedSidebarSearch);
    })
    : sessions;
  const defaultProvider = providers.find((provider) => provider.isDefault) ?? null;
  const selectedCodexModel = codexAppServer?.models.find((model) => (
    model.id === codexModelId
  ));
  const codexBusy = codexActionPending
    || Boolean(codexAppServer && codexAppServer.operation !== 'idle');
  const savedCodexEffort = selectedCodexModel?.supportedReasoningEfforts.length
    ? codexAppServer?.selection?.reasoningEffort ?? ''
    : '';
  const draftCodexEffort = selectedCodexModel?.supportedReasoningEfforts.length
    ? codexReasoningEffort
    : '';
  const codexDraftMatchesSaved = Boolean(
    selectedCodexModel
    && codexAppServer?.selection?.modelId === codexModelId
    && savedCodexEffort === draftCodexEffort,
  );
  const codexSelectionSaved = Boolean(codexAppServer?.bound && codexDraftMatchesSaved);
  const codexSelectionDirty = Boolean(selectedCodexModel && !codexSelectionSaved);
  const codexOperationText = codexAppServer && codexAppServer.operation !== 'idle'
    ? codexAppServerOperationLabel(codexAppServer.operation)
    : codexActionPending
      ? '正在处理界面操作'
      : null;
  const activeAgent = activeTab ? agentStates[activeTab.id] : undefined;
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
  const codexIsolation = codexAppServer?.agentIsolation;
  const codexAgentEnabled = Boolean(
    codexAppServer?.terminalAgentEnabled
    && codexIsolation?.availability === 'enabled',
  );
  const codexAgentCanRequestEnable = codexIsolation?.availability === 'eligible'
    || codexIsolation?.availability === 'blocked';
  const selectedAgentBackendReady = selectedAgentBackendKind
    === CODEX_APP_SERVER_AGENT_BACKEND
    ? codexAgentEnabled
    : selectedGenericProvider?.status === 'ready';
  const selectedAgentBackendStatus = selectedAgentBackendKind
    === CODEX_APP_SERVER_AGENT_BACKEND
    ? codexIsolation
      ? `${codexAgentIsolationAvailabilityLabel(codexIsolation.availability)} · ${codexIsolation.reason}`
      : '正在读取隔离 App Server Agent 状态。'
    : selectedGenericProvider
      ? `${selectedGenericProvider.name} · ${providerStatusLabel(selectedGenericProvider.status)}`
      : '尚未配置默认 Provider。';

  useLayoutEffect(() => {
    agentStickToBottomRef.current = true;
    setAgentUpdatesBelow(false);
    if (agentBodyRef.current) scrollAgentOutputToBottom(agentBodyRef.current);
  }, [activeId]);

  useLayoutEffect(() => {
    const element = agentBodyRef.current;
    if (!element) return;
    if (agentStickToBottomRef.current) {
      scrollAgentOutputToBottom(element);
      setAgentUpdatesBelow(false);
    } else {
      setAgentUpdatesBelow(true);
    }
  }, [activeId, activeAgent?.revision]);

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
  const activeInputMode = activeAgent?.terminalInputMode ?? 'human';
  const foregroundRunning = activeAgent?.state === 'PAUSED'
    && activeAgent.activeExecution?.status === 'running';
  const composerBlocked = agentTurnBusy(activeAgent?.state)
    || foregroundRunning
    || Boolean(activeAgent?.backendTurnDraining);

  useEffect(() => {
    if (!activeId) return;
    void window.aiTerminal.agent.getState(activeId).then((state) => {
      if (state) setAgentStates((current) => mergeAgentState(current, state));
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

  async function refreshSessions() {
    setSessions(await window.aiTerminal.sessions.list());
  }

  async function refreshProviders() {
    setProviders(await window.aiTerminal.providers.list());
  }

  function applyCodexState(state: CodexAppServerSnapshot) {
    setCodexAppServer((current) => mergeCodexAppServerState(current, state));
  }

  async function runCodexAction(
    action: () => Promise<CodexAppServerSnapshot>,
    successMessage?: string,
  ) {
    if (codexActionLock.current) return;
    codexActionLock.current = true;
    setCodexActionPending(true);
    setCodexMessage(null);
    try {
      const state = await action();
      applyCodexState(state);
      if (state.error) {
        setCodexMessage({ tone: 'error', text: state.error });
      } else if (successMessage) {
        setCodexMessage({ tone: 'success', text: successMessage });
      }
    } catch (error) {
      setCodexMessage({ tone: 'error', text: errorMessage(error) });
    } finally {
      codexActionLock.current = false;
      setCodexActionPending(false);
    }
  }

  function selectCodexModel(modelId: string) {
    setCodexModelId(modelId);
    const model = codexAppServer?.models.find((candidate) => candidate.id === modelId);
    setCodexReasoningEffort(model ? preferredCodexReasoningEffort(model) : '');
  }

  async function saveCodexSelection() {
    if (!selectedCodexModel || !codexSelectionDirty) return;
    await runCodexAction(
      () => window.aiTerminal.codexAppServer.saveSelection({
        modelId: codexModelId,
        reasoningEffort: selectedCodexModel.supportedReasoningEfforts.length
          ? codexReasoningEffort || undefined
          : undefined,
      }),
      'App Server 首选模型已保存。',
    );
  }

  function openAgentBackendSettings() {
    setProviderSettingsSection(
      selectedAgentBackendKind === CODEX_APP_SERVER_AGENT_BACKEND ? 'codex' : 'generic',
    );
    setEditingProvider(defaultProvider);
    setProviderMessage(null);
    setCodexMessage(null);
    setProviderModalOpen(true);
  }

  function requestCodexAgentEnable() {
    setCodexAgentBoundaryAcknowledged(false);
    setCodexAgentEnableChallenge(true);
  }

  async function setCodexAgentEnabled(enabled: boolean) {
    if (enabled && !codexAgentBoundaryAcknowledged) return;
    setCodexAgentEnableChallenge(false);
    setCodexAgentBoundaryAcknowledged(false);
    await runCodexAction(
      () => window.aiTerminal.codexAppServer.setTerminalAgentEnabled(enabled
        ? { enabled: true, acknowledgementVersion: 1 }
        : { enabled: false }),
      enabled
        ? '隔离 App Server Agent（实验）已为本次应用运行启用。请在智能体区域选择此后端。'
        : '隔离 App Server Agent 已停用。',
    );
  }

  async function saveProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const apiKeyInput = event.currentTarget.elements.namedItem('apiKey') as HTMLInputElement;
    const input: ProviderInput = {
      id: editingProvider?.id,
      name: String(data.get('name') ?? ''),
      baseUrl: String(data.get('baseUrl') ?? ''),
      modelId: String(data.get('modelId') ?? ''),
      apiKey: String(data.get('apiKey') ?? '') || undefined,
      makeDefault: data.get('makeDefault') === 'on',
    };
    apiKeyInput.value = '';
    try {
      const saved = await window.aiTerminal.providers.save(input);
      await refreshProviders();
      setEditingProvider(saved);
      setProviderMessage('已保存。请先测试连接，再使用此 Provider。');
    } catch (error) {
      setProviderMessage(errorMessage(error));
    }
  }

  async function testProvider(providerId: string) {
    setProviderMessage('正在测试连接…');
    try {
      const result = await window.aiTerminal.providers.testConnection(providerId);
      await refreshProviders();
      setProviderMessage(result.message);
    } catch (error) {
      setProviderMessage(errorMessage(error));
    }
  }

  async function removeProvider(provider: ProviderProfile) {
    if (!window.confirm(`确定删除 Provider“${provider.name}”及其已保存的凭据吗？`)) return;
    await window.aiTerminal.providers.remove(provider.id);
    setEditingProvider(null);
    await refreshProviders();
  }

  async function sendAgentPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeTab || !agentPrompt.trim() || !selectedAgentBackend || !selectedAgentBackendReady) {
      return;
    }
    const prompt = agentPrompt.trim();
    setAgentPrompt('');
    try {
      const state = await window.aiTerminal.agent.sendPrompt({
        terminalId: activeTab.id,
        prompt,
        backend: selectedAgentBackend,
      });
      setAgentStates((current) => mergeAgentState(current, state));
      setTabs((current) => current.map((tab) => (
        tab.id === state.terminalId ? { ...tab, sessionId: state.sessionId } : tab
      )));
      await refreshSessions();
    } catch (error) {
      setConnectionError(errorMessage(error));
    }
  }

  async function resolveAgentApproval(decision: 'execute' | 'edit' | 'reject') {
    if (!activeTab || !activeAgent?.pendingApproval) return;
    try {
      const state = await window.aiTerminal.agent.resolveApproval({
        terminalId: activeTab.id,
        approvalId: activeAgent.pendingApproval.id,
        decision,
        editedCommand: decision === 'edit' ? editedApprovalCommand : undefined,
      });
      setAgentStates((current) => mergeAgentState(current, state));
    } catch (error) {
      setConnectionError(errorMessage(error));
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
    try {
      const state = await window.aiTerminal.agent.setFullTakeover({
        terminalId,
        enabled,
        backend,
        approvalId,
        editedCommand,
      });
      setAgentStates((current) => mergeAgentState(current, state));
      setTabs((current) => current.map((tab) => (
        tab.id === terminalId ? { ...tab, sessionId: state.sessionId } : tab
      )));
      setFullTakeoverChallenge(null);
      await refreshSessions();
    } catch (error) {
      setConnectionError(errorMessage(error));
    }
  }

  async function requestAgentTakeover() {
    if (!activeTab) return;
    try {
      const state = await window.aiTerminal.agent.takeover({ terminalId: activeTab.id });
      setAgentStates((current) => mergeAgentState(current, state));
    } catch (error) {
      setConnectionError(errorMessage(error));
    }
  }

  async function resolveAgentTakeover(action: 'keep' | 'interrupt') {
    if (!activeTab || !activeAgent?.pendingTakeover) return;
    try {
      const state = await window.aiTerminal.agent.resolveTakeover({
        terminalId: activeTab.id,
        takeoverId: activeAgent.pendingTakeover.id,
        executionId: activeAgent.pendingTakeover.executionId,
        action,
      });
      setAgentStates((current) => mergeAgentState(current, state));
    } catch (error) {
      setConnectionError(errorMessage(error));
    }
  }

  async function confirmShellReady(terminalId: string, executionId: string) {
    try {
      const state = await window.aiTerminal.agent.confirmShellReady({
        terminalId,
        executionId,
      });
      setAgentStates((current) => mergeAgentState(current, state));
    } catch (error) {
      setConnectionError(errorMessage(error));
    }
  }

  async function activateAiSession() {
    if (!activeTab) return;
    try {
      const session = await window.aiTerminal.sessions.upgrade({ terminalId: activeTab.id });
      setTabs((current) => current.map((tab) => (
        tab.id === activeTab.id ? { ...tab, sessionId: session.id } : tab
      )));
      await refreshSessions();
    } catch (error) {
      setConnectionError(errorMessage(error));
    }
  }

  function openSessionRename(session: SessionRecord) {
    setRenamingSession(session);
    setSessionRenameDraft(session.name);
    setSessionRenameError(null);
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

  async function saveHost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input: HostInput = {
      id: editingHost?.id,
      name: String(data.get('name') ?? ''),
      hostname: String(data.get('hostname') ?? ''),
      port: Number(data.get('port') ?? 22),
      username: String(data.get('username') ?? ''),
      authMethod: String(data.get('authMethod') ?? 'password') as HostInput['authMethod'],
      privateKeyPath: String(data.get('privateKeyPath') ?? ''),
      group: String(data.get('group') ?? ''),
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
    try {
      await window.aiTerminal.hosts.remove(host.id);
      if (selectedHostId === host.id) setSelectedHostId(null);
      setHostCredentialMessage(null);
      await refreshHosts();
    } catch (error) {
      setHostCredentialMessage({
        hostId: host.id,
        tone: 'error',
        text: errorMessage(error),
      });
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
        text: '已从 Windows 凭据管理器删除 SSH 凭据。',
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
          text: 'SSH 凭据已安全保存到当前用户的 Windows 凭据管理器。',
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

  return (
    <div className="app-shell" data-locale="zh-CN">
      <header className="titlebar">
        <div className="brand-mark" aria-hidden="true">&gt;_</div>
        <div className="brand-copy">
          <strong>{PRODUCT_NAME}</strong>
          <span>共享终端智能体</span>
        </div>
        <div className="workspace-title">本地工作区</div>
        <div className="runtime-pill">
          <span className="status-dot" />
          {runtime ? `${runtime.platform} · ${runtime.arch}` : '正在启动…'}
        </div>
      </header>

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
          title="SSH 主机"
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
          setProviderSettingsSection('codex');
          setEditingProvider(defaultProvider);
          setProviderMessage(null);
          setCodexMessage(null);
          setProviderModalOpen(true);
        }}>⚙</button>
      </aside>

      <aside className="sidebar">
        <div className="panel-heading">
          <span>{sidebarView === 'terminals'
            ? '终端'
            : sidebarView === 'hosts' ? 'SSH 主机' : '会话历史'}</span>
          {sidebarView === 'hosts' && (
            <button title="添加 SSH 主机" onClick={() => setEditingHost(null)}>＋</button>
          )}
        </div>
        <label className="search-box">
          <span>⌕</span>
          <input
            aria-label="筛选当前列表"
            placeholder={sidebarView === 'terminals'
              ? '搜索 Shell 或终端'
              : sidebarView === 'hosts' ? '搜索 SSH 主机' : '搜索会话历史'}
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
                <span>SSH 主机</span>
                <button onClick={() => setEditingHost(null)}>添加</button>
              </div>
              <div className="host-list">
                {filteredHosts.map((host) => (
                  <button
                    className={`host-row ${selectedHostId === host.id ? 'active' : ''}`}
                    key={host.id}
                    aria-expanded={selectedHostId === host.id}
                    onClick={() => setSelectedHostId((current) => current === host.id ? null : host.id)}
                  >
                    <span className="host-icon">{host.favorite ? '★' : '◇'}</span>
                    <span>
                      <strong>{host.name}</strong>
                      <small>{host.username}@{host.hostname}:{host.port}</small>
                    </span>
                  </button>
                ))}
                {filteredHosts.length === 0 && <div className="empty-list">没有匹配的 SSH 主机</div>}
              </div>

              {selectedHost && (
                <div className="selected-host-card">
            <strong>{selectedHost.name}</strong>
            <span>{authMethodLabel(selectedHost.authMethod)} · {selectedHost.hostKeyFingerprint ? '已信任' : '未验证'}</span>
            <div>
              <button
                data-action="connect-host"
                disabled={sshConnectionPending}
                onClick={() => openSshConnection(selectedHost)}
              >{sshConnectionPending ? '正在连接…' : '连接'}</button>
              <button onClick={() => setEditingHost(selectedHost)}>编辑</button>
              <button className="danger-text" onClick={() => void removeHost(selectedHost)}>删除</button>
            </div>
            {selectedHost.authMethod !== 'agent' && (
              <div className="host-credential-row">
                <small>Windows 凭据：{selectedHost.credentialConfigured ? '已保存' : '未保存'}</small>
                {selectedHost.credentialConfigured && (
                  <button
                    type="button"
                    data-action="forget-host-credential"
                    disabled={credentialActionPending}
                    onClick={() => void forgetHostCredential(selectedHost)}
                  >{credentialActionPending ? '正在删除…' : '删除凭据'}</button>
                )}
              </div>
            )}
            {hostCredentialMessage?.hostId === selectedHost.id && (
              <div
                className={`host-credential-message ${hostCredentialMessage.tone}`}
                role={hostCredentialMessage.tone === 'error' ? 'alert' : 'status'}
              >{hostCredentialMessage.text}</div>
            )}
            <div className="host-session-history">
              <small>会话历史</small>
              {selectedHostSessions.map((session) => (
                <div className="session-history-row" key={session.id}>
                  <span>
                    <strong>{session.name}</strong>
                    <small>{sessionStatusLabel(session.status)} · {new Date(session.updatedAt).toLocaleString('zh-CN')}</small>
                  </span>
                  <span className="session-history-actions">
                    <button
                      type="button"
                      title="重命名会话"
                      data-action="rename-session"
                      data-session-id={session.id}
                      onClick={() => openSessionRename(session)}
                    >重命名</button>
                    <button
                      data-action="reconnect-session"
                      data-session-id={session.id}
                      disabled={sshConnectionPending}
                      onClick={() => openSshConnection(selectedHost, session.id)}
                    >重连</button>
                  </span>
                </div>
              ))}
              {selectedHostSessions.length === 0 && <small>尚无正式会话。</small>}
            </div>
                </div>
              )}
            </>
          )}

          {sidebarView === 'history' && (
            <div className="history-sidebar-list">
              {filteredSessions.map((session) => {
                const host = session.hostId
                  ? hosts.find((candidate) => candidate.id === session.hostId)
                  : undefined;
                const runtimeTab = tabs.find((tab) => (
                  tab.sessionId === session.id || tab.id === session.runtimeTerminalId
                ));
                return (
                  <article className="history-sidebar-row" key={session.id}>
                    <button
                      className="history-session-main"
                      disabled={!runtimeTab && !host}
                      onClick={() => {
                        if (runtimeTab) setActiveId(runtimeTab.id);
                        else if (host) openSshConnection(host, session.id);
                      }}
                    >
                      <strong>{session.name}</strong>
                      <small>{host?.name ?? (session.transport === 'ssh' ? 'SSH 主机' : '本地 Shell')}</small>
                      <small>{sessionStatusLabel(session.status)} · {new Date(session.updatedAt).toLocaleString('zh-CN')}</small>
                    </button>
                    <div className="history-session-actions">
                      <button onClick={() => openSessionRename(session)}>重命名</button>
                      {host && (
                        <button
                          disabled={sshConnectionPending}
                          onClick={() => openSshConnection(host, session.id)}
                        >重连</button>
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
              />
            ))}
            {tabs.length === 0 && !startupError && (
              <div className="terminal-placeholder">请选择本地 Shell 或 SSH 主机以打开终端。</div>
            )}
            {startupError && <div className="terminal-error">{startupError}</div>}
          </div>
          <footer className="terminal-statusbar">
            <span>UTF-8</span>
            <span>{activeTab?.transport === 'ssh' ? 'SSH PTY' : 'ConPTY'}</span>
            <span>{activeTab?.sessionId ? '正式会话' : '临时终端'}</span>
          </footer>
        </section>
        {sftpOpen && <SftpDrawer terminal={activeTab} onClose={() => setSftpOpen(false)} />}
      </main>

      <aside className="agent-panel">
        <div className="agent-header">
          <div className="agent-heading">
            <strong>AI 智能体</strong>
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
                  Codex App Server · 隔离实验
                </option>
              </select>
            </label>
            <span
              id="agent-backend-status"
              className={`agent-backend-status ${selectedAgentBackendReady ? 'ready' : 'unavailable'}`}
              data-testid="agent-backend-status"
              role="status"
            >{selectedAgentBackendStatus}</span>
          </div>
          <div className="agent-controls">
            {activeAgent?.fullTakeover && <span className="takeover-badge">AI 全接管</span>}
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
                  });
                }
              }}
            >{activeAgent?.fullTakeover ? '关闭全接管' : 'AI 全接管'}</button>
          </div>
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
              className={`agent-backend-notice ${codexIsolation?.availability ?? 'unavailable'}`}
              data-testid="agent-codex-boundary"
              data-isolation-state={codexIsolation?.availability ?? 'unavailable'}
            >
              <strong>隔离 App Server Agent（实验）</strong>
              <p>{codexAgentEnabled
                ? '当前只把 terminal_read、terminal_state、terminal_execute 接入这个可见终端。App Server 内建请求不受“全接管”影响。'
                : selectedAgentBackendStatus}</p>
              <button data-action="open-codex-agent-settings" onClick={openAgentBackendSettings}>
                {codexAgentEnabled ? '查看隔离边界' : '打开 App Server 设置'}
              </button>
            </section>
          )}
          {!activeAgent?.messages.length && (
            <div className="agent-empty">
              <div className="agent-glyph">✦</div>
              <strong>理解终端上下文的 AI 助手</strong>
              <p>智能体会读取当前会话，并在向这个可见终端发送每条命令前请求你的批准。</p>
              <div className="guardrail"><span>✓</span> 默认逐条审批命令</div>
              <button
                className="provider-configure"
                data-action="open-agent-provider-settings"
                data-testid="open-agent-backend-settings"
                onClick={openAgentBackendSettings}
              >
                管理智能体后端
              </button>
              {activeTab && !activeTab.sessionId && (
                <button className="activate-session" onClick={() => void activateAiSession()}>
                  启用 AI 会话
                </button>
              )}
            </div>
          )}
          {activeAgent?.messages.map((message) => (
            <article className={`agent-message ${message.role}`} key={message.id}>
              <span>{roleLabel(message.role)}</span>
              <AgentMessageContent
                role={message.role}
                content={message.content}
                streaming={activeAgent.streamingMessageId === message.id}
              />
            </article>
          ))}
          {activeAgent?.pendingApproval?.status === 'waiting' && (
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
          <textarea
            aria-label="向 AI 发送消息"
            data-testid="agent-composer"
            placeholder="让智能体检查或操作当前终端…"
            value={agentPrompt}
            onChange={(event) => setAgentPrompt(event.target.value)}
            disabled={!selectedAgentBackendReady || !activeTab || activeTab.status !== 'connected' || composerBlocked}
          />
          <div>
            <span>{activeAgent?.backendTurnDraining
              ? '正在等待 App Server 安全停止旧轮次…'
              : selectedAgentBackendReady
              ? activeAgent
                ? agentStateLabel(activeAgent.state)
                : selectedAgentBackendKind === CODEX_APP_SERVER_AGENT_BACKEND
                  ? '隔离实验已就绪 · terminal_execute 默认逐条审批'
                  : '已就绪 · 命令需审批'
              : selectedAgentBackendStatus}</span>
            <button
              type="submit"
              aria-label="发送消息"
              disabled={!agentPrompt.trim() || !selectedAgentBackendReady || !activeTab || composerBlocked}
            >↑</button>
          </div>
        </form>
      </aside>

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

      {editingHost !== undefined && (
        <div className="modal-backdrop">
          <form className="modal" onSubmit={(event) => void saveHost(event)}>
            <div className="modal-header">
              <strong>{editingHost ? '编辑 SSH 主机' : '添加 SSH 主机'}</strong>
              <button type="button" onClick={() => setEditingHost(undefined)}>×</button>
            </div>
            <div className="form-grid">
              <label className="span-2">显示名称<input name="name" required defaultValue={editingHost?.name ?? 'Ubuntu 测试机'} /></label>
              <label className="span-2">主机名或 IP 地址<input name="hostname" required defaultValue={editingHost?.hostname ?? ''} /></label>
              <label>端口<input name="port" type="number" min="1" max="65535" required defaultValue={editingHost?.port ?? 22} /></label>
              <label>用户名<input name="username" required defaultValue={editingHost?.username ?? ''} /></label>
              <label className="span-2">认证方式
                <select name="authMethod" defaultValue={editingHost?.authMethod ?? 'password'}>
                  <option value="password">用户名和密码</option>
                  <option value="keyboard-interactive">键盘交互认证</option>
                  <option value="private-key">私钥</option>
                  <option value="agent">Windows OpenSSH / Pageant 代理</option>
                </select>
              </label>
              <label className="span-2">私钥路径（使用私钥时）<input name="privateKeyPath" defaultValue={editingHost?.privateKeyPath ?? ''} /></label>
              <label>分组<input name="group" defaultValue={editingHost?.group ?? ''} /></label>
              <label className="check-label"><input name="favorite" type="checkbox" defaultChecked={editingHost?.favorite} /> 收藏</label>
            </div>
            {connectionError && <div className="form-error">{connectionError}</div>}
            <div className="modal-actions">
              <button type="button" onClick={() => setEditingHost(undefined)}>取消</button>
              <button className="primary" type="submit">保存主机</button>
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
                    ? '已保存的凭据只由主进程从当前用户的 Windows 凭据管理器读取；密码框可留空。'
                    : '勾选后仅保存到当前用户的 Windows 凭据管理器，不写入主机、会话、终端或审计日志。'}
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

      {providerModalOpen && (
        <div className="modal-backdrop">
          <div
            ref={providerModalRef}
            className="modal provider-modal"
            data-testid="provider-settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="provider-settings-title"
            aria-hidden={codexAgentEnableChallenge || undefined}
            tabIndex={-1}
          >
            <div className="modal-header">
              <strong id="provider-settings-title">AI 服务设置</strong>
              <button type="button" aria-label="关闭 AI 服务设置" onClick={() => {
                setProviderModalOpen(false);
                setCodexMessage(null);
                setCodexAgentEnableChallenge(false);
                setCodexAgentBoundaryAcknowledged(false);
              }}>×</button>
            </div>
            <div className="provider-kind-tabs" role="tablist" aria-label="AI 服务类型">
              <button
                id="provider-kind-codex"
                type="button"
                className={providerSettingsSection === 'codex' ? 'active' : ''}
                data-testid="provider-kind-codex"
                onClick={() => {
                  setProviderSettingsSection('codex');
                  setCodexMessage(null);
                }}
                role="tab"
                aria-selected={providerSettingsSection === 'codex'}
                aria-controls="provider-panel-codex"
              >Codex App Server</button>
              <button
                id="provider-kind-generic"
                type="button"
                className={providerSettingsSection === 'generic' ? 'active' : ''}
                data-testid="provider-kind-generic"
                onClick={() => {
                  setProviderSettingsSection('generic');
                  setCodexMessage(null);
                }}
                role="tab"
                aria-selected={providerSettingsSection === 'generic'}
                aria-controls="provider-panel-generic"
              >OpenAI 兼容 API</button>
            </div>

            {providerSettingsSection === 'codex' && codexMessage && (
              <div
                className={`provider-message codex-ui-message ${codexMessage.tone}`}
                role={codexMessage.tone === 'error' ? 'alert' : 'status'}
                aria-live={codexMessage.tone === 'error' ? 'assertive' : 'polite'}
              >{codexMessage.text}</div>
            )}

            {providerSettingsSection === 'codex' && (
              <div
                id="provider-panel-codex"
                className="codex-app-server-panel"
                data-testid="codex-app-server-panel"
                role="tabpanel"
                aria-labelledby="provider-kind-codex"
                aria-busy={codexBusy}
              >
                <section className="codex-setup-section">
                  <div className="codex-section-heading">
                    <span>1</span>
                    <div><strong>App Server 服务</strong><small>由主进程启动官方 codex app-server，不解析命令行界面。</small></div>
                  </div>
                  <div
                    className="codex-status-row"
                    data-testid="codex-service-status"
                    role="status"
                    aria-live="polite"
                  >
                    <div>
                      <span
                        className={`codex-state-dot ${codexAppServer?.phase ?? 'stopped'}`}
                        aria-hidden="true"
                      />
                      <span className="codex-status-copy">
                        <strong>{codexAppServer
                          ? codexAppServerPhaseLabel(codexAppServer.phase)
                          : '正在读取状态'}</strong>
                        {codexOperationText && <small>{codexOperationText}…</small>}
                      </span>
                    </div>
                    {codexAppServer?.executable && (
                      <small className="codex-status-version">{codexAppServer.executable.version}</small>
                    )}
                  </div>
                  {codexAppServer?.executable && (
                    <code className="codex-executable-path" title={codexAppServer.executable.path}>
                      {codexAppServer.executable.path}
                    </code>
                  )}
                  <div className="codex-actions">
                    {codexAppServer?.phase !== 'ready' ? (
                      <button
                        className="primary"
                        data-action="codex-start"
                        disabled={codexBusy}
                        onClick={() => void runCodexAction(
                          () => window.aiTerminal.codexAppServer.start(),
                        )}
                      >自动检测并启动</button>
                    ) : (
                      <>
                        <button
                          data-action="codex-refresh"
                          disabled={codexBusy}
                          onClick={() => void runCodexAction(
                            () => window.aiTerminal.codexAppServer.refresh(),
                            '账号与模型状态已刷新。',
                          )}
                        >刷新状态</button>
                        <button
                          data-action="codex-restart"
                          disabled={codexBusy}
                          onClick={() => void runCodexAction(
                            () => window.aiTerminal.codexAppServer.restart(),
                          )}
                        >重启服务</button>
                      </>
                    )}
                    <button
                      data-action="codex-choose-executable"
                      disabled={codexBusy}
                      onClick={() => void runCodexAction(
                        () => window.aiTerminal.codexAppServer.chooseExecutable(),
                      )}
                    >选择 codex 可执行文件…</button>
                  </div>
                  {codexAppServer?.error && (
                    <div className="codex-error" data-testid="codex-error" role="alert">
                      {codexAppServer.error}
                    </div>
                  )}
                </section>

                <section className="codex-setup-section">
                  <div className="codex-section-heading">
                    <span>2</span>
                    <div><strong>ChatGPT 账号</strong><small>登录和 token 刷新由 App Server 管理；AI Terminal 不读取或保存 token。</small></div>
                  </div>
                  {codexAppServer?.phase !== 'ready' && (
                    <p className="codex-empty-state">启动服务后即可在这里完成登录。</p>
                  )}
                  {codexAppServer?.phase === 'ready' && codexAppServer.pendingLogin && (
                    <div
                      className="codex-login-pending"
                      data-testid="codex-login-pending"
                      role="status"
                      aria-live="polite"
                    >
                      <strong>{codexAppServer.pendingLogin.type === 'browser'
                        ? '等待浏览器完成 ChatGPT 登录'
                        : '使用设备码完成登录'}</strong>
                      {codexAppServer.pendingLogin.type === 'device-code' && (
                        <div className="codex-device-code" data-testid="codex-device-code">
                          {codexAppServer.pendingLogin.userCode}
                        </div>
                      )}
                      <p>完成授权后，本页会自动刷新账号和模型，无需粘贴任何凭据。</p>
                      <div className="codex-actions">
                        <button
                          className="primary"
                          data-action="codex-open-auth"
                          disabled={codexBusy}
                          onClick={() => void runCodexAction(
                            () => window.aiTerminal.codexAppServer.reopenLogin(),
                          )}
                        >{codexAppServer.pendingLogin.type === 'browser'
                            ? '重新打开登录页'
                            : '打开验证页面'}</button>
                        <button
                          data-action="codex-cancel-login"
                          disabled={codexBusy}
                          onClick={() => void runCodexAction(
                            () => window.aiTerminal.codexAppServer.cancelLogin(),
                          )}
                        >取消登录</button>
                      </div>
                    </div>
                  )}
                  {codexAppServer?.phase === 'ready'
                    && !codexAppServer.pendingLogin
                    && codexAppServer.account && (
                    <div className="codex-account-card" data-testid="codex-account-status">
                      <div>
                        <strong>{codexAppServer.account.email ?? '已登录账号'}</strong>
                        <span>{codexAppServer.account.type === 'chatgpt' ? 'ChatGPT' : codexAppServer.account.type}
                          {codexAppServer.account.planType
                            ? ` · ${codexPlanTypeLabel(codexAppServer.account.planType)}`
                            : ''}</span>
                      </div>
                      <button
                        className="danger-text"
                        data-action="codex-logout"
                        disabled={codexBusy}
                        onClick={() => void runCodexAction(
                          () => window.aiTerminal.codexAppServer.logout(),
                          '已退出 App Server 账号。',
                        )}
                      >退出登录</button>
                    </div>
                  )}
                  {codexAppServer?.phase === 'ready'
                    && !codexAppServer.pendingLogin
                    && !codexAppServer.account
                    && codexAppServer.requiresOpenaiAuth === true && (
                    <div className="codex-login-options" data-testid="codex-account-status">
                      <p>尚未登录。请选择一种完全由界面引导的方式：</p>
                      <div className="codex-actions">
                        <button
                          className="primary"
                          data-action="codex-login-browser"
                          disabled={codexBusy}
                          onClick={() => void runCodexAction(
                            () => window.aiTerminal.codexAppServer.loginBrowser(),
                          )}
                        >使用 ChatGPT 登录</button>
                        <button
                          data-action="codex-login-device"
                          disabled={codexBusy}
                          onClick={() => void runCodexAction(
                            () => window.aiTerminal.codexAppServer.loginDeviceCode(),
                          )}
                        >使用设备码登录</button>
                      </div>
                    </div>
                  )}
                  {codexAppServer?.phase === 'ready'
                    && !codexAppServer.account
                    && codexAppServer.requiresOpenaiAuth === false && (
                    <div className="codex-account-card" data-testid="codex-account-status">
                      <div><strong>当前配置无需 OpenAI 登录</strong><span>App Server 报告可直接使用当前模型提供方。</span></div>
                    </div>
                  )}
                  {codexAppServer?.phase === 'ready'
                    && !codexAppServer.pendingLogin
                    && !codexAppServer.account
                    && codexAppServer.requiresOpenaiAuth === undefined && (
                    <p className="codex-empty-state">
                      账号状态尚未加载。请刷新状态；若持续失败，请重启服务。
                    </p>
                  )}
                </section>

                <section className="codex-setup-section">
                  <div className="codex-section-heading">
                    <span>3</span>
                    <div>
                      <strong>模型与首选项</strong>
                      <small>模型来自当前 App Server；保存后可供隔离实验后端使用，并在下次启动时恢复。</small>
                    </div>
                  </div>
                  {codexAppServer?.models.length ? (
                    <div className="codex-model-grid">
                      <label>模型
                        <select
                          data-testid="codex-model-select"
                          value={codexModelId}
                          onChange={(event) => selectCodexModel(event.target.value)}
                          disabled={codexBusy}
                        >
                          {codexAppServer.models.map((model) => (
                            <option key={model.id} value={model.id}>{model.displayName}</option>
                          ))}
                        </select>
                      </label>
                      <label>推理强度
                        <select
                          data-testid="codex-effort-select"
                          value={codexReasoningEffort}
                          onChange={(event) => setCodexReasoningEffort(event.target.value)}
                          disabled={codexBusy || !selectedCodexModel?.supportedReasoningEfforts.length}
                        >
                          {!selectedCodexModel?.supportedReasoningEfforts.length && (
                            <option value="">使用模型默认值</option>
                          )}
                          {selectedCodexModel?.supportedReasoningEfforts.map((effort) => (
                            <option key={effort.reasoningEffort} value={effort.reasoningEffort}>
                              {codexReasoningEffortLabel(effort.reasoningEffort)}
                              {effort.description ? ` · ${effort.description}` : ''}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        className="primary codex-bind"
                        data-action="codex-bind"
                        disabled={codexBusy || !selectedCodexModel || !codexSelectionDirty}
                        onClick={() => void saveCodexSelection()}
                      >保存 App Server 首选模型</button>
                      {codexSelectionSaved && (
                        <span className="codex-bound-badge" role="status">当前选择已保存</span>
                      )}
                      {codexSelectionDirty && (
                        <span className="codex-dirty-badge" role="status">有未保存更改</span>
                      )}
                    </div>
                  ) : (
                    <p className="codex-empty-state">{codexAppServer?.phase !== 'ready'
                      ? '服务就绪后将在这里显示可选模型。'
                      : codexAppServer.requiresOpenaiAuth === true && !codexAppServer.account
                        ? '登录完成后将自动加载可选模型。'
                        : codexAppServer.requiresOpenaiAuth === undefined
                          ? '模型状态尚未加载。请刷新状态。'
                          : 'App Server 当前没有返回可选模型。请刷新状态或检查 Codex 配置。'}</p>
                  )}
                </section>

                <section
                  className={`codex-setup-section codex-agent-isolation-card ${codexIsolation?.availability ?? 'unavailable'}`}
                  data-testid="codex-agent-isolation-card"
                  data-isolation-state={codexIsolation?.availability ?? 'unavailable'}
                >
                  <div className="codex-section-heading">
                    <span>4</span>
                    <div>
                      <strong>隔离 App Server Agent（实验）</strong>
                      <small>每次启动应用都需从界面重新确认隔离边界，之后才能把 App Server 选作当前智能体后端。</small>
                    </div>
                  </div>
                  <div
                    className="codex-agent-availability"
                    data-testid="codex-agent-availability"
                    data-isolation-state={codexIsolation?.availability ?? 'unavailable'}
                    role="status"
                    aria-live="polite"
                  >
                    <span className="codex-agent-state-dot" aria-hidden="true" />
                    <span>
                      <strong>{codexIsolation
                        ? codexAgentIsolationAvailabilityLabel(codexIsolation.availability)
                        : '正在读取状态'}</strong>
                      <small>{codexIsolation?.reason ?? '正在读取隔离能力状态。'}</small>
                    </span>
                  </div>

                  <div
                    id="codex-agent-boundary-description"
                    className="codex-safety-boundary codex-agent-boundary"
                    data-testid="codex-agent-boundary"
                  >
                    <strong>实际边界，不是“内建工具已被硬性关闭”</strong>
                    <p>
                      实验线程使用 <code>environments=[]</code>，并且客户端只注册
                      {' '}<code>{codexIsolation?.acceptedClientTools.join(' · ')
                        ?? 'terminal_read · terminal_state · terminal_execute'}</code>。
                    </p>
                    <ul>
                      <li>只有这些 <code>terminal_*</code> 动态工具会进入当前可见终端。</li>
                      <li>收到 App Server 内建命令、文件修改或权限请求时，客户端会拒绝并中断该轮。</li>
                      <li>官方协议并未保证模型不会尝试内建工具；若观察到越界执行事件，实验模式会锁停，执行结果标记为未知。</li>
                    </ul>
                  </div>

                  {codexIsolation?.lastViolation && (
                    <div
                      className="codex-agent-violation"
                      data-testid="codex-agent-violation"
                      role="alert"
                    >
                      <strong>检测到隔离边界违规，已锁停</strong>
                      <dl>
                        <div><dt>类型</dt><dd>{codexAgentIsolationViolationKindLabel(
                          codexIsolation.lastViolation.kind,
                        )}</dd></div>
                        <div><dt>时间</dt><dd><time dateTime={codexIsolation.lastViolation.detectedAt}>
                          {new Date(codexIsolation.lastViolation.detectedAt).toLocaleString('zh-CN')}
                        </time></dd></div>
                      </dl>
                      <p>{codexIsolation.lastViolation.detail}</p>
                      <small>已观察到边界事件，但无法据此证明是否产生副作用；结果按“未知”处理。</small>
                    </div>
                  )}

                  <div className="codex-actions codex-agent-actions">
                    {codexAgentEnabled ? (
                      <button
                        className="danger-text"
                        type="button"
                        data-action="codex-agent-disable"
                        disabled={codexBusy}
                        onClick={() => void setCodexAgentEnabled(false)}
                      >停用隔离实验后端</button>
                    ) : (
                      <button
                        className="primary"
                        type="button"
                        data-action={codexIsolation?.availability === 'blocked'
                          ? 'codex-agent-review-violation'
                          : 'codex-agent-enable'}
                        disabled={codexBusy || codexSelectionDirty || !codexAgentCanRequestEnable}
                        aria-describedby="codex-agent-boundary-description"
                        onClick={requestCodexAgentEnable}
                      >{codexIsolation?.availability === 'blocked'
                          ? '审阅并重新确认…'
                          : '启用实验模式…'}</button>
                    )}
                    {codexSelectionDirty && (
                      <span className="codex-agent-action-note">请先保存上方模型更改。</span>
                    )}
                  </div>
                </section>
              </div>
            )}

            {providerSettingsSection === 'generic' && (
              <div
                id="provider-panel-generic"
                className="generic-provider-panel"
                role="tabpanel"
                aria-labelledby="provider-kind-generic"
              >
                <section className="codex-app-server-note generic-provider-note">
                  <strong>OpenAI 兼容 API</strong>
                  <p>“可用”表示 Base URL、API Key 与模型列表测试通过。请勿在 API Key 输入框中粘贴 ChatGPT 登录凭据。</p>
                </section>
                <div className="provider-layout">
                  <div className="provider-list">
                    {providers.map((provider) => (
                      <button
                        className={editingProvider?.id === provider.id ? 'active' : ''}
                        key={provider.id}
                        onClick={() => {
                          setEditingProvider(provider);
                          setProviderMessage(null);
                        }}
                      >
                        <strong>{provider.name}</strong>
                        <small>{provider.modelId}</small>
                        <span className={`provider-status ${provider.status}`}>{providerStatusLabel(provider.status)}</span>
                      </button>
                    ))}
                    <button className="add-provider" onClick={() => {
                      setEditingProvider(null);
                      setProviderMessage(null);
                    }}>＋ 添加 Provider</button>
                  </div>
                  <form className="provider-form" onSubmit={(event) => void saveProvider(event)}>
                    <label>名称<input name="name" required defaultValue={editingProvider?.name ?? 'OpenAI 兼容 API'} key={`name-${editingProvider?.id ?? 'new'}`} /></label>
                    <label>基础 URL<input name="baseUrl" type="url" required placeholder="https://api.example.com/v1" defaultValue={editingProvider?.baseUrl ?? ''} key={`url-${editingProvider?.id ?? 'new'}`} /></label>
                    <label>模型 ID<input name="modelId" required placeholder="model-id" defaultValue={editingProvider?.modelId ?? ''} key={`model-${editingProvider?.id ?? 'new'}`} /></label>
                    <label>
                      API Key
                      <input
                        name="apiKey"
                        type="password"
                        required={!editingProvider?.apiKeyConfigured}
                        autoComplete="new-password"
                        placeholder={editingProvider?.apiKeyConfigured ? '已保存到 Windows 凭据管理器' : '必填'}
                      />
                    </label>
                    <label className="check-label">
                      <input name="makeDefault" type="checkbox" defaultChecked={editingProvider?.isDefault ?? providers.length === 0} />
                      设为默认 Provider
                    </label>
                    <p className="secure-note">API Key 作为 Windows 通用凭据保存；Provider JSON 只保存凭据引用。</p>
                    {providerMessage && <div className="provider-message">{providerMessage}</div>}
                    <div className="provider-actions">
                      {editingProvider && (
                        <>
                          <button type="button" onClick={() => void testProvider(editingProvider.id)}>测试连接</button>
                          {!editingProvider.isDefault && (
                            <button type="button" onClick={async () => {
                              await window.aiTerminal.providers.setDefault(editingProvider.id);
                              await refreshProviders();
                            }}>设为默认</button>
                          )}
                          <button className="danger-text" type="button" onClick={() => void removeProvider(editingProvider)}>删除</button>
                        </>
                      )}
                      <button className="primary" type="submit">保存 Provider</button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {codexAgentEnableChallenge && (
        <div className="modal-backdrop codex-agent-confirmation-backdrop">
          <div
            ref={codexAgentConfirmationRef}
            className="modal compact-modal codex-agent-confirmation"
            data-testid="codex-agent-confirmation"
            role="dialog"
            aria-modal="true"
            aria-labelledby="codex-agent-confirmation-title"
            aria-describedby="codex-agent-confirmation-description"
            tabIndex={-1}
          >
            <div className="modal-header">
              <strong id="codex-agent-confirmation-title">
                {codexIsolation?.availability === 'blocked'
                  ? '重新启用隔离 App Server Agent？'
                  : '启用隔离 App Server Agent（实验）？'}
              </strong>
            </div>
            <div id="codex-agent-confirmation-description">
              <p>启用后，AI Terminal 会按以下实验边界处理 App Server 智能体：</p>
              <ul>
                <li>向线程发送 <code>environments=[]</code>，并且只注册三个 <code>terminal_*</code> 动态工具。</li>
                <li>动态终端命令仍进入当前可见终端，并遵循逐条审批或你明确开启的“AI 全接管”。</li>
                <li>内建命令、文件修改和权限请求会被拒绝并中断；“AI 全接管”不会批准这些内建请求。</li>
                <li>协议没有提供“模型绝不会尝试内建工具”的保证。若观察到越界事件，模式会锁停，结果记为未知。</li>
                <li>实验授权只在本次应用运行内有效；重新启动后必须再次确认。</li>
              </ul>
              {codexIsolation?.lastViolation && (
                <p className="codex-agent-confirmation-warning">
                  上次违规：{codexAgentIsolationViolationKindLabel(
                    codexIsolation.lastViolation.kind,
                  )}。重新启用会清除锁停记录，但不会把未知结果改写为“已阻止”。
                </p>
              )}
            </div>
            <label className="codex-agent-confirm-check">
              <input
                type="checkbox"
                data-testid="codex-agent-opt-in"
                checked={codexAgentBoundaryAcknowledged}
                onChange={(event) => setCodexAgentBoundaryAcknowledged(event.target.checked)}
              />
              <span>我已理解这是实验隔离策略，而不是协议层硬性禁用全部内建工具。</span>
            </label>
            <div className="modal-actions">
              <button onClick={() => {
                setCodexAgentEnableChallenge(false);
                setCodexAgentBoundaryAcknowledged(false);
              }}>取消</button>
              <button
                className="danger-action"
                data-action="confirm-codex-agent-enable"
                disabled={
                  !codexAgentBoundaryAcknowledged
                  || codexBusy
                  || !codexAgentCanRequestEnable
                  || codexSelectionDirty
                }
                onClick={() => void setCodexAgentEnabled(true)}
              >确认并启用实验模式</button>
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
            <p>智能体已暂停。请选择如何处理仍在前台运行的命令。</p>
            <code>{activeAgent.activeExecution?.command ?? '前台命令'}</code>
            <div className="modal-actions split-actions">
              <button data-action="keep-process" onClick={() => void resolveAgentTakeover('keep')}>保持进程运行</button>
              <button className="danger-action" data-action="interrupt-process" onClick={() => void resolveAgentTakeover('interrupt')}>发送 Ctrl+C</button>
            </div>
          </div>
        </div>
      )}

      {fullTakeoverChallenge && (
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
            <p className="risk-note">
              {fullTakeoverChallenge.approvalId
                ? '确认后会立即执行下方命令；在关闭全接管或人工接管前，后续命令都不会再次询问。'
                : ''}
              仅对你信任的终端和任务启用。遇到认证提示时仍会暂停，并让你直接安全输入。
              {fullTakeoverChallenge.backend.kind === CODEX_APP_SERVER_AGENT_BACKEND
                ? ' 对隔离 App Server 后端，“全接管”只作用于 terminal_execute；内建请求仍会被拒绝并中断。'
                : ''}
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
            <div className="modal-header"><strong>信任此 SSH 主机？</strong></div>
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
