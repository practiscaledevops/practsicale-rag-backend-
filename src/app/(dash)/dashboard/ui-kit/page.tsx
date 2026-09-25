"use client";

// /dashboard/ui-kit — internal living style guide (not in the nav). Renders
// every shared primitive in every variant and state, so light/dark and
// density can be checked in one place. Demo data only; no API calls.

import * as React from "react";
import {
  Activity,
  Archive,
  BarChart3,
  Coins,
  Copy,
  Database,
  ExternalLink,
  Eye,
  FileText,
  Inbox,
  LayoutGrid,
  Layers,
  List,
  MousePointerClick,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  SquareStack,
  Table2,
  Tags,
  TextCursorInput,
  ToggleRight,
  Trash2,
  Users,
} from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  ClassBadge,
  CompactStat,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  FilterTabs,
  IconButton,
  InlineError,
  Input,
  Label,
  Menu,
  Meter,
  Notice,
  PageHeader,
  SearchInput,
  SectionCard,
  Segmented,
  Select,
  Skeleton,
  Spinner,
  StatGrid,
  StatTile,
  StatusDot,
  Switch,
  SwitchRow,
  TabPanel,
  Table,
  TableCard,
  TableEmptyRow,
  TableSkeletonRows,
  Tabs,
  Tag,
  TBody,
  Td,
  Textarea,
  Th,
  THead,
  Tr,
  buttonClass,
  useConfirm,
  type BadgeTone,
  type ButtonSize,
  type ButtonVariant,
  type DialogSize,
  type MenuItem,
  type StatusDotTone,
} from "@/components/ui";
import { Chip, KBtn, Panel, type Tone } from "@/components/ui/brain-ui";
import { CLASS_LABEL, sourceTypeLabel, statusLabel, statusTone } from "@/lib/ui-labels";
import { fmtBytes, fmtCompact, fmtDate, fmtDuration, fmtMoney, fmtPct, relTime } from "@/lib/format";

// ---------------------------------------------------------------------------
// Demo data (fixed clock so server and client render the same text)
// ---------------------------------------------------------------------------

const KIT_NOW = Date.parse("2026-09-25T12:00:00Z");
const ago = (ms: number) => new Date(KIT_NOW - ms).toISOString();

const DOCS = [
  { id: "d1", name: "Q3 coaching playbook", type: "document", status: "indexed", chunks: 128, cost: 0.4213, updated: ago(5 * 60_000) },
  { id: "d2", name: "Call score export — week 38", type: "call_score", status: "processing", chunks: 42, cost: 0.0042, updated: ago(3 * 3_600_000) },
  { id: "d3", name: "Onboarding transcript, Acme", type: "transcript", status: "failed", chunks: 0, cost: 0, updated: ago(30 * 3_600_000) },
  { id: "d4", name: "Objection handling notes", type: "coaching", status: "needs_review", chunks: 17, cost: 1.5, updated: ago(4 * 86_400_000) },
];

const BUTTON_VARIANTS: ButtonVariant[] = ["primary", "secondary", "outline", "ghost", "danger", "danger-secondary", "tea", "dark"];
const BUTTON_SIZES: ButtonSize[] = ["sm", "toolbar", "md", "lg"];
const BADGE_TONES: BadgeTone[] = ["neutral", "accent", "success", "warning", "danger", "info", "strong"];
const DOT_TONES: StatusDotTone[] = ["success", "warning", "danger", "info", "accent", "neutral"];
const LEGACY_TONES: Tone[] = ["green", "mint", "amber", "red", "info", "violet", "muted"];

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function KitRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2 sm:grid-cols-[132px_minmax(0,1fr)] sm:items-center">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function Stack({ children }: { children: React.ReactNode }) {
  return <div className="space-y-4">{children}</div>;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function UiKitPage() {
  // Forms
  const [autoSync, setAutoSync] = React.useState(true);
  const [ground, setGround] = React.useState(true);
  const [rerank, setRerank] = React.useState(false);

  // Selection controls
  const [range, setRange] = React.useState<"7d" | "30d" | "90d">("30d");
  const [view, setView] = React.useState<"grid" | "list">("grid");
  const [tab, setTab] = React.useState<"overview" | "draft" | "history">("overview");
  const [filter, setFilter] = React.useState<"all" | "ready" | "review" | "failed">("all");
  const [draft, setDraft] = React.useState("Edit me, switch tabs, come back.");

  // Table state
  const [tableState, setTableState] = React.useState<"rows" | "empty" | "loading">("rows");

  // Feedback
  const [notice, setNotice] = React.useState<string | null>(null);
  const [showDismissible, setShowDismissible] = React.useState(true);

  // Overlays
  const [dialogSize, setDialogSize] = React.useState<DialogSize | null>(null);
  const [secretOpen, setSecretOpen] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [confirmBusy, setConfirmBusy] = React.useState(false);
  const [confirmError, setConfirmError] = React.useState<string | null>(null);
  const [simulateFailure, setSimulateFailure] = React.useState(false);
  const [confirmResult, setConfirmResult] = React.useState<string | null>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();

  function runConfirm() {
    setConfirmBusy(true);
    setConfirmError(null);
    window.setTimeout(() => {
      setConfirmBusy(false);
      if (simulateFailure) {
        setConfirmError("Couldn’t delete the source. The server said: connector is still syncing.");
        return;
      }
      setConfirmOpen(false);
      setNotice("Source deleted.");
    }, 900);
  }

  async function runUseConfirm() {
    const ok = await confirm({
      title: "Archive 3 documents?",
      description: "Archived documents stop appearing in answers. You can restore them later.",
      confirmLabel: "Archive",
    });
    setConfirmResult(ok ? "Confirmed" : "Cancelled");
  }

  const rowMenu = (name: string): MenuItem[] => [
    { label: "Open", icon: Eye, href: "/dashboard/documents" },
    { label: "Rename", icon: Pencil, onSelect: () => setDialogSize("md") },
    { label: "Copy link", icon: Copy, onSelect: () => setNotice(`Link to “${name}” copied.`) },
    { label: "Reprocess", icon: RefreshCw, disabled: true },
    { label: "Delete", icon: Trash2, danger: true, separatorBefore: true, onSelect: () => setConfirmOpen(true) },
  ];

  const kitMenu: MenuItem[] = [
    { label: "Grid view", icon: LayoutGrid, active: view === "grid", onSelect: () => setView("grid") },
    { label: "List view", icon: List, active: view === "list", onSelect: () => setView("list") },
    { label: "Open in new tab", icon: ExternalLink, href: "/dashboard/ui-kit", external: true, separatorBefore: true },
    { label: "Disabled action", icon: Archive, disabled: true },
    { label: "Delete everything", icon: Trash2, danger: true, separatorBefore: true, onSelect: () => setConfirmOpen(true) },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title="UI kit"
        description="Internal reference for the Brain design system."
        backHref="/dashboard"
        backLabel="Overview"
        actions={
          <>
            <Button variant="secondary" size="toolbar" onClick={() => setNotice("Saved a draft.")}>
              <FileText size={14} aria-hidden />
              Show notice
            </Button>
            <Button size="toolbar" onClick={() => setDialogSize("md")}>
              <Plus size={14} aria-hidden />
              Open dialog
            </Button>
          </>
        }
      />

      {notice && <Notice message={notice} onDone={() => setNotice(null)} />}

      {/* ---------------------------------------------------------------- Buttons */}
      <SectionCard icon={MousePointerClick} title="Buttons" description="Pill buttons: sm 28, toolbar 32, md 36, lg 40; icon 32.">
        <Stack>
          {BUTTON_SIZES.map((size) => (
            <KitRow key={size} label={`Size ${size}`}>
              {BUTTON_VARIANTS.map((variant) => (
                <Button key={variant} variant={variant} size={size}>
                  {variant}
                </Button>
              ))}
            </KitRow>
          ))}
          <KitRow label="Icon size">
            <Button size="icon" variant="ghost" aria-label="Add">
              <Plus size={16} aria-hidden />
            </Button>
            <Button size="icon" variant="secondary" aria-label="Refresh">
              <RefreshCw size={16} aria-hidden />
            </Button>
            <Button size="icon" aria-label="Add">
              <Plus size={16} aria-hidden />
            </Button>
          </KitRow>
          <KitRow label="Loading">
            <Button size="sm" loading>
              Saving
            </Button>
            <Button size="toolbar" variant="secondary" loading>
              Syncing
            </Button>
            <Button loading>Saving changes</Button>
            <Button size="lg" variant="danger" loading>
              Deleting
            </Button>
          </KitRow>
          <KitRow label="Disabled">
            <Button disabled>Primary</Button>
            <Button variant="secondary" disabled>
              Secondary
            </Button>
            <Button variant="danger" disabled>
              Danger
            </Button>
          </KitRow>
          <KitRow label="buttonClass()">
            <a href="#kit-tables" className={buttonClass({ variant: "secondary", size: "toolbar" })}>
              <Table2 size={14} aria-hidden />
              Link styled as a button
            </a>
            <a href="#kit-overlays" className={buttonClass({ variant: "dark", size: "toolbar" })}>
              Dark pill link
            </a>
          </KitRow>
          <KitRow label="IconButton">
            <IconButton aria-label="Edit (small)" size="sm">
              <Pencil size={14} aria-hidden />
            </IconButton>
            <IconButton aria-label="Edit">
              <Pencil size={16} aria-hidden />
            </IconButton>
            <IconButton aria-label="Edit (large)" size="lg">
              <Pencil size={16} aria-hidden />
            </IconButton>
            <IconButton aria-label="Pinned" pressed aria-pressed>
              <Layers size={16} aria-hidden />
            </IconButton>
            <IconButton aria-label="Delete (disabled)" disabled>
              <Trash2 size={16} aria-hidden />
            </IconButton>
          </KitRow>
        </Stack>
      </SectionCard>

      {/* ---------------------------------------------------------------- Forms */}
      <SectionCard icon={TextCursorInput} title="Form fields" description="36px fields, 32px compact toolbar filters, bound labels.">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Document title" hint="Shown in answers and citations.">
            <Input placeholder="e.g. Q3 coaching playbook" />
          </Field>
          <Field label="Owner email" error="Enter a valid email address." required>
            <Input type="email" defaultValue="not-an-email" />
          </Field>
          <Field label="Collection">
            <Select
              placeholder="Choose a collection"
              defaultValue=""
              groups={[
                { label: "Sales", options: [{ value: "calls", label: "Call library" }, { value: "coaching", label: "Coaching" }] },
                { label: "Product", options: [{ value: "docs", label: "Product docs" }] },
                { label: "Empty group (skipped)", options: [] },
              ]}
            />
          </Field>
          <Field label="Access">
            <Select
              defaultValue="team"
              options={[
                { value: "public", label: "Public" },
                { value: "team", label: "Team" },
                { value: "restricted", label: "Restricted" },
                { value: "ceo_only", label: "CEO only", disabled: true },
              ]}
            />
          </Field>
          <Field label="Summary" hint="Plain text, a few sentences.">
            <Textarea rows={3} placeholder="What this document covers…" />
          </Field>
          <Field label="System prompt" hint="mono: for prompts, JSON and code.">
            <Textarea mono rows={3} defaultValue={"You are the PractiScale Brain.\nAnswer only from the context."} />
          </Field>
          <div className="space-y-1.5">
            <Label htmlFor="kit-disabled">Label + disabled input</Label>
            <Input id="kit-disabled" disabled defaultValue="Read only value" />
          </div>
          <div className="space-y-1.5">
            <Label>Compact toolbar controls (32px)</Label>
            <div className="flex flex-wrap items-center gap-2">
              <SearchInput aria-label="Search documents" placeholder="Search…" wrapperClassName="w-full sm:w-56" />
              <Input density="compact" placeholder="Compact input" className="sm:w-40" aria-label="Compact input" />
              <Select
                density="compact"
                aria-label="Filter by type"
                className="sm:w-36"
                defaultValue="all"
                options={[
                  { value: "all", label: "All types" },
                  { value: "document", label: "Document" },
                  { value: "transcript", label: "Transcript" },
                ]}
              />
            </div>
          </div>
        </div>
      </SectionCard>

      {/* ---------------------------------------------------------------- Switches + selection */}
      <SectionCard icon={ToggleRight} title="Switches and selection" description="Switch, SwitchRow, Segmented, Tabs with TabPanel, FilterTabs.">
        <Stack>
          <KitRow label="Switch">
            <Switch checked={autoSync} onChange={setAutoSync} label="Auto-sync" />
            <Switch checked={!autoSync} onChange={(v) => setAutoSync(!v)} label="Inverse of auto-sync" />
            <Switch checked disabled onChange={() => undefined} label="Disabled (on)" />
            <Switch checked={false} disabled onChange={() => undefined} label="Disabled (off)" />
          </KitRow>
          <div className="grid gap-2 md:grid-cols-2">
            <SwitchRow
              title="Ground or refuse"
              hint="Answer only from retrieved context; otherwise say so."
              checked={ground}
              onChange={setGround}
            />
            <SwitchRow title="LLM reranking" hint="Slower, often more relevant." checked={rerank} onChange={setRerank} />
            <SwitchRow title="Disabled row" hint="Managed by the org policy." checked disabled onChange={() => undefined} />
          </div>
          <KitRow label="Segmented">
            <Segmented
              label="Date range"
              value={range}
              onChange={setRange}
              options={[
                { value: "7d", label: "7 days" },
                { value: "30d", label: "30 days" },
                { value: "90d", label: "90 days" },
              ]}
            />
            <Segmented
              label="Layout"
              value={view}
              onChange={setView}
              options={[
                { value: "grid", label: "Grid", icon: LayoutGrid },
                { value: "list", label: "List", icon: List },
              ]}
            />
          </KitRow>
          <KitRow label="FilterTabs">
            <FilterTabs
              label="Filter by status"
              value={filter}
              onChange={setFilter}
              tabs={[
                { id: "all", label: "All", count: 128 },
                { id: "ready", label: "Ready", count: 97 },
                { id: "review", label: "Needs review", count: 24 },
                { id: "failed", label: "Failed", count: 7 },
              ]}
            />
          </KitRow>
          <div className="space-y-3">
            <Tabs
              label="Document sections"
              idPrefix="kit-tabs"
              value={tab}
              onChange={setTab}
              tabs={[
                { id: "overview", label: "Overview", icon: Eye },
                { id: "draft", label: "Draft", icon: Pencil, count: 1 },
                { id: "history", label: "History", count: 12 },
              ]}
            />
            <TabPanel idPrefix="kit-tabs" id="overview" active={tab === "overview"} className="text-[13px] text-muted-foreground">
              Arrow Left / Right, Home and End move between tabs. The Draft panel uses keepMounted, so its text survives tab switches.
            </TabPanel>
            <TabPanel idPrefix="kit-tabs" id="draft" active={tab === "draft"} keepMounted>
              <Field label="Draft note">
                <Input value={draft} onChange={(e) => setDraft(e.target.value)} />
              </Field>
            </TabPanel>
            <TabPanel idPrefix="kit-tabs" id="history" active={tab === "history"} className="text-[13px] text-muted-foreground">
              12 earlier versions.
            </TabPanel>
          </div>
        </Stack>
      </SectionCard>

      {/* ---------------------------------------------------------------- Badges */}
      <SectionCard icon={Tags} title="Badges and labels" description="Status tones, dots, tags and knowledge-class chips.">
        <Stack>
          <KitRow label="Badge">
            {BADGE_TONES.map((tone) => (
              <Badge key={tone} tone={tone}>
                {tone}
              </Badge>
            ))}
          </KitRow>
          <KitRow label="Badge with dot">
            {BADGE_TONES.map((tone) => (
              <Badge key={tone} tone={tone} dot>
                {tone}
              </Badge>
            ))}
          </KitRow>
          <KitRow label="statusTone()">
            {["indexed", "running", "needs_review", "failed", "archived", "never"].map((s) => (
              <Badge key={s} tone={statusTone(s)}>
                {statusLabel(s)}
              </Badge>
            ))}
          </KitRow>
          <KitRow label="StatusDot">
            {DOT_TONES.map((tone) => (
              <StatusDot key={tone} tone={tone}>
                {tone}
              </StatusDot>
            ))}
          </KitRow>
          <KitRow label="Tag">
            <Tag>openai</Tag>
            <Tag>anthropic</Tag>
            <Tag>pdf</Tag>
          </KitRow>
          <KitRow label="ClassBadge">
            {Object.keys(CLASS_LABEL).map((k) => (
              <ClassBadge key={k} klass={k} />
            ))}
            <ClassBadge klass="unknown_class" />
          </KitRow>
        </Stack>
      </SectionCard>

      {/* ---------------------------------------------------------------- Cards + stats */}
      <SectionCard icon={BarChart3} title="Cards and stats" description="Card family, StatTile / StatGrid, CompactStat and Meter.">
        <Stack>
          <StatGrid cols={4}>
            <StatTile icon={FileText} label="Documents" value={fmtCompact(12840)} title="12,840 documents" hint="Across 14 collections" />
            <StatTile icon={Activity} label="Success rate" value={fmtPct(0.982, 1)} tone="success" hint="Last 30 days" />
            <StatTile icon={Coins} label="Est. cost (30d)" value={fmtMoney(42.5)} tone="warning" loading />
            <StatTile icon={Database} label="Failed runs" value="7" tone="danger" href="/dashboard/processing" hint="Open processing runs" />
          </StatGrid>
          <StatGrid cols={3}>
            <CompactStat icon={Users} label="Admins" value="6" hint="2 super admins" />
            <CompactStat icon={Layers} label="Collections" value="14" />
            <CompactStat icon={SquareStack} label="Chunks" value={fmtCompact(1_204_553)} hint="text-embedding-3-large" />
          </StatGrid>
          <div className="grid gap-3 sm:grid-cols-2">
            {[0, 50, 85, 110].map((v) => (
              <div key={v} className="space-y-1.5">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Budget used</span>
                  <span className="tabular-nums">{v}%</span>
                </div>
                <Meter value={v} label={`Budget used, ${v}%`} />
              </div>
            ))}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Card title</CardTitle>
                <CardDescription>CardHeader, CardContent and CardFooter.</CardDescription>
              </CardHeader>
              <CardContent className="text-[13px] text-muted-foreground">
                Body copy sits at 13px in muted foreground; the card pads at 16px.
              </CardContent>
              <CardFooter>
                <Button variant="secondary" size="toolbar">
                  Cancel
                </Button>
                <Button size="toolbar">Save</Button>
              </CardFooter>
            </Card>
            <SectionCard
              icon={Palette}
              title="SectionCard"
              description="Icon tile, title, description and actions."
              actions={
                <Button variant="secondary" size="sm">
                  Action
                </Button>
              }
            >
              <p className="text-[13px] text-muted-foreground">The settings-section recipe from the chatbot admin.</p>
            </SectionCard>
          </div>
        </Stack>
      </SectionCard>

      {/* ---------------------------------------------------------------- Tables */}
      <div id="kit-tables">
        <TableCard
          title="Documents"
          meta={`${DOCS.length} documents`}
          actions={
            <Segmented
              label="Table state"
              value={tableState}
              onChange={setTableState}
              options={[
                { value: "rows", label: "Rows" },
                { value: "empty", label: "Empty" },
                { value: "loading", label: "Loading" },
              ]}
            />
          }
          footer={`Showing ${tableState === "rows" ? DOCS.length : 0} of ${DOCS.length}`}
        >
          <Table caption="Sample documents">
            <THead>
              <Tr>
                <Th>Name</Th>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th numeric>Chunks</Th>
                <Th numeric>Cost</Th>
                <Th>Updated</Th>
                <Th className="w-10">
                  <span className="sr-only">Actions</span>
                </Th>
              </Tr>
            </THead>
            <TBody>
              {tableState === "loading" && <TableSkeletonRows rows={4} cols={7} />}
              {tableState === "empty" && <TableEmptyRow colSpan={7}>No documents match your filters.</TableEmptyRow>}
              {tableState === "rows" &&
                DOCS.map((d) => (
                  <Tr key={d.id} interactive>
                    <Td className="font-medium">{d.name}</Td>
                    <Td>
                      <Badge>{sourceTypeLabel(d.type)}</Badge>
                    </Td>
                    <Td>
                      <Badge tone={statusTone(d.status)}>{statusLabel(d.status)}</Badge>
                    </Td>
                    <Td numeric>{d.chunks.toLocaleString("en-US")}</Td>
                    <Td numeric>{fmtMoney(d.cost)}</Td>
                    <Td className="whitespace-nowrap text-muted-foreground">{relTime(d.updated, { now: KIT_NOW })}</Td>
                    <Td className="py-1 text-right">
                      <Menu label={`Actions for ${d.name}`} items={rowMenu(d.name)} size="sm" />
                    </Td>
                  </Tr>
                ))}
            </TBody>
          </Table>
        </TableCard>
      </div>

      {/* ---------------------------------------------------------------- Feedback */}
      <SectionCard icon={Inbox} title="Feedback" description="Alert (banner), Notice (auto-dismiss), InlineError, EmptyState, Spinner, Skeleton.">
        <Stack>
          <div className="grid gap-2">
            <Alert tone="info" title="Heads up">
              Reindexing runs overnight; answers keep using the current index.
            </Alert>
            <Alert tone="success">All 128 documents indexed.</Alert>
            <Alert tone="warning" title="3 sources are stale">
              They have not synced for over 90 days.
            </Alert>
            <Alert tone="danger" title="Couldn’t load documents">
              The request timed out. Try again.
            </Alert>
            <Alert tone="danger">Title-less danger banner body.</Alert>
            {showDismissible && (
              <Alert tone="info" onDismiss={() => setShowDismissible(false)}>
                Dismissible banner (X on the right).
              </Alert>
            )}
          </div>
          <KitRow label="Notice">
            <Button variant="secondary" size="toolbar" onClick={() => setNotice("Settings saved.")}>
              Show a 4s notice
            </Button>
          </KitRow>
          <KitRow label="InlineError">
            <InlineError message="Enter a number between 1 and 50." />
          </KitRow>
          <div className="grid gap-3 md:grid-cols-2">
            <EmptyState
              icon={FileText}
              title="No documents yet"
              description="Upload files or connect a source to start building the Brain."
              action={
                <Button size="toolbar">
                  <Plus size={14} aria-hidden />
                  Add knowledge
                </Button>
              }
            />
            <Card>
              <EmptyState variant="plain" icon={Inbox} title="Plain variant" description="For use inside a card or table." />
            </Card>
          </div>
          <KitRow label="Spinner">
            <Spinner />
            <Spinner label="Syncing sources…" className="py-0" />
          </KitRow>
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Skeleton</p>
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-72 max-w-full" />
            <Skeleton className="h-20 w-full rounded-xl" />
          </div>
        </Stack>
      </SectionCard>

      {/* ---------------------------------------------------------------- Overlays */}
      <div id="kit-overlays">
        <SectionCard icon={SquareStack} title="Overlays" description="Dialog sizes, a non-dismissible dialog, ConfirmDialog, useConfirm and Menu.">
          <Stack>
            <KitRow label="Dialog">
              {(["sm", "md", "lg", "xl"] as DialogSize[]).map((s) => (
                <Button key={s} variant="secondary" size="toolbar" onClick={() => setDialogSize(s)}>
                  Open {s}
                </Button>
              ))}
              <Button variant="secondary" size="toolbar" onClick={() => setSecretOpen(true)}>
                Non-dismissible
              </Button>
            </KitRow>
            <KitRow label="ConfirmDialog">
              <Button variant="danger-secondary" size="toolbar" onClick={() => setConfirmOpen(true)}>
                <Trash2 size={14} aria-hidden />
                Delete source
              </Button>
              <SwitchRow
                title="Simulate failure"
                hint="The confirm shows an inline error."
                checked={simulateFailure}
                onChange={setSimulateFailure}
                className="w-full sm:w-auto"
              />
            </KitRow>
            <KitRow label="useConfirm()">
              <Button variant="secondary" size="toolbar" onClick={runUseConfirm}>
                <Archive size={14} aria-hidden />
                Archive 3 documents
              </Button>
              {confirmResult && (
                <StatusDot tone={confirmResult === "Confirmed" ? "success" : "neutral"}>Result: {confirmResult}</StatusDot>
              )}
            </KitRow>
            <KitRow label="Menu">
              <Menu label="More actions" items={kitMenu} />
              <Menu label="Start-aligned menu" items={kitMenu} align="start" size="sm" />
              <Menu
                label="View options"
                items={kitMenu}
                align="start"
                trigger={<span className="px-3 text-[13px] font-medium">Text trigger</span>}
                triggerClassName="w-auto"
              />
              <Menu label="Disabled menu" items={kitMenu} disabled />
            </KitRow>
          </Stack>
        </SectionCard>
      </div>

      {/* ---------------------------------------------------------------- Formatters */}
      <SectionCard icon={Activity} title="Formatters" description="@/lib/format — every function returns “—” for missing input.">
        <dl className="grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
          {[
            ["relTime (5m)", relTime(ago(5 * 60_000), { now: KIT_NOW })],
            ["relTime (yesterday)", relTime(ago(30 * 3_600_000), { now: KIT_NOW })],
            ["relTime (null)", relTime(null)],
            ["fmtDate", fmtDate("2026-01-05T12:00:00Z")],
            ["fmtMoney (2 dp)", fmtMoney(1234.5)],
            ["fmtMoney (sub-cent)", fmtMoney(0.0042)],
            ["fmtCompact", fmtCompact(1_204_553)],
            ["fmtDuration", fmtDuration(185_000)],
            ["fmtBytes", fmtBytes(3_355_443)],
          ].map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-3 border-b border-border py-1.5">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="tabular-nums text-foreground">{v}</dd>
            </div>
          ))}
        </dl>
      </SectionCard>

      {/* ---------------------------------------------------------------- Legacy */}
      <Panel title="Legacy brain-ui (for comparison)" subtitle="Chip, KBtn and Panel now render with the same tokens.">
        <Stack>
          <KitRow label="Chip">
            {LEGACY_TONES.map((tone) => (
              <Chip key={tone} tone={tone}>
                {tone}
              </Chip>
            ))}
          </KitRow>
          <KitRow label="KBtn">
            <KBtn variant="primary">primary</KBtn>
            <KBtn>outline</KBtn>
            <KBtn variant="ghost">ghost</KBtn>
            <KBtn variant="danger">danger</KBtn>
            <KBtn size="xs">xs</KBtn>
            <KBtn size="md" variant="primary">
              md
            </KBtn>
            <KBtn loading>loading</KBtn>
          </KitRow>
        </Stack>
      </Panel>

      {/* ---------------------------------------------------------------- Dialog instances */}
      <Dialog
        open={dialogSize !== null}
        onClose={() => setDialogSize(null)}
        size={dialogSize ?? "md"}
        title="Rename document"
        description="Titles appear in answers and citations."
        footer={
          <>
            <Button variant="secondary" size="toolbar" onClick={() => setDialogSize(null)}>
              Cancel
            </Button>
            <Button
              size="toolbar"
              onClick={() => {
                setDialogSize(null);
                setNotice("Document renamed.");
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Title">
            <Input defaultValue="Q3 coaching playbook" />
          </Field>
          <Field label="Collection" hint="A menu inside a dialog stacks above it (z-60).">
            <Select
              defaultValue="coaching"
              options={[
                { value: "calls", label: "Call library" },
                { value: "coaching", label: "Coaching" },
              ]}
            />
          </Field>
          <div className="flex items-center justify-between gap-3 rounded-xl bg-surface-muted px-3 py-2 text-[13px]">
            <span className="text-muted-foreground">More options</span>
            <Menu label="Dialog menu" items={kitMenu} size="sm" />
          </div>
        </div>
      </Dialog>

      <Dialog
        open={secretOpen}
        onClose={() => setSecretOpen(false)}
        dismissible={false}
        closeOnBackdrop={false}
        size="sm"
        title="Copy your API key"
        description="This secret is shown once. Escape and the backdrop do nothing here."
        footer={
          <Button size="toolbar" onClick={() => setSecretOpen(false)}>
            I’ve copied it
          </Button>
        }
      >
        <Input readOnly value="psk_live_demo_0000000000000000" className="font-mono text-[13px]" aria-label="API key" />
      </Dialog>

      <ConfirmDialog
        open={confirmOpen}
        title="Delete this source?"
        description="Its documents stay; syncing stops."
        confirmLabel="Delete"
        tone="danger"
        busy={confirmBusy}
        error={confirmError}
        onConfirm={runConfirm}
        onCancel={() => {
          setConfirmOpen(false);
          setConfirmError(null);
        }}
      >
        You can reconnect it later from Sources.
      </ConfirmDialog>

      {confirmDialog}
    </div>
  );
}
