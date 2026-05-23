import {
  MarkdownBlock,
  MarkdownEditor,
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  usePluginData,
  usePluginToast,
  type PluginPageProps,
  type PluginRouteSidebarProps,
  type PluginSettingsPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  DEFAULT_TRIAGE_DEFAULT_STATE_KEY,
  DEFAULT_TRIAGE_QUEUE_STATES,
  DEFAULT_TRIAGE_QUEUE_TRANSITIONS,
} from "../workflow-defaults.js";

// ---------------------------------------------------------------------------
// Worker payload shapes (mirror @paperclipai/plugin-triage worker contracts).
// ---------------------------------------------------------------------------

type Queue = {
  id: string;
  companyId: string;
  queueKey: string;
  title: string;
  description: string | null;
  status: "active" | "archived";
  defaultStateKey: string;
  activeItemCount: number;
  archivedItemCount: number;
  createdAt: string;
  updatedAt: string;
};

type Item = {
  id: string;
  companyId: string;
  queueId: string;
  itemKey: string | null;
  idempotencyKey: string | null;
  title: string;
  contentFormat: string;
  content: string;
  properties: Record<string, unknown>;
  stateKey: string;
  status: "active" | "archived";
  linkedQueueChatId: string | null;
  linkedWorkIssueId: string | null;
  revision: number;
  lastIngestedAt: string;
  createdAt: string;
  updatedAt: string;
};

type GuidanceDoc = {
  id: string;
  companyId: string;
  queueId: string;
  path: string;
  title: string;
  status: "active" | "archived";
  currentRevisionId: string | null;
  content: string;
  contentHash: string | null;
  summary: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type GuidanceProposal = {
  id: string;
  companyId: string;
  queueId: string;
  itemId: string | null;
  targetDocId: string | null;
  status: "proposed" | "revised" | "accepted" | "rejected";
  proposedContent: string;
  rationale: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type ItemEvent = {
  id: string;
  eventType: string;
  fromStateKey: string | null;
  toStateKey: string | null;
  actorType: string | null;
  actorId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

type TransitionAction = {
  id: string;
  queueId: string;
  actionKey: string;
  fromStateKey: string;
  toStateKey: string;
  actionType: "create_or_update_issue";
  enabled: boolean;
  action: {
    type: "create_or_update_issue";
    mode: "create_if_missing" | "update_existing" | "create_or_update";
    template: Record<string, string>;
  };
  createdAt: string;
  updatedAt: string;
};

type ManagedResourceHealth = {
  status: "needs_company" | "missing" | "ready";
  checkedAt: string;
  agent: {
    resourceKey: string;
    status: string;
    agentId: string | null;
    name: string | null;
    agentStatus: string | null;
    adapterType: string | null;
  } | null;
  project: {
    resourceKey: string;
    status: string;
    projectId: string | null;
    name: string | null;
    projectStatus: string | null;
  } | null;
  skills: Array<{
    resourceKey: string;
    status: string;
    skillId: string | null;
    name: string | null;
    key: string | null;
  }>;
};

// ---------------------------------------------------------------------------
// Design tokens & primitives.
// ---------------------------------------------------------------------------

export const tokens = {
  border: "var(--border, oklch(0.86 0 0))",
  borderSubtle: "var(--border, oklch(0.92 0 0))",
  bg: "var(--background, #ffffff)",
  card: "var(--card, #ffffff)",
  fg: "var(--foreground, #18181b)",
  muted: "var(--muted-foreground, #71717a)",
  mutedBg: "var(--muted, #f4f4f5)",
  accent: "var(--accent, #f4f4f5)",
  accentFg: "var(--accent-foreground, #18181b)",
  primary: "var(--primary, #18181b)",
  primaryFg: "var(--primary-foreground, #ffffff)",
  destructive: "var(--destructive, oklch(0.637 0.237 25.331))",
  success: "oklch(0.55 0.13 155)",
  warning: "oklch(0.64 0.14 75)",
  info: "oklch(0.6 0.13 240)",
};

const fontStack = `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
const monoStack = `ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace`;

const pageShell: CSSProperties = {
  display: "grid",
  gap: 16,
  padding: 24,
  color: tokens.fg,
  background: tokens.bg,
  minHeight: "100%",
  fontFamily: fontStack,
};

const panelStyle: CSSProperties = {
  border: `1px solid ${tokens.border}`,
  borderRadius: 8,
  padding: 16,
  display: "grid",
  gap: 12,
  background: tokens.card,
};

const mutedStyle: CSSProperties = {
  color: tokens.muted,
  fontSize: 13,
};

const sectionHeading: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: 0.6,
  textTransform: "uppercase",
  color: tokens.muted,
};

// ---------------------------------------------------------------------------
// Lightweight primitives (in-tree so we don't depend on host shadcn).
// ---------------------------------------------------------------------------

type ButtonVariant = "default" | "primary" | "ghost" | "destructive" | "outline";

function buttonStyle(variant: ButtonVariant, disabled: boolean): CSSProperties {
  const base: CSSProperties = {
    border: `1px solid ${tokens.border}`,
    borderRadius: 6,
    padding: "6px 10px",
    fontSize: 13,
    fontWeight: 500,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    background: tokens.card,
    color: tokens.fg,
    fontFamily: fontStack,
    lineHeight: 1.2,
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
  };
  if (variant === "primary") {
    return { ...base, background: tokens.primary, color: tokens.primaryFg, borderColor: tokens.primary, fontWeight: 600 };
  }
  if (variant === "destructive") {
    return { ...base, background: "transparent", color: tokens.destructive, borderColor: tokens.destructive };
  }
  if (variant === "ghost") {
    return { ...base, background: "transparent", border: "1px solid transparent", color: tokens.fg };
  }
  if (variant === "outline") {
    return { ...base, background: "transparent" };
  }
  return base;
}

function Button({
  variant = "default",
  disabled,
  onClick,
  children,
  type = "button",
  title,
  style,
  ariaLabel,
}: {
  variant?: ButtonVariant;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
  type?: "button" | "submit";
  title?: string;
  style?: CSSProperties;
  ariaLabel?: string;
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      style={{ ...buttonStyle(variant, Boolean(disabled)), ...style }}
    >
      {children}
    </button>
  );
}

function Pill({ tone = "default", children }: { tone?: "default" | "success" | "warning" | "info" | "muted"; children: ReactNode }) {
  const palette: Record<string, { bg: string; fg: string; border?: string }> = {
    default: { bg: tokens.mutedBg, fg: tokens.fg },
    muted: { bg: "transparent", fg: tokens.muted, border: tokens.border },
    success: { bg: "oklch(0.93 0.06 155)", fg: "oklch(0.36 0.13 155)" },
    warning: { bg: "oklch(0.95 0.06 75)", fg: "oklch(0.4 0.12 75)" },
    info: { bg: "oklch(0.95 0.05 240)", fg: "oklch(0.4 0.12 240)" },
  };
  const t = palette[tone] ?? palette.default;
  return (
    <span
      style={{
        background: t.bg,
        color: t.fg,
        border: t.border ? `1px solid ${t.border}` : undefined,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.4,
        textTransform: "uppercase",
        borderRadius: 999,
        padding: "2px 8px",
        display: "inline-flex",
        alignItems: "center",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      style={{
        border: `1px solid ${tokens.destructive}`,
        borderRadius: 6,
        padding: "8px 10px",
        color: tokens.destructive,
        fontSize: 13,
        background: "oklch(0.97 0.04 25)",
      }}
    >
      {message}
    </div>
  );
}

function EmptyState({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div
      style={{
        border: `1px dashed ${tokens.border}`,
        borderRadius: 8,
        padding: 24,
        display: "grid",
        gap: 8,
        justifyItems: "start",
        color: tokens.muted,
        background: tokens.bg,
      }}
    >
      <strong style={{ color: tokens.fg, fontSize: 14 }}>{title}</strong>
      {body ? <div style={{ fontSize: 13 }}>{body}</div> : null}
      {action ? <div>{action}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Route helpers — drive view selection from the host pathname.
// ---------------------------------------------------------------------------

type TriageRoute =
  | { kind: "home" }
  | { kind: "queue"; queueKey: string }
  | { kind: "item"; queueKey: string; itemId: string }
  | { kind: "workflow"; queueKey: string }
  | { kind: "guidance"; queueKey: string }
  | { kind: "transitions"; queueKey: string };

export function parseTriageRoute(pathname: string): TriageRoute {
  // Strip company prefix so we operate on segments after `triage`.
  const segments = pathname.split("/").filter(Boolean);
  const idx = segments.findIndex((seg) => seg === "triage");
  if (idx === -1) return { kind: "home" };
  const rest = segments.slice(idx + 1);
  if (rest.length === 0) return { kind: "home" };
  if (rest[0] === "q" && rest[1]) {
    const queueKey = decodeURIComponent(rest[1]);
    if (rest[2] === "i" && rest[3]) {
      return { kind: "item", queueKey, itemId: decodeURIComponent(rest[3]) };
    }
    if (rest[2] === "workflow") return { kind: "workflow", queueKey };
    if (rest[2] === "guidance") return { kind: "guidance", queueKey };
    if (rest[2] === "transitions") return { kind: "transitions", queueKey };
    return { kind: "queue", queueKey };
  }
  return { kind: "home" };
}

function queueLink(queueKey: string): string {
  return `/triage/q/${encodeURIComponent(queueKey)}`;
}

function itemLink(queueKey: string, itemId: string): string {
  return `${queueLink(queueKey)}/i/${encodeURIComponent(itemId)}`;
}

// ---------------------------------------------------------------------------
// Data hooks.
// ---------------------------------------------------------------------------

function useQueues(companyId: string | null) {
  const params = useMemo(() => ({ companyId: companyId ?? "" }), [companyId]);
  return usePluginData<Queue[]>(companyId ? "queues" : "__noop__", params);
}

function useQueue(companyId: string | null, queueKey: string | null) {
  const params = useMemo(() => ({ companyId: companyId ?? "", queueKey: queueKey ?? "" }), [companyId, queueKey]);
  return usePluginData<Queue>(companyId && queueKey ? "queue" : "__noop__", params);
}

function useQueueItems(companyId: string | null, queueKey: string | null) {
  const params = useMemo(() => ({ companyId: companyId ?? "", queueKey: queueKey ?? "" }), [companyId, queueKey]);
  return usePluginData<Item[]>(companyId && queueKey ? "queue-items" : "__noop__", params);
}

function useItem(companyId: string | null, itemId: string | null) {
  const params = useMemo(() => ({ companyId: companyId ?? "", itemId: itemId ?? "" }), [companyId, itemId]);
  return usePluginData<Item>(companyId && itemId ? "queue-item" : "__noop__", params);
}

function useGuidance(companyId: string | null, queueKey: string | null) {
  const params = useMemo(() => ({ companyId: companyId ?? "", queueKey: queueKey ?? "" }), [companyId, queueKey]);
  return usePluginData<GuidanceDoc[]>(companyId && queueKey ? "queue-guidance" : "__noop__", params);
}

function useGuidanceProposals(companyId: string | null, queueKey: string | null) {
  const params = useMemo(() => ({ companyId: companyId ?? "", queueKey: queueKey ?? "" }), [companyId, queueKey]);
  return usePluginData<GuidanceProposal[]>(companyId && queueKey ? "guidance-proposals" : "__noop__", params);
}

function useItemEvents(companyId: string | null, itemId: string | null) {
  const params = useMemo(() => ({ companyId: companyId ?? "", itemId: itemId ?? "" }), [companyId, itemId]);
  return usePluginData<ItemEvent[]>(companyId && itemId ? "item-events" : "__noop__", params);
}

function useTransitionActions(companyId: string | null, queueKey: string | null) {
  const params = useMemo(() => ({ companyId: companyId ?? "", queueKey: queueKey ?? "" }), [companyId, queueKey]);
  return usePluginData<TransitionAction[]>(companyId && queueKey ? "queue-transition-actions" : "__noop__", params);
}

function useManagedResourceHealth(companyId: string | null) {
  const params = useMemo(() => ({ companyId: companyId ?? "" }), [companyId]);
  return usePluginData<ManagedResourceHealth>("managed-resource-health", params);
}

// ---------------------------------------------------------------------------
// Default workflow used for v1: Draft → Approved/Rejected → Done.
// State keys come from `src/workflow-defaults.ts`, which is also the source
// for `triage.ts` seeding and the SQL migration's column default. The UI
// layers on presentational tone + button copy below.
// ---------------------------------------------------------------------------

type StateTone = "default" | "info" | "success" | "warning" | "muted";

const STATE_TONES: Record<string, StateTone> = {
  draft: "info",
  approved: "success",
  rejected: "warning",
  done: "muted",
};

const TRANSITION_BUTTON_LABELS: Record<string, string> = {
  "draft->approved": "Approve",
  "draft->rejected": "Reject",
  "approved->done": "Mark done",
  "rejected->done": "Archive",
};

const DEFAULT_STATE_DEFS = DEFAULT_TRIAGE_QUEUE_STATES.map((state) => ({
  stateKey: state.stateKey,
  label: state.displayName,
  terminal: state.isTerminal,
  tone: STATE_TONES[state.stateKey] ?? "default",
}));

const DEFAULT_TRANSITIONS = DEFAULT_TRIAGE_QUEUE_TRANSITIONS.map((transition) => ({
  fromStateKey: transition.fromStateKey,
  toStateKey: transition.toStateKey,
  label: TRANSITION_BUTTON_LABELS[`${transition.fromStateKey}->${transition.toStateKey}`] ?? transition.label,
}));

function stateLabel(stateKey: string): string {
  const def = DEFAULT_STATE_DEFS.find((s) => s.stateKey === stateKey);
  return def ? def.label : stateKey;
}

function stateTone(stateKey: string): StateTone {
  const def = DEFAULT_STATE_DEFS.find((s) => s.stateKey === stateKey);
  return def ? def.tone : "default";
}

function allowedTransitions(fromStateKey: string) {
  return DEFAULT_TRANSITIONS.filter((t) => t.fromStateKey === fromStateKey);
}

// ---------------------------------------------------------------------------
// Sidebar link slot.
// ---------------------------------------------------------------------------

const triageSidebarIcon = (
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ width: 16, height: 16, display: "block", flexShrink: 0 }}
  >
    <path d="M8 6h13" />
    <path d="M8 12h13" />
    <path d="M8 18h13" />
    <path d="M3 6h.01" />
    <path d="M3 12h.01" />
    <path d="M3 18h.01" />
  </svg>
);

export function SidebarLink({ context }: PluginSidebarProps) {
  const nav = useHostNavigation();
  const location = useHostLocation();
  const active = location.pathname.split("/").filter(Boolean).includes("triage");
  return (
    <a
      {...nav.linkProps("/triage")}
      style={{
        color: "inherit",
        textDecoration: "none",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        fontSize: 13,
        fontWeight: 500,
        background: active ? tokens.accent : "transparent",
      }}
      data-triage-sidebar-active={active ? "true" : "false"}
      aria-label={`Open Triage for ${context.companyPrefix ?? "company"}`}
    >
      {triageSidebarIcon}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Triage</span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// Route sidebar — queue navigation + queue-scoped section links.
// ---------------------------------------------------------------------------

export function TriageRouteSidebar({ context }: PluginRouteSidebarProps) {
  const nav = useHostNavigation();
  const { pathname } = useHostLocation();
  const route = useMemo(() => parseTriageRoute(pathname), [pathname]);
  const { data: queues, loading, error } = useQueues(context.companyId);
  const activeQueueKey = route.kind === "home" ? null : route.queueKey;
  const sortedQueues = useMemo(() => {
    const list = (queues ?? []).slice();
    list.sort((a, b) => {
      if (a.status !== b.status) return a.status === "archived" ? 1 : -1;
      return a.queueKey.localeCompare(b.queueKey);
    });
    return list;
  }, [queues]);

  return (
    <aside
      style={{
        padding: 12,
        display: "grid",
        gap: 14,
        alignContent: "start",
        color: tokens.fg,
        background: tokens.bg,
        fontFamily: fontStack,
        height: "100%",
        overflowY: "auto",
      }}
    >
      <div style={{ display: "grid", gap: 6 }}>
        <a
          {...nav.linkProps("/triage")}
          style={{ color: "inherit", textDecoration: "none", fontWeight: 700, fontSize: 14 }}
        >
          Triage
        </a>
        <div style={mutedStyle}>Queue workbench</div>
      </div>

      <div style={{ display: "grid", gap: 6 }}>
        <div style={sectionHeading}>Queues</div>
        {loading ? <div style={mutedStyle}>Loading…</div> : null}
        {error ? <ErrorBanner message={error.message} /> : null}
        {!loading && sortedQueues.length === 0 ? <div style={mutedStyle}>No queues yet</div> : null}
        <nav style={{ display: "grid", gap: 2 }} aria-label="Queues">
          {sortedQueues.map((queue) => (
            <a
              key={queue.id}
              {...nav.linkProps(queueLink(queue.queueKey))}
              style={{
                color: "inherit",
                textDecoration: "none",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "6px 8px",
                borderRadius: 6,
                fontSize: 13,
                background: activeQueueKey === queue.queueKey ? tokens.accent : "transparent",
              }}
              aria-current={activeQueueKey === queue.queueKey ? "page" : undefined}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                {queue.status === "archived" ? <span style={{ color: tokens.muted }}>·</span> : null}
                <span>{queue.queueKey}</span>
              </span>
              <span style={{ color: tokens.muted, fontSize: 12 }}>{queue.activeItemCount}</span>
            </a>
          ))}
        </nav>
      </div>

      {activeQueueKey ? (
        <div style={{ display: "grid", gap: 6, borderTop: `1px solid ${tokens.border}`, paddingTop: 10 }}>
          <div style={sectionHeading}>{activeQueueKey}</div>
          <a {...nav.linkProps(queueLink(activeQueueKey))} style={{ color: "inherit", textDecoration: "none", fontSize: 13, padding: "4px 0" }}>
            Items
          </a>
          <a {...nav.linkProps(`${queueLink(activeQueueKey)}/workflow`)} style={{ color: "inherit", textDecoration: "none", fontSize: 13, padding: "4px 0" }}>
            Workflow
          </a>
          <a {...nav.linkProps(`${queueLink(activeQueueKey)}/guidance`)} style={{ color: "inherit", textDecoration: "none", fontSize: 13, padding: "4px 0" }}>
            Guidance
          </a>
          <a {...nav.linkProps(`${queueLink(activeQueueKey)}/transitions`)} style={{ color: "inherit", textDecoration: "none", fontSize: 13, padding: "4px 0" }}>
            Transition actions
          </a>
        </div>
      ) : null}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Top-level page slot — routes between home/queue/item views.
// ---------------------------------------------------------------------------

export function TriagePage({ context }: PluginPageProps) {
  const { pathname } = useHostLocation();
  const route = useMemo(() => parseTriageRoute(pathname), [pathname]);
  const companyId = context.companyId;

  if (!companyId) {
    return (
      <main style={pageShell}>
        <EmptyState title="No active company" body="Pick a company to use Paperclip Triage." />
      </main>
    );
  }

  if (route.kind === "home") {
    return <QueueListPage companyId={companyId} />;
  }
  if (route.kind === "queue") {
    return <QueueOverviewPage companyId={companyId} queueKey={route.queueKey} />;
  }
  if (route.kind === "item") {
    return <ItemWorkbenchPage companyId={companyId} queueKey={route.queueKey} itemId={route.itemId} />;
  }
  if (route.kind === "workflow") {
    return <WorkflowPage companyId={companyId} queueKey={route.queueKey} />;
  }
  if (route.kind === "guidance") {
    return <GuidancePage companyId={companyId} queueKey={route.queueKey} />;
  }
  return <TransitionActionsPage companyId={companyId} queueKey={route.queueKey} />;
}

// ---------------------------------------------------------------------------
// Queue list page — overview + create-queue form.
// ---------------------------------------------------------------------------

function QueueListPage({ companyId }: { companyId: string }) {
  const queues = useQueues(companyId);
  const createQueue = usePluginAction("create-queue");
  const archiveQueue = usePluginAction("archive-queue");
  const toast = usePluginToast();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ queueKey: "", title: "", description: "" });

  async function handleCreate() {
    setError(null);
    setBusy(true);
    try {
      await createQueue({
        companyId,
        queueKey: draft.queueKey,
        title: draft.title || undefined,
        description: draft.description || undefined,
      });
      setDraft({ queueKey: "", title: "", description: "" });
      setCreating(false);
      queues.refresh();
      toast({ title: `Queue ${draft.queueKey} created`, tone: "success" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create queue");
    } finally {
      setBusy(false);
    }
  }

  async function handleArchive(queue: Queue) {
    setError(null);
    try {
      await archiveQueue({ companyId, queueKey: queue.queueKey });
      queues.refresh();
      toast({ title: `Queue ${queue.queueKey} archived`, tone: "success" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to archive queue");
    }
  }

  const list = (queues.data ?? []).slice().sort((a, b) => {
    if (a.status !== b.status) return a.status === "archived" ? 1 : -1;
    return a.queueKey.localeCompare(b.queueKey);
  });

  return (
    <main style={pageShell}>
      <header style={{ display: "grid", gap: 4 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Triage</h1>
        <div style={mutedStyle}>Queue workbench · teach an assistant by processing items</div>
      </header>

      <section style={panelStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16 }}>Queues</h2>
            <div style={mutedStyle}>{list.length === 0 ? "No queues yet" : `${list.length} ${list.length === 1 ? "queue" : "queues"}`}</div>
          </div>
          <Button variant="primary" onClick={() => setCreating((v) => !v)}>
            {creating ? "Cancel" : "+ New queue"}
          </Button>
        </div>

        <ErrorBanner message={queues.error?.message ?? error} />

        {creating ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy && draft.queueKey.trim()) void handleCreate();
            }}
            style={{ display: "grid", gap: 8, border: `1px solid ${tokens.border}`, borderRadius: 6, padding: 12 }}
          >
            <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
              <span style={{ fontWeight: 600 }}>Queue key</span>
              <input
                type="text"
                value={draft.queueKey}
                onChange={(event) => setDraft((d) => ({ ...d, queueKey: event.target.value }))}
                placeholder="e.g. inbox, drafts, reviews"
                required
                style={{
                  padding: "6px 8px",
                  border: `1px solid ${tokens.border}`,
                  borderRadius: 6,
                  fontFamily: monoStack,
                  fontSize: 13,
                  background: tokens.card,
                  color: tokens.fg,
                }}
              />
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
              <span style={{ fontWeight: 600 }}>Display title (optional)</span>
              <input
                type="text"
                value={draft.title}
                onChange={(event) => setDraft((d) => ({ ...d, title: event.target.value }))}
                placeholder="Defaults to a Title Case version of the key"
                style={{ padding: "6px 8px", border: `1px solid ${tokens.border}`, borderRadius: 6, fontSize: 13, background: tokens.card, color: tokens.fg }}
              />
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
              <span style={{ fontWeight: 600 }}>Description (optional)</span>
              <textarea
                value={draft.description}
                onChange={(event) => setDraft((d) => ({ ...d, description: event.target.value }))}
                rows={3}
                placeholder="What kind of items live here?"
                style={{ padding: "6px 8px", border: `1px solid ${tokens.border}`, borderRadius: 6, fontSize: 13, fontFamily: fontStack, background: tokens.card, color: tokens.fg, resize: "vertical" }}
              />
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <Button variant="primary" type="submit" disabled={busy || !draft.queueKey.trim()}>
                {busy ? "Creating…" : "Create queue"}
              </Button>
              <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            </div>
          </form>
        ) : null}

        {queues.loading ? <div style={mutedStyle}>Loading queues…</div> : null}

        {!queues.loading && list.length === 0 && !creating ? (
          <EmptyState
            title="Create your first queue"
            body="A queue groups items by workflow. Start with one for an inbox, drafts, or reviews."
            action={<Button variant="primary" onClick={() => setCreating(true)}>+ New queue</Button>}
          />
        ) : null}

        {list.length > 0 ? (
          <div style={{ display: "grid", gap: 8 }}>
            {list.map((queue) => (
              <QueueCard key={queue.id} queue={queue} onArchive={() => void handleArchive(queue)} />
            ))}
          </div>
        ) : null}
      </section>
    </main>
  );
}

function QueueCard({ queue, onArchive }: { queue: Queue; onArchive: () => void }) {
  const nav = useHostNavigation();
  return (
    <div
      style={{
        border: `1px solid ${tokens.border}`,
        borderRadius: 6,
        padding: 12,
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: 12,
        alignItems: "center",
        background: tokens.card,
      }}
    >
      <div style={{ display: "grid", gap: 4 }}>
        <a
          {...nav.linkProps(queueLink(queue.queueKey))}
          style={{ color: "inherit", textDecoration: "none", display: "inline-flex", gap: 8, alignItems: "center" }}
        >
          <strong style={{ fontSize: 15 }}>{queue.title}</strong>
          <span style={{ color: tokens.muted, fontFamily: monoStack, fontSize: 12 }}>{queue.queueKey}</span>
          {queue.status === "archived" ? <Pill tone="muted">archived</Pill> : null}
        </a>
        {queue.description ? <div style={{ fontSize: 13, color: tokens.muted }}>{queue.description}</div> : null}
        <div style={{ display: "flex", gap: 12, fontSize: 12, color: tokens.muted }}>
          <span>{queue.activeItemCount} active</span>
          <span>{queue.archivedItemCount} archived</span>
          <span>state default: {stateLabel(queue.defaultStateKey)}</span>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <a
          {...nav.linkProps(queueLink(queue.queueKey))}
          style={{ ...buttonStyle("outline", false), textDecoration: "none" }}
        >
          Open
        </a>
        {queue.status === "active" ? (
          <Button variant="ghost" onClick={onArchive} ariaLabel={`Archive queue ${queue.queueKey}`}>
            Archive
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Queue overview — header + item list.
// ---------------------------------------------------------------------------

function QueueHeader({
  companyId,
  queueKey,
  queue,
  active,
}: {
  companyId: string;
  queueKey: string;
  queue: Queue | null | undefined;
  active: "items" | "workflow" | "guidance" | "transitions";
}) {
  const nav = useHostNavigation();
  const tabs: Array<{ key: typeof active; label: string; href: string }> = [
    { key: "items", label: "Items", href: queueLink(queueKey) },
    { key: "workflow", label: "Workflow", href: `${queueLink(queueKey)}/workflow` },
    { key: "guidance", label: "Guidance", href: `${queueLink(queueKey)}/guidance` },
    { key: "transitions", label: "Transition actions", href: `${queueLink(queueKey)}/transitions` },
  ];
  return (
    <header style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, color: tokens.muted }}>
        <a {...nav.linkProps("/triage")} style={{ color: "inherit", textDecoration: "none" }}>Triage</a>
        <span aria-hidden>/</span>
        <span style={{ color: tokens.fg, fontWeight: 600 }}>{queue?.title ?? queueKey}</span>
      </div>
      <h1 style={{ margin: 0, fontSize: 22 }}>{queue?.title ?? queueKey}</h1>
      {queue?.description ? <div style={mutedStyle}>{queue.description}</div> : null}
      <nav style={{ display: "flex", gap: 4, marginTop: 4 }} aria-label="Queue sections">
        {tabs.map((tab) => (
          <a
            key={tab.key}
            {...nav.linkProps(tab.href)}
            aria-current={active === tab.key ? "page" : undefined}
            style={{
              color: active === tab.key ? tokens.fg : tokens.muted,
              borderBottom: active === tab.key ? `2px solid ${tokens.primary}` : "2px solid transparent",
              padding: "4px 8px",
              fontSize: 13,
              fontWeight: active === tab.key ? 600 : 500,
              textDecoration: "none",
            }}
          >
            {tab.label}
          </a>
        ))}
      </nav>
      <div style={{ display: "none" }}>{companyId}</div>
    </header>
  );
}

function QueueOverviewPage({ companyId, queueKey }: { companyId: string; queueKey: string }) {
  const nav = useHostNavigation();
  const queue = useQueue(companyId, queueKey);
  const items = useQueueItems(companyId, queueKey);

  const sortedItems = useMemo(() => {
    const list = (items.data ?? []).slice();
    list.sort((a, b) => {
      if (a.status !== b.status) return a.status === "archived" ? 1 : -1;
      return new Date(b.lastIngestedAt).getTime() - new Date(a.lastIngestedAt).getTime();
    });
    return list;
  }, [items.data]);

  const grouped = useMemo(() => {
    const groups = new Map<string, Item[]>();
    for (const item of sortedItems) {
      const key = item.status === "archived" ? "archived" : item.stateKey;
      const arr = groups.get(key) ?? [];
      arr.push(item);
      groups.set(key, arr);
    }
    return groups;
  }, [sortedItems]);

  const stateOrder = [...DEFAULT_STATE_DEFS.map((s) => s.stateKey), "archived"];
  const orderedKeys = stateOrder.filter((key) => grouped.has(key));

  return (
    <main style={pageShell}>
      <QueueHeader companyId={companyId} queueKey={queueKey} queue={queue.data ?? null} active="items" />

      <ErrorBanner message={queue.error?.message ?? items.error?.message ?? null} />

      {items.loading ? <div style={mutedStyle}>Loading items…</div> : null}

      {!items.loading && sortedItems.length === 0 ? (
        <EmptyState
          title="No items yet"
          body={
            <span>
              Post items into <code style={{ fontFamily: monoStack }}>{queueKey}</code> via the minimal ingest API to begin triaging.
            </span>
          }
        />
      ) : null}

      {orderedKeys.map((stateKey) => {
        const groupItems = grouped.get(stateKey) ?? [];
        if (groupItems.length === 0) return null;
        const label = stateKey === "archived" ? "Archived" : stateLabel(stateKey);
        const tone = stateKey === "archived" ? "muted" : stateTone(stateKey);
        return (
          <section key={stateKey} style={{ ...panelStyle, padding: 0 }}>
            <div
              style={{
                padding: "10px 14px",
                borderBottom: `1px solid ${tokens.border}`,
                display: "flex",
                gap: 8,
                alignItems: "center",
              }}
            >
              <Pill tone={tone}>{label}</Pill>
              <span style={mutedStyle}>{groupItems.length}</span>
            </div>
            <div role="list">
              {groupItems.map((item, index) => (
                <a
                  key={item.id}
                  role="listitem"
                  {...nav.linkProps(itemLink(queueKey, item.id))}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    gap: 10,
                    padding: "10px 14px",
                    borderTop: index === 0 ? "none" : `1px solid ${tokens.borderSubtle}`,
                    color: "inherit",
                    textDecoration: "none",
                    background: tokens.card,
                  }}
                >
                  <div style={{ display: "grid", gap: 2 }}>
                    <strong style={{ fontSize: 14 }}>{item.title}</strong>
                    <span style={{ color: tokens.muted, fontSize: 12 }}>
                      {item.itemKey ? `key ${item.itemKey} · ` : ""}rev {item.revision} · updated {formatRelative(item.updatedAt)}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    {item.linkedWorkIssueId ? <Pill tone="info">linked issue</Pill> : null}
                  </div>
                </a>
              ))}
            </div>
          </section>
        );
      })}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Item workbench — two-column: chat (center/left) + item editor (right).
// ---------------------------------------------------------------------------

function ItemWorkbenchPage({ companyId, queueKey, itemId }: { companyId: string; queueKey: string; itemId: string }) {
  const nav = useHostNavigation();
  const queue = useQueue(companyId, queueKey);
  const itemQuery = useItem(companyId, itemId);
  const guidance = useGuidance(companyId, queueKey);
  const proposals = useGuidanceProposals(companyId, queueKey);
  const events = useItemEvents(companyId, itemId);

  return (
    <main
      style={{
        ...pageShell,
        gap: 12,
        padding: 16,
        display: "grid",
        gridTemplateRows: "auto 1fr",
        minHeight: "calc(100vh - 80px)",
      }}
    >
      <div style={{ display: "grid", gap: 8 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, color: tokens.muted, flexWrap: "wrap" }}>
          <a {...nav.linkProps("/triage")} style={{ color: "inherit", textDecoration: "none" }}>Triage</a>
          <span aria-hidden>/</span>
          <a {...nav.linkProps(queueLink(queueKey))} style={{ color: "inherit", textDecoration: "none" }}>
            {queue.data?.title ?? queueKey}
          </a>
          <span aria-hidden>/</span>
          <span style={{ color: tokens.fg, fontWeight: 600 }}>{itemQuery.data?.title ?? "Item"}</span>
          {itemQuery.data ? <Pill tone={stateTone(itemQuery.data.stateKey)}>{stateLabel(itemQuery.data.stateKey)}</Pill> : null}
        </div>

        <ErrorBanner message={queue.error?.message ?? itemQuery.error?.message ?? null} />

        {itemQuery.data ? (
          <TransitionBar
            companyId={companyId}
            item={itemQuery.data}
            onChanged={() => {
              itemQuery.refresh();
              events.refresh();
            }}
          />
        ) : null}
      </div>

      {!itemQuery.data ? (
        <div style={mutedStyle}>Loading item…</div>
      ) : (
        <WorkbenchTwoColumn
          companyId={companyId}
          item={itemQuery.data}
          guidance={guidance.data ?? []}
          proposals={proposals.data ?? []}
          events={events.data ?? []}
          refreshItem={() => {
            itemQuery.refresh();
            events.refresh();
          }}
          refreshGuidance={() => {
            guidance.refresh();
            proposals.refresh();
          }}
        />
      )}
    </main>
  );
}

function TransitionBar({
  companyId,
  item,
  onChanged,
}: {
  companyId: string;
  item: Item;
  onChanged: () => void;
}) {
  const transition = usePluginAction("transition-item");
  const toast = usePluginToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const transitions = allowedTransitions(item.stateKey);

  async function handleTransition(toStateKey: string) {
    setError(null);
    setBusy(toStateKey);
    try {
      await transition({ companyId, itemId: item.id, toStateKey });
      onChanged();
      toast({ title: `Item moved to ${stateLabel(toStateKey)}`, tone: "success" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to transition item");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 12px",
        border: `1px solid ${tokens.border}`,
        borderRadius: 6,
        flexWrap: "wrap",
        background: tokens.card,
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "center", color: tokens.muted, fontSize: 13 }}>
        <span>State:</span>
        <Pill tone={stateTone(item.stateKey)}>{stateLabel(item.stateKey)}</Pill>
        {item.linkedWorkIssueId ? <span style={mutedStyle}>linked issue {item.linkedWorkIssueId.slice(0, 8)}</span> : null}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {transitions.length === 0 ? <span style={mutedStyle}>No further transitions</span> : null}
        {transitions.map((t) => {
          const isPrimary = t.toStateKey === "approved" || t.toStateKey === "done";
          return (
            <Button
              key={t.toStateKey}
              variant={isPrimary ? "primary" : "outline"}
              disabled={busy !== null}
              onClick={() => void handleTransition(t.toStateKey)}
            >
              {busy === t.toStateKey ? `${t.label}…` : t.label}
            </Button>
          );
        })}
      </div>
      {error ? <ErrorBanner message={error} /> : null}
    </div>
  );
}

function WorkbenchTwoColumn({
  companyId,
  item,
  guidance,
  proposals,
  events,
  refreshItem,
  refreshGuidance,
}: {
  companyId: string;
  item: Item;
  guidance: GuidanceDoc[];
  proposals: GuidanceProposal[];
  events: ItemEvent[];
  refreshItem: () => void;
  refreshGuidance: () => void;
}) {
  const [mobileTab, setMobileTab] = useState<"chat" | "document">("document");

  return (
    <div
      style={{
        display: "grid",
        gap: 12,
        minHeight: 0,
        // Two equal columns on desktop, stacked tabs on narrow viewports.
        // CSS Grid handles this with media-style fallback via auto-fr.
        gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
      }}
      data-triage-workbench
    >
      {/* Mobile tab switch: hidden on desktop via inline check */}
      <div
        style={{
          gridColumn: "1 / -1",
          display: "none",
          gap: 6,
          padding: "0 0 4px",
        }}
        data-triage-workbench-tabs
      >
        <Button variant={mobileTab === "chat" ? "primary" : "outline"} onClick={() => setMobileTab("chat")}>Chat</Button>
        <Button variant={mobileTab === "document" ? "primary" : "outline"} onClick={() => setMobileTab("document")}>Document</Button>
      </div>

      <div
        style={{ display: "grid", gap: 12, minHeight: 0 }}
        data-triage-workbench-pane="chat"
        data-mobile-active={mobileTab === "chat" ? "true" : "false"}
      >
        <ChatPanel companyId={companyId} item={item} onSent={() => refreshItem()} />
        <GuidanceSidePanel
          companyId={companyId}
          item={item}
          guidance={guidance}
          proposals={proposals}
          refresh={refreshGuidance}
        />
      </div>

      <div
        style={{ display: "grid", gap: 12, minHeight: 0 }}
        data-triage-workbench-pane="document"
        data-mobile-active={mobileTab === "document" ? "true" : "false"}
      >
        <ItemEditor companyId={companyId} item={item} onSaved={refreshItem} />
        <LinkedIssuePanel item={item} />
        <ItemEventsPanel events={events} />
      </div>

      {/* tiny stylesheet for narrow viewport tab switcher; no JS dep */}
      <style>{`
        @media (max-width: 900px) {
          [data-triage-workbench] { grid-template-columns: minmax(0, 1fr) !important; }
          [data-triage-workbench-tabs] { display: flex !important; }
          [data-triage-workbench-pane][data-mobile-active="false"] { display: none !important; }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat panel — slim assistant chat with pinned item context strip + composer.
// ---------------------------------------------------------------------------

function ChatPanel({ companyId, item, onSent }: { companyId: string; item: Item; onSent: () => void }) {
  const sendMessage = usePluginAction("send-assistant-message");
  const toast = usePluginToast();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<{ author: "user" | "assistant"; text: string; runId?: string; at: string }>>([]);

  async function handleSend() {
    if (!draft.trim()) return;
    setError(null);
    setBusy(true);
    const message = draft;
    setHistory((prev) => [...prev, { author: "user", text: message, at: new Date().toISOString() }]);
    setDraft("");
    try {
      const result = await sendMessage({ companyId, itemId: item.id, message }) as {
        runId: string;
        prompt: string;
      };
      setHistory((prev) => [
        ...prev,
        {
          author: "assistant",
          text: "Sent to Triage Assistant — run started. Open the hidden queue chat issue for full transcript.",
          runId: result.runId,
          at: new Date().toISOString(),
        },
      ]);
      onSent();
      toast({ title: "Sent to Triage Assistant", tone: "success" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      style={{
        ...panelStyle,
        gap: 10,
        minHeight: 320,
      }}
      aria-label="Assistant chat"
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "grid", gap: 2 }}>
          <strong style={{ fontSize: 14 }}>Assistant chat</strong>
          <span style={mutedStyle}>Triage Assistant</span>
        </div>
        <Pill tone="muted">{item.contentFormat}</Pill>
      </div>

      <div
        aria-label="Pinned item context"
        style={{
          border: `1px dashed ${tokens.border}`,
          borderRadius: 6,
          padding: "8px 10px",
          fontSize: 12,
          color: tokens.muted,
          display: "grid",
          gap: 2,
        }}
      >
        <span style={{ textTransform: "uppercase", letterSpacing: 0.6, fontSize: 11 }}>Pinned item</span>
        <span style={{ color: tokens.fg, fontSize: 13, fontWeight: 600 }}>{item.title}</span>
        <span>state: {stateLabel(item.stateKey)} · rev {item.revision}</span>
      </div>

      <div
        style={{
          display: "grid",
          gap: 8,
          maxHeight: 320,
          overflowY: "auto",
          padding: 2,
        }}
        role="log"
        aria-live="polite"
      >
        {history.length === 0 ? (
          <div style={{ ...mutedStyle, padding: "12px 0" }}>
            Start the conversation. Context (queue purpose, current item, properties, guidance) is attached automatically.
          </div>
        ) : null}
        {history.map((entry, index) => (
          <div
            key={`${entry.at}-${index}`}
            style={{
              alignSelf: entry.author === "user" ? "end" : "start",
              maxWidth: "85%",
              border: `1px solid ${tokens.border}`,
              borderRadius: 8,
              padding: "8px 10px",
              fontSize: 13,
              background: entry.author === "user" ? tokens.card : tokens.mutedBg,
            }}
          >
            <div style={{ fontSize: 11, color: tokens.muted, marginBottom: 4 }}>
              {entry.author === "user" ? "you" : "Triage Assistant"} · {formatRelative(entry.at)}
            </div>
            <div>{entry.text}</div>
            {entry.runId ? <div style={{ fontSize: 11, color: tokens.muted, marginTop: 4 }}>run {entry.runId.slice(0, 8)}</div> : null}
          </div>
        ))}
      </div>

      <ErrorBanner message={error} />

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && draft.trim()) void handleSend();
        }}
        style={{ display: "grid", gap: 8 }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={`Ask the assistant about “${item.title}”…`}
          rows={3}
          aria-label="Message Triage Assistant"
          style={{
            padding: "8px 10px",
            border: `1px solid ${tokens.border}`,
            borderRadius: 6,
            fontFamily: fontStack,
            fontSize: 13,
            background: tokens.card,
            color: tokens.fg,
            resize: "vertical",
            minHeight: 60,
          }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={mutedStyle}>Ctx: queue, item, state, guidance files</span>
          <Button variant="primary" type="submit" disabled={busy || !draft.trim()}>
            {busy ? "Sending…" : "Send"}
          </Button>
        </div>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Item editor — title + content (MarkdownEditor when markdown) + properties.
// ---------------------------------------------------------------------------

function ItemEditor({ companyId, item, onSaved }: { companyId: string; item: Item; onSaved: () => void }) {
  const updateContent = usePluginAction("update-item-content");
  const toast = usePluginToast();
  const [draftTitle, setDraftTitle] = useState(item.title);
  const [draftContent, setDraftContent] = useState(item.content);
  const [draftProperties, setDraftProperties] = useState(JSON.stringify(item.properties ?? {}, null, 2));
  const [propsError, setPropsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraftTitle(item.title);
    setDraftContent(item.content);
    setDraftProperties(JSON.stringify(item.properties ?? {}, null, 2));
    setPropsError(null);
  }, [item.id, item.revision, item.title, item.content, item.properties]);

  const dirty =
    draftTitle !== item.title ||
    draftContent !== item.content ||
    !equivalentJson(draftProperties, item.properties);

  async function handleSave() {
    setError(null);
    setBusy(true);
    let parsedProps: Record<string, unknown> | undefined;
    if (draftProperties.trim()) {
      try {
        const parsed = JSON.parse(draftProperties);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          parsedProps = parsed as Record<string, unknown>;
        } else {
          setPropsError("Properties must be a JSON object");
          setBusy(false);
          return;
        }
      } catch {
        setPropsError("Properties must be valid JSON");
        setBusy(false);
        return;
      }
    } else {
      parsedProps = {};
    }
    setPropsError(null);
    try {
      await updateContent({
        companyId,
        itemId: item.id,
        expectedRevision: item.revision,
        title: draftTitle,
        content: draftContent,
        contentFormat: item.contentFormat,
        properties: parsedProps,
      });
      onSaved();
      toast({ title: "Item saved", tone: "success" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save item");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={panelStyle} aria-label="Item editor">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ fontSize: 14 }}>Item document</strong>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={mutedStyle}>rev {item.revision}</span>
          <Button variant="primary" onClick={() => void handleSave()} disabled={busy || !dirty}>
            {busy ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </Button>
        </div>
      </div>

      <ErrorBanner message={error} />

      <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
        <span style={{ fontWeight: 600 }}>Title</span>
        <input
          type="text"
          value={draftTitle}
          onChange={(event) => setDraftTitle(event.target.value)}
          style={{ padding: "8px 10px", border: `1px solid ${tokens.border}`, borderRadius: 6, fontSize: 14, background: tokens.card, color: tokens.fg }}
        />
      </label>

      <div style={{ display: "grid", gap: 4 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Content ({item.contentFormat})</span>
        {item.contentFormat === "markdown" ? (
          <MarkdownEditor
            value={draftContent}
            onChange={setDraftContent}
            placeholder="Edit the item content directly. Chat-assisted edits show up here too."
            bordered
          />
        ) : (
          <textarea
            value={draftContent}
            onChange={(event) => setDraftContent(event.target.value)}
            rows={12}
            style={{
              padding: "8px 10px",
              border: `1px solid ${tokens.border}`,
              borderRadius: 6,
              fontFamily: monoStack,
              fontSize: 13,
              background: tokens.card,
              color: tokens.fg,
              resize: "vertical",
              minHeight: 200,
            }}
          />
        )}
      </div>

      <details style={{ border: `1px solid ${tokens.border}`, borderRadius: 6, padding: 8 }}>
        <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 13 }}>Properties (free-form JSON)</summary>
        <textarea
          value={draftProperties}
          onChange={(event) => setDraftProperties(event.target.value)}
          rows={8}
          aria-label="Item properties JSON"
          style={{
            marginTop: 8,
            width: "100%",
            padding: "8px 10px",
            border: `1px solid ${tokens.border}`,
            borderRadius: 6,
            fontFamily: monoStack,
            fontSize: 12,
            background: tokens.card,
            color: tokens.fg,
            resize: "vertical",
            minHeight: 140,
          }}
        />
        {propsError ? <div style={{ color: tokens.destructive, fontSize: 12, marginTop: 6 }}>{propsError}</div> : null}
      </details>
    </section>
  );
}

function equivalentJson(text: string, value: unknown): boolean {
  try {
    const parsed = JSON.parse(text || "{}");
    return JSON.stringify(parsed) === JSON.stringify(value ?? {});
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Linked work issue panel + recent events panel.
// ---------------------------------------------------------------------------

function LinkedIssuePanel({ item }: { item: Item }) {
  if (!item.linkedWorkIssueId) {
    return (
      <section style={{ ...panelStyle, borderStyle: "dashed" }} aria-label="Linked work issue">
        <strong style={{ fontSize: 14 }}>Linked work issue</strong>
        <div style={mutedStyle}>None yet — created by a configured transition action.</div>
      </section>
    );
  }
  return (
    <section style={panelStyle} aria-label="Linked work issue">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ fontSize: 14 }}>Linked work issue</strong>
        <Pill tone="info">linked</Pill>
      </div>
      <div style={mutedStyle}>Issue id: <code style={{ fontFamily: monoStack }}>{item.linkedWorkIssueId}</code></div>
    </section>
  );
}

function ItemEventsPanel({ events }: { events: ItemEvent[] }) {
  if (events.length === 0) return null;
  const recent = events.slice(0, 8);
  return (
    <section style={panelStyle} aria-label="Recent activity">
      <strong style={{ fontSize: 14 }}>Recent activity</strong>
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
        {recent.map((event) => (
          <li
            key={event.id}
            style={{
              fontSize: 12,
              borderBottom: `1px solid ${tokens.borderSubtle}`,
              padding: "4px 0",
              color: tokens.muted,
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <span style={{ color: tokens.fg }}>{event.eventType}</span>
            <span>{formatRelative(event.createdAt)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Guidance side panel inside workbench — propose / accept / revise / reject.
// ---------------------------------------------------------------------------

function GuidanceSidePanel({
  companyId,
  item,
  guidance,
  proposals,
  refresh,
}: {
  companyId: string;
  item: Item;
  guidance: GuidanceDoc[];
  proposals: GuidanceProposal[];
  refresh: () => void;
}) {
  const generateProposal = usePluginAction("generate-guidance-proposal");
  const toast = usePluginToast();
  const [suggestion, setSuggestion] = useState("");
  const [path, setPath] = useState("guidance.md");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openProposals = proposals.filter((p) => p.status === "proposed" || p.status === "revised");

  async function handlePropose() {
    if (!suggestion.trim()) return;
    setError(null);
    setBusy(true);
    try {
      await generateProposal({
        companyId,
        itemId: item.id,
        path,
        suggestedChange: suggestion,
      });
      setSuggestion("");
      refresh();
      toast({ title: "Guidance proposal created", tone: "success" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create proposal");
    } finally {
      setBusy(false);
    }
  }

  const guidanceForItem = guidance.find((doc) => doc.path === path);

  return (
    <section style={panelStyle} aria-label="Guidance">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ fontSize: 14 }}>Queue guidance</strong>
        <select
          value={path}
          onChange={(event) => setPath(event.target.value)}
          aria-label="Guidance document"
          style={{
            border: `1px solid ${tokens.border}`,
            borderRadius: 6,
            padding: "4px 8px",
            fontSize: 13,
            background: tokens.card,
            color: tokens.fg,
          }}
        >
          {(guidance.length > 0 ? guidance.map((doc) => doc.path) : ["guidance.md"]).map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>

      <div
        style={{
          maxHeight: 200,
          overflowY: "auto",
          border: `1px solid ${tokens.borderSubtle}`,
          borderRadius: 6,
          padding: 10,
          fontSize: 13,
        }}
      >
        {guidanceForItem ? (
          <MarkdownBlock content={guidanceForItem.content || "_Empty guidance — propose your first rule._"} />
        ) : (
          <div style={mutedStyle}>No guidance written yet for {path}.</div>
        )}
      </div>

      <details>
        <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 13 }}>Propose guidance update</summary>
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          <textarea
            value={suggestion}
            onChange={(event) => setSuggestion(event.target.value)}
            placeholder="What did you learn from this item that future items should benefit from?"
            rows={3}
            style={{
              padding: "8px 10px",
              border: `1px solid ${tokens.border}`,
              borderRadius: 6,
              fontFamily: fontStack,
              fontSize: 13,
              background: tokens.card,
              color: tokens.fg,
              resize: "vertical",
            }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="primary" disabled={busy || !suggestion.trim()} onClick={() => void handlePropose()}>
              {busy ? "Proposing…" : "Propose"}
            </Button>
          </div>
          <ErrorBanner message={error} />
        </div>
      </details>

      {openProposals.length > 0 ? (
        <div style={{ display: "grid", gap: 8 }}>
          <div style={sectionHeading}>Open proposals</div>
          {openProposals.map((p) => (
            <ProposalCard key={p.id} companyId={companyId} proposal={p} guidance={guidance} onResolved={refresh} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ProposalCard({
  companyId,
  proposal,
  guidance,
  onResolved,
}: {
  companyId: string;
  proposal: GuidanceProposal;
  guidance: GuidanceDoc[];
  onResolved: () => void;
}) {
  const accept = usePluginAction("accept-guidance-proposal");
  const reject = usePluginAction("reject-guidance-proposal");
  const revise = usePluginAction("revise-guidance-proposal");
  const toast = usePluginToast();
  const [busy, setBusy] = useState<"accept" | "reject" | "revise" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftContent, setDraftContent] = useState(proposal.proposedContent);

  const path = typeof proposal.metadata?.path === "string" ? (proposal.metadata.path as string) : "guidance.md";
  const target = guidance.find((doc) => doc.path === path);
  const baseContent = target?.content ?? "";

  async function handleAccept() {
    setBusy("accept");
    setError(null);
    try {
      await accept({ companyId, proposalId: proposal.id });
      onResolved();
      toast({ title: "Guidance updated", tone: "success" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to accept");
    } finally {
      setBusy(null);
    }
  }
  async function handleReject() {
    setBusy("reject");
    setError(null);
    try {
      await reject({ companyId, proposalId: proposal.id });
      onResolved();
      toast({ title: "Guidance proposal rejected", tone: "info" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reject");
    } finally {
      setBusy(null);
    }
  }
  async function handleRevise() {
    setBusy("revise");
    setError(null);
    try {
      await revise({ companyId, proposalId: proposal.id, proposedContent: draftContent });
      setEditing(false);
      onResolved();
      toast({ title: "Proposal revised", tone: "success" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revise");
    } finally {
      setBusy(null);
    }
  }

  return (
    <article style={{ border: `1px solid ${tokens.border}`, borderRadius: 6, padding: 10, display: "grid", gap: 8 }} data-triage-proposal-id={proposal.id}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ fontSize: 13 }}>{path}</strong>
        <Pill tone={proposal.status === "revised" ? "warning" : "info"}>{proposal.status}</Pill>
      </div>
      {proposal.rationale ? <div style={mutedStyle}>{proposal.rationale}</div> : null}
      <ReflectionDiff baseContent={baseContent} proposedContent={proposal.proposedContent} />
      {editing ? (
        <div style={{ display: "grid", gap: 8 }}>
          <textarea
            value={draftContent}
            onChange={(event) => setDraftContent(event.target.value)}
            rows={8}
            aria-label="Revised guidance content"
            style={{ padding: 8, border: `1px solid ${tokens.border}`, borderRadius: 6, fontFamily: monoStack, fontSize: 12, background: tokens.card, color: tokens.fg, resize: "vertical" }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="primary" onClick={() => void handleRevise()} disabled={busy === "revise"}>
              {busy === "revise" ? "Saving…" : "Save revision"}
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button variant="primary" onClick={() => void handleAccept()} disabled={busy !== null}>
            {busy === "accept" ? "Accepting…" : "Accept"}
          </Button>
          <Button variant="outline" onClick={() => setEditing(true)} disabled={busy !== null}>Edit & revise</Button>
          <Button variant="destructive" onClick={() => void handleReject()} disabled={busy !== null}>
            {busy === "reject" ? "Rejecting…" : "Reject"}
          </Button>
        </div>
      )}
      <ErrorBanner message={error} />
    </article>
  );
}

// ---------------------------------------------------------------------------
// Reflection diff — simple line-by-line diff so changes are visible.
// ---------------------------------------------------------------------------

export function ReflectionDiff({ baseContent, proposedContent }: { baseContent: string; proposedContent: string }) {
  const rows = useMemo(() => diffLines(baseContent, proposedContent), [baseContent, proposedContent]);
  return (
    <pre
      data-triage-diff
      style={{
        margin: 0,
        padding: 8,
        border: `1px solid ${tokens.borderSubtle}`,
        borderRadius: 6,
        background: tokens.card,
        fontFamily: monoStack,
        fontSize: 12,
        lineHeight: 1.45,
        whiteSpace: "pre-wrap",
        maxHeight: 280,
        overflowY: "auto",
      }}
      aria-label="Guidance diff"
    >
      {rows.map((row, index) => (
        <div
          key={index}
          data-triage-diff-row={row.kind}
          style={{
            background:
              row.kind === "add"
                ? "oklch(0.95 0.07 145)"
                : row.kind === "del"
                ? "oklch(0.95 0.07 25)"
                : "transparent",
            color:
              row.kind === "add"
                ? "oklch(0.35 0.14 145)"
                : row.kind === "del"
                ? "oklch(0.4 0.18 25)"
                : tokens.fg,
            display: "block",
            padding: "0 4px",
          }}
        >
          <span style={{ color: tokens.muted, marginRight: 6 }}>{row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}</span>
          {row.line || " "}
        </div>
      ))}
    </pre>
  );
}

function diffLines(a: string, b: string): Array<{ kind: "eq" | "add" | "del"; line: string }> {
  // Very small LCS-based diff. Sufficient for short guidance docs.
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const n = aLines.length;
  const m = bLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aLines[i] === bLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: Array<{ kind: "eq" | "add" | "del"; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      rows.push({ kind: "eq", line: aLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ kind: "del", line: aLines[i] });
      i++;
    } else {
      rows.push({ kind: "add", line: bLines[j] });
      j++;
    }
  }
  while (i < n) rows.push({ kind: "del", line: aLines[i++] });
  while (j < m) rows.push({ kind: "add", line: bLines[j++] });
  return rows;
}

// ---------------------------------------------------------------------------
// Workflow editor — read-only summary of states + transitions for v1.
// ---------------------------------------------------------------------------

function WorkflowPage({ companyId, queueKey }: { companyId: string; queueKey: string }) {
  const queue = useQueue(companyId, queueKey);
  return (
    <main style={pageShell}>
      <QueueHeader companyId={companyId} queueKey={queueKey} queue={queue.data ?? null} active="workflow" />
      <section style={panelStyle}>
        <strong style={{ fontSize: 14 }}>States</strong>
        <div style={mutedStyle}>v1 ships with a fixed workflow. Future revisions can override per queue.</div>
        <div style={{ display: "grid", gap: 6 }}>
          {DEFAULT_STATE_DEFS.map((state) => (
            <div
              key={state.stateKey}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "6px 10px",
                border: `1px solid ${tokens.borderSubtle}`,
                borderRadius: 6,
              }}
            >
              <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                <Pill tone={state.tone}>{state.label}</Pill>
                <span style={{ fontFamily: monoStack, fontSize: 12, color: tokens.muted }}>{state.stateKey}</span>
              </span>
              <span style={mutedStyle}>{state.terminal ? "terminal" : "active"}</span>
            </div>
          ))}
        </div>
      </section>
      <section style={panelStyle}>
        <strong style={{ fontSize: 14 }}>Transitions</strong>
        <div style={{ display: "grid", gap: 6 }}>
          {DEFAULT_TRANSITIONS.map((transition) => (
            <div
              key={`${transition.fromStateKey}->${transition.toStateKey}`}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 10px", border: `1px solid ${tokens.borderSubtle}`, borderRadius: 6 }}
            >
              <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                <Pill tone={stateTone(transition.fromStateKey)}>{stateLabel(transition.fromStateKey)}</Pill>
                <span style={mutedStyle}>→</span>
                <Pill tone={stateTone(transition.toStateKey)}>{stateLabel(transition.toStateKey)}</Pill>
              </span>
              <span style={mutedStyle}>{transition.label}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Guidance page — folder-style list with markdown editor + history.
// ---------------------------------------------------------------------------

function GuidancePage({ companyId, queueKey }: { companyId: string; queueKey: string }) {
  const queue = useQueue(companyId, queueKey);
  const guidance = useGuidance(companyId, queueKey);
  const manualEdit = usePluginAction("manual-edit-guidance");
  const toast = usePluginToast();
  const docs = guidance.data ?? [];
  const [activePath, setActivePath] = useState<string | null>(null);
  const [addingPath, setAddingPath] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activePath && docs.length > 0) {
      setActivePath(docs[0].path);
    }
  }, [activePath, docs]);

  const activeDoc = docs.find((doc) => doc.path === activePath) ?? null;
  const draft = activePath != null ? drafts[activePath] ?? activeDoc?.content ?? "" : "";

  async function handleSave() {
    if (!activePath) return;
    setBusy(true);
    setError(null);
    try {
      await manualEdit({
        companyId,
        queueKey,
        path: activePath,
        content: draft,
        summary: "Manual edit",
      });
      guidance.refresh();
      toast({ title: `${activePath} saved`, tone: "success" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save guidance");
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate() {
    const path = addingPath.trim();
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      await manualEdit({
        companyId,
        queueKey,
        path,
        content: "",
        summary: "Created guidance doc",
      });
      setAddingPath("");
      setActivePath(path);
      guidance.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create guidance");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={pageShell}>
      <QueueHeader companyId={companyId} queueKey={queueKey} queue={queue.data ?? null} active="guidance" />

      <ErrorBanner message={error} />

      <section
        style={{
          ...panelStyle,
          gridTemplateColumns: "minmax(180px, 220px) 1fr",
          gridTemplateAreas: `"sidebar editor"`,
          gap: 16,
          padding: 0,
          overflow: "hidden",
        }}
      >
        <aside
          style={{
            gridArea: "sidebar",
            borderRight: `1px solid ${tokens.border}`,
            padding: 12,
            display: "grid",
            gap: 8,
            background: tokens.bg,
          }}
          aria-label="Guidance documents"
        >
          <div style={sectionHeading}>Guidance docs</div>
          {docs.length === 0 ? <div style={mutedStyle}>None yet</div> : null}
          <div style={{ display: "grid", gap: 4 }}>
            {docs.map((doc) => (
              <button
                key={doc.path}
                type="button"
                onClick={() => setActivePath(doc.path)}
                style={{
                  background: doc.path === activePath ? tokens.accent : "transparent",
                  color: "inherit",
                  border: "1px solid transparent",
                  borderRadius: 6,
                  padding: "6px 8px",
                  fontFamily: monoStack,
                  fontSize: 12,
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                {doc.path}
              </button>
            ))}
          </div>
          <div style={{ display: "grid", gap: 6, borderTop: `1px solid ${tokens.borderSubtle}`, paddingTop: 8 }}>
            <input
              type="text"
              value={addingPath}
              onChange={(event) => setAddingPath(event.target.value)}
              placeholder="style.md"
              aria-label="New guidance path"
              style={{ padding: "6px 8px", border: `1px solid ${tokens.border}`, borderRadius: 6, fontFamily: monoStack, fontSize: 12, background: tokens.card, color: tokens.fg }}
            />
            <Button variant="primary" onClick={() => void handleCreate()} disabled={busy || !addingPath.trim()}>
              + Add doc
            </Button>
          </div>
        </aside>

        <div style={{ gridArea: "editor", padding: 16, display: "grid", gap: 10, minHeight: 320 }}>
          {activeDoc ? (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong style={{ fontSize: 14, fontFamily: monoStack }}>{activeDoc.path}</strong>
                <Button variant="primary" onClick={() => void handleSave()} disabled={busy || draft === activeDoc.content}>
                  {busy ? "Saving…" : "Save"}
                </Button>
              </div>
              <MarkdownEditor
                value={draft}
                onChange={(value) => setDrafts((d) => ({ ...d, [activeDoc.path]: value }))}
                bordered
                placeholder={`Guidance for ${activeDoc.path}`}
              />
            </>
          ) : (
            <EmptyState
              title="No guidance selected"
              body="Pick a document on the left or add a new one (e.g. style.md, examples.md, rubric.md)."
            />
          )}
        </div>
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Transition actions editor — constrained create_or_update_issue template UI.
// ---------------------------------------------------------------------------

const TEMPLATE_FIELDS: Array<{ key: string; label: string; multiline?: boolean; placeholder?: string }> = [
  { key: "title", label: "Title", placeholder: "{{item.title}}" },
  { key: "description", label: "Description", multiline: true, placeholder: "{{item.content}}\n\nMetadata:\n{{item.propertiesJson}}" },
  { key: "comment", label: "Comment", multiline: true, placeholder: "Triage item moved to {{transition.toStateKey}}." },
  { key: "projectId", label: "Project id" },
  { key: "assignee", label: "Assignee" },
  { key: "priority", label: "Priority", placeholder: "low | medium | high | critical" },
  { key: "status", label: "Status", placeholder: "backlog | todo | in_progress | in_review | done | blocked | cancelled" },
];

const TEMPLATE_VARIABLES = [
  "item.id", "item.title", "item.content", "item.contentFormat",
  "item.stateKey", "item.propertiesJson", "item.linkedWorkIssueId",
  "queue.queueKey", "queue.title", "queue.id",
  "transition.fromStateKey", "transition.toStateKey", "transition.actionKey",
];

function TransitionActionsPage({ companyId, queueKey }: { companyId: string; queueKey: string }) {
  const queue = useQueue(companyId, queueKey);
  const actions = useTransitionActions(companyId, queueKey);
  const upsert = usePluginAction("upsert-transition-action");
  const toast = usePluginToast();
  const list = actions.data ?? [];
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <main style={pageShell}>
      <QueueHeader companyId={companyId} queueKey={queueKey} queue={queue.data ?? null} active="transitions" />

      <ErrorBanner message={actions.error?.message ?? null} />

      <section style={panelStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <strong style={{ fontSize: 14 }}>Transition actions</strong>
            <div style={mutedStyle}>v1: create or update a Paperclip issue when an item moves between states.</div>
          </div>
          <Button variant="primary" onClick={() => { setCreating((v) => !v); setEditingKey(null); }}>
            {creating ? "Cancel" : "+ New action"}
          </Button>
        </div>

        {creating ? (
          <ActionForm
            queueKey={queueKey}
            initial={null}
            onSubmit={async (payload) => {
              await upsert({ companyId, queueKey, ...payload });
              actions.refresh();
              setCreating(false);
              toast({ title: `Action ${payload.actionKey} saved`, tone: "success" });
            }}
          />
        ) : null}

        {list.length === 0 && !creating ? (
          <EmptyState title="No transition actions yet" body="Add an action to create a Paperclip work issue when an item is approved." />
        ) : null}

        {list.map((action) => (
          <div
            key={action.id}
            style={{
              border: `1px solid ${tokens.border}`,
              borderRadius: 6,
              padding: 12,
              display: "grid",
              gap: 8,
            }}
            data-triage-action-key={action.actionKey}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <strong style={{ fontSize: 13 }}>{action.actionKey}</strong>
                <Pill tone={stateTone(action.fromStateKey)}>{stateLabel(action.fromStateKey)}</Pill>
                <span style={mutedStyle}>→</span>
                <Pill tone={stateTone(action.toStateKey)}>{stateLabel(action.toStateKey)}</Pill>
                <Pill tone="muted">{action.action.mode}</Pill>
                {!action.enabled ? <Pill tone="warning">disabled</Pill> : null}
              </div>
              <Button variant="ghost" onClick={() => setEditingKey(editingKey === action.actionKey ? null : action.actionKey)}>
                {editingKey === action.actionKey ? "Close" : "Edit"}
              </Button>
            </div>
            {editingKey === action.actionKey ? (
              <ActionForm
                queueKey={queueKey}
                initial={action}
                onSubmit={async (payload) => {
                  await upsert({ companyId, queueKey, ...payload });
                  actions.refresh();
                  setEditingKey(null);
                  toast({ title: `Action ${payload.actionKey} saved`, tone: "success" });
                }}
              />
            ) : (
              <div style={{ display: "grid", gap: 4 }}>
                {Object.entries(action.action.template).map(([key, value]) => (
                  <div key={key} style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 8, fontSize: 12 }}>
                    <span style={{ color: tokens.muted, fontFamily: monoStack }}>{key}</span>
                    <code style={{ fontFamily: monoStack, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{value}</code>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </section>
    </main>
  );
}

function ActionForm({
  queueKey,
  initial,
  onSubmit,
}: {
  queueKey: string;
  initial: TransitionAction | null;
  onSubmit: (payload: {
    actionKey: string;
    fromStateKey: string;
    toStateKey: string;
    enabled: boolean;
    action: { type: "create_or_update_issue"; mode: TransitionAction["action"]["mode"]; template: Record<string, string> };
  }) => Promise<void>;
}) {
  const [actionKey, setActionKey] = useState(initial?.actionKey ?? "create-work");
  const [fromStateKey, setFromStateKey] = useState(initial?.fromStateKey ?? DEFAULT_TRIAGE_DEFAULT_STATE_KEY);
  const [toStateKey, setToStateKey] = useState(initial?.toStateKey ?? "approved");
  const [mode, setMode] = useState<TransitionAction["action"]["mode"]>(initial?.action.mode ?? "create_if_missing");
  const [template, setTemplate] = useState<Record<string, string>>(() => {
    const base: Record<string, string> = {};
    for (const field of TEMPLATE_FIELDS) base[field.key] = initial?.action.template?.[field.key] ?? "";
    return base;
  });
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleField = useCallback((key: string, value: string) => {
    setTemplate((prev) => ({ ...prev, [key]: value }));
  }, []);

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    const cleanedTemplate: Record<string, string> = {};
    for (const [key, value] of Object.entries(template)) {
      if (value.trim()) cleanedTemplate[key] = value;
    }
    if (!cleanedTemplate.title && mode !== "update_existing") {
      setError("Title is required when creating an issue");
      setSubmitting(false);
      return;
    }
    try {
      await onSubmit({
        actionKey,
        fromStateKey,
        toStateKey,
        enabled,
        action: {
          type: "create_or_update_issue",
          mode,
          template: cleanedTemplate,
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!submitting) void handleSubmit();
      }}
      style={{
        display: "grid",
        gap: 12,
        border: `1px solid ${tokens.border}`,
        borderRadius: 6,
        padding: 12,
        background: tokens.card,
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8 }}>
        <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
          <span style={{ fontWeight: 600 }}>Action key</span>
          <input
            type="text"
            value={actionKey}
            onChange={(event) => setActionKey(event.target.value)}
            required
            readOnly={initial !== null}
            style={inputStyle}
          />
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
          <span style={{ fontWeight: 600 }}>From state</span>
          <select value={fromStateKey} onChange={(event) => setFromStateKey(event.target.value)} style={inputStyle}>
            {DEFAULT_STATE_DEFS.map((s) => <option key={s.stateKey} value={s.stateKey}>{s.label}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
          <span style={{ fontWeight: 600 }}>To state</span>
          <select value={toStateKey} onChange={(event) => setToStateKey(event.target.value)} style={inputStyle}>
            {DEFAULT_STATE_DEFS.map((s) => <option key={s.stateKey} value={s.stateKey}>{s.label}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
          <span style={{ fontWeight: 600 }}>Mode</span>
          <select value={mode} onChange={(event) => setMode(event.target.value as TransitionAction["action"]["mode"])} style={inputStyle}>
            <option value="create_if_missing">create_if_missing</option>
            <option value="update_existing">update_existing</option>
            <option value="create_or_update">create_or_update</option>
          </select>
        </label>
      </div>

      <label style={{ display: "inline-flex", gap: 8, fontSize: 12, alignItems: "center" }}>
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        <span>Enabled</span>
      </label>

      <fieldset style={{ border: `1px solid ${tokens.borderSubtle}`, borderRadius: 6, padding: 10, display: "grid", gap: 8 }}>
        <legend style={{ fontSize: 12, color: tokens.muted, padding: "0 6px" }}>Template (variables: {TEMPLATE_VARIABLES.join(", ")})</legend>
        {TEMPLATE_FIELDS.map((field) => (
          <label key={field.key} style={{ display: "grid", gap: 4, fontSize: 12 }}>
            <span style={{ fontWeight: 600 }}>{field.label}</span>
            {field.multiline ? (
              <textarea
                value={template[field.key] ?? ""}
                onChange={(event) => handleField(field.key, event.target.value)}
                placeholder={field.placeholder}
                rows={3}
                style={{ ...inputStyle, fontFamily: monoStack, fontSize: 12, resize: "vertical", minHeight: 70 }}
              />
            ) : (
              <input
                type="text"
                value={template[field.key] ?? ""}
                onChange={(event) => handleField(field.key, event.target.value)}
                placeholder={field.placeholder}
                style={{ ...inputStyle, fontFamily: monoStack, fontSize: 12 }}
              />
            )}
          </label>
        ))}
      </fieldset>

      <ErrorBanner message={error} />

      <div style={{ display: "flex", gap: 8 }}>
        <Button variant="primary" type="submit" disabled={submitting}>
          {submitting ? "Saving…" : initial ? "Save changes" : "Create action"}
        </Button>
        <span style={{ ...mutedStyle, alignSelf: "center" }}>
          Queue: <code style={{ fontFamily: monoStack }}>{queueKey}</code>
        </span>
      </div>
    </form>
  );
}

const inputStyle: CSSProperties = {
  padding: "6px 8px",
  border: `1px solid ${tokens.border}`,
  borderRadius: 6,
  fontSize: 13,
  background: tokens.card,
  color: tokens.fg,
};

// ---------------------------------------------------------------------------
// Settings page — managed resource health (already used by Phase 2 scaffold).
// ---------------------------------------------------------------------------

export function SettingsPage({ context }: PluginSettingsPageProps) {
  return (
    <main style={pageShell}>
      <header style={{ display: "grid", gap: 4 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Triage Settings</h1>
        <div style={mutedStyle}>Managed project, assistant, and skills</div>
      </header>
      <ManagedResourcePanel companyId={context.companyId} allowReconcile={true} />
    </main>
  );
}

function ManagedResourcePanel({ companyId, allowReconcile }: { companyId: string | null; allowReconcile: boolean }) {
  const { data, loading, error, refresh } = useManagedResourceHealth(companyId);
  const reconcile = usePluginAction("reconcile-managed-resources");
  const toast = usePluginToast();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleReconcile() {
    if (!companyId) return;
    setBusy(true);
    setActionError(null);
    try {
      await reconcile({ companyId });
      refresh();
      toast({ title: "Triage resources reconciled", tone: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to reconcile resources";
      setActionError(message);
      toast({ title: "Reconcile failed", body: message, tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={panelStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16 }}>Managed Resources</h2>
          <div style={mutedStyle}>Last checked: {data?.checkedAt ?? "not checked"}</div>
        </div>
        {allowReconcile ? (
          <Button variant="primary" disabled={!companyId || busy} onClick={() => void handleReconcile()}>
            {busy ? "Reconciling" : "Reconcile"}
          </Button>
        ) : null}
      </div>
      {loading ? <div style={mutedStyle}>Loading resources...</div> : null}
      {error ? <ErrorBanner message={error.message} /> : null}
      {actionError ? <ErrorBanner message={actionError} /> : null}
      {data ? (
        <div>
          <ResourceRow label="Package Health" status={data.status} />
          <ResourceRow label="Triage Project" status={data.project?.status ?? "missing"} detail={data.project?.name ?? "Triage"} />
          <ResourceRow
            label="Triage Assistant"
            status={data.agent?.status ?? "missing"}
            detail={data.agent ? `${data.agent.name ?? "Triage Assistant"} (${data.agent.agentStatus ?? "unknown"})` : "Triage Assistant"}
          />
          {data.skills.map((skill) => (
            <ResourceRow key={skill.resourceKey} label={skill.name ?? skill.resourceKey} status={skill.status} detail={skill.key ?? skill.resourceKey} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ResourceRow({ label, status, detail }: { label: string; status: string; detail?: ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(120px, 1fr) auto",
        gap: 12,
        alignItems: "start",
        padding: "8px 0",
        borderTop: `1px solid ${tokens.border}`,
      }}
    >
      <div style={{ display: "grid", gap: 3 }}>
        <strong style={{ fontSize: 13 }}>{label}</strong>
        {detail ? <span style={mutedStyle}>{detail}</span> : null}
      </div>
      <span
        style={{
          fontSize: 12,
          fontWeight: 600,
          textTransform: "uppercase",
          color:
            status === "ready" || status === "created" || status === "resolved"
              ? tokens.success
              : status === "missing" || status === "needs_company"
              ? tokens.warning
              : tokens.muted,
        }}
      >
        {status.replaceAll("_", " ")}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers.
// ---------------------------------------------------------------------------

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const now = Date.now();
  const delta = Math.round((now - then) / 1000);
  if (delta < 30) return "just now";
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h ago`;
  if (delta < 86400 * 7) return `${Math.round(delta / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
