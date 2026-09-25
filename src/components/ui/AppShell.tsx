"use client";

import * as React from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  BarChart3,
  Brain,
  BrainCircuit,
  Check,
  ChevronDown,
  Contact,
  Cpu,
  Database,
  FileText,
  Filter,
  FlaskConical,
  FolderTree,
  KeyRound,
  LayoutDashboard,
  Lightbulb,
  LineChart,
  Loader2,
  LogOut,
  Menu,
  MessageSquareText,
  Monitor,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Plus,
  ScrollText,
  Search,
  Settings,
  Share2,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Tags,
  Upload,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { supabaseBrowser } from "@/lib/supabase-server";
import { useTheme, type ThemePref } from "@/lib/theme";
import type { AdminRole } from "@/lib/auth/session";
import { Logo } from "./Brand";
import { CommandPalette, type CommandItem } from "./CommandPalette";
import { IconButton } from "./IconButton";
import { NotificationsBell } from "./NotificationsBell";

/**
 * The back-office shell, built like the chatbot's AppShell / AdminShell: a
 * 256px DARK rail (brand row, rounded nav panel, profile card) beside a white
 * workspace column (56px top bar + the scrolling <main>). The rail collapses
 * on desktop (remembered) and becomes a modal drawer below `lg`.
 *
 * Navigation is defined ONCE here; nav label = page title.
 */

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Extra command-palette search terms (e.g. the page's former name). */
  keywords?: string;
}

interface NavGroup {
  id: string;
  /** Omitted for the untitled home group. */
  title?: string;
  items: NavItem[];
}

/** The rail's top action row (the chatbot's "New chat" row). */
const PRIMARY_ACTION: NavItem = { href: "/dashboard/knowledge/add", label: "Add knowledge", icon: Plus };

const NAV_GROUPS: NavGroup[] = [
  {
    id: "home",
    items: [{ href: "/dashboard", label: "Overview", icon: LayoutDashboard, keywords: "home dashboard" }],
  },
  {
    id: "knowledge",
    title: "Knowledge",
    items: [
      { href: "/dashboard/knowledge", label: "Knowledge objects", icon: Brain },
      { href: "/dashboard/documents", label: "Documents", icon: FileText },
      { href: "/dashboard/collections", label: "Collections", icon: FolderTree },
      { href: "/dashboard/learning", label: "Learning Lab", icon: Lightbulb },
      { href: "/dashboard/performance", label: "Performance memory", icon: LineChart },
    ],
  },
  {
    id: "graph",
    title: "Knowledge graph",
    items: [
      { href: "/dashboard/taxonomy", label: "Taxonomy", icon: Tags },
      { href: "/dashboard/relationships", label: "Relationships", icon: Share2 },
      { href: "/dashboard/entities", label: "Entities", icon: Contact },
    ],
  },
  {
    id: "ingestion",
    title: "Ingestion",
    items: [
      { href: "/dashboard/sources", label: "Sources", icon: Database, keywords: "knowledge sources" },
      { href: "/dashboard/uploads", label: "Bulk upload", icon: Upload },
      { href: "/dashboard/processing", label: "Processing runs", icon: Activity },
      { href: "/dashboard/decisions", label: "Ingestion decisions", icon: ScrollText },
      { href: "/dashboard/quality-data", label: "Data quality", icon: ShieldAlert },
    ],
  },
  {
    id: "answers",
    title: "Answers",
    items: [
      { href: "/dashboard/quality", label: "Query intelligence", icon: Sparkles },
      { href: "/dashboard/analytics", label: "Analytics", icon: BarChart3 },
      { href: "/dashboard/playground", label: "Playground", icon: FlaskConical, keywords: "rag playground" },
    ],
  },
  {
    id: "admin",
    title: "Admin",
    items: [
      { href: "/dashboard/prompts", label: "Prompts", icon: MessageSquareText, keywords: "prompts & modes" },
      { href: "/dashboard/model-policy", label: "Model policy", icon: Cpu },
      { href: "/dashboard/retrieval-policy", label: "Retrieval policy", icon: Filter },
      { href: "/dashboard/keys", label: "API keys", icon: KeyRound },
      { href: "/dashboard/connectors", label: "Connectors", icon: Plug },
      { href: "/dashboard/admins", label: "Admins", icon: Users, keywords: "access & audit" },
      { href: "/dashboard/settings", label: "Settings", icon: SlidersHorizontal },
    ],
  },
];

const ALL_ITEMS: NavItem[] = [PRIMARY_ACTION, ...NAV_GROUPS.flatMap((g) => g.items)];
const ALL_HREFS = ALL_ITEMS.map((i) => i.href);

/** Routes outside the nav that still get a top-bar label. */
const EXTRA_LABELS: Record<string, string> = { "/dashboard/ui-kit": "UI kit" };

/**
 * Is `href` the active route? Overview matches exactly; others match by prefix,
 * and when several nav items match (e.g. /knowledge and /knowledge/add) only the
 * most specific one lights up.
 */
function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  const matches = (h: string) => pathname === h || pathname.startsWith(h + "/");
  if (!matches(href)) return false;
  const best = ALL_HREFS.filter((h) => h !== "/dashboard" && matches(h)).sort((a, b) => b.length - a.length)[0];
  return best === href;
}

/** The titled group holding the active route, if any. */
function activeGroupId(pathname: string): string | undefined {
  return NAV_GROUPS.find((g) => g.title && g.items.some((i) => isActive(pathname, i.href)))?.id;
}

// Layout contract for pages (see revamp plan §4).
const FULL_BLEED = new Set(["/dashboard/collections", "/dashboard/playground"]);
const WIDE_EXACT = new Set(["/dashboard/documents", "/dashboard/knowledge", "/dashboard/sources"]);
const WIDE_PREFIX = [
  "/dashboard/learning",
  "/dashboard/processing",
  "/dashboard/decisions",
  "/dashboard/uploads",
  // Review queues and wide tables: their action columns need the room.
  "/dashboard/relationships",
  "/dashboard/taxonomy",
  "/dashboard/entities",
  "/dashboard/performance",
  "/dashboard/quality-data",
  "/dashboard/keys",
];

function contentWidth(pathname: string): "full" | "wide" | "normal" {
  if (FULL_BLEED.has(pathname)) return "full";
  if (WIDE_EXACT.has(pathname)) return "wide";
  if (WIDE_PREFIX.some((p) => pathname === p || pathname.startsWith(p + "/"))) return "wide";
  return "normal";
}

const THEMES: { value: ThemePref; label: string; icon: LucideIcon }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

// ---------------------------------------------------------------------------
// Per-viewer UI memory (localStorage; every access guarded — storage can be
// unavailable in private windows).
// ---------------------------------------------------------------------------

const RAIL_KEY = "practiscale:brain:rail";
const GROUPS_KEY = "practiscale:brain:nav-groups";

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — the choice lasts for this page only */
  }
}

function readCollapsedGroups(): Set<string> {
  const raw = readStorage(GROUPS_KEY);
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function writeCollapsedGroups(groups: ReadonlySet<string>): void {
  writeStorage(GROUPS_KEY, JSON.stringify(Array.from(groups)));
}

// ---------------------------------------------------------------------------
// Rail grid (verbatim from the chatbot Sidebar). Every row: 32px tall, 12px
// left inset, a fixed 16px icon box, a 10px gap, then the label — so labels
// start at x=52 from the rail's edge. Trailing actions share one 28px column
// ending at x=240.
// ---------------------------------------------------------------------------

const ROW =
  "flex h-8 w-full items-center gap-2.5 rounded-lg pl-3 pr-2 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
const ROW_IDLE = "bg-sidebar-item/70 text-sidebar-foreground/90 hover:bg-sidebar-item-hover hover:text-white";
const ROW_ACTIVE = "bg-sidebar-item-hover text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.07)]";
const ICON_BOX = "flex w-4 shrink-0 items-center justify-center text-sidebar-foreground/70";
const TRAILING_BTN =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sidebar-muted transition-colors hover:bg-white/10 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Is a page overlay open that owns the keyboard: a Dialog / ConfirmDialog
 * (portaled to <body> at z-50, trapping Tab and Escape from a document capture
 * listener) or an open menu (z-[60])? Ctrl+K then does nothing, instead of
 * opening the palette underneath it with the dialog still taking its keys.
 * `drawer` (the shell's own nav drawer) is not counted: the palette closes it.
 */
function overlayOpen(drawer: HTMLElement | null): boolean {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"], [role="menu"]')
  ).some((el) => el !== drawer);
}

/** Tabbable, rendered elements inside `root` (for the drawer's focus trap). */
function tabbables(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")
  ).filter(
    (el) =>
      el.tabIndex >= 0 &&
      !(el as HTMLButtonElement).disabled &&
      el.getClientRects().length > 0
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export interface AppShellProps {
  email: string;
  /** The admin's role, for the profile caption. Optional so older callers compile. */
  role?: AdminRole;
  children: React.ReactNode;
}

export function AppShell({ email, role, children }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(false);
  // No width animation until the remembered rail state has been applied.
  const [railReady, setRailReady] = React.useState(false);
  const [collapsedGroups, setCollapsedGroups] = React.useState<ReadonlySet<string>>(() => new Set());
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [themePref, setThemePref] = useTheme();

  const menuButtonRef = React.useRef<HTMLButtonElement>(null);
  const expandButtonRef = React.useRef<HTMLButtonElement>(null);
  const railBrandRef = React.useRef<HTMLAnchorElement>(null);
  const drawerRef = React.useRef<HTMLDivElement>(null);
  const drawerCloseRef = React.useRef<HTMLButtonElement>(null);
  const drawerWasOpen = React.useRef(false);
  const focusAfterRailToggle = React.useRef<"expand" | "rail" | null>(null);

  // Close the mobile drawer whenever the route changes.
  React.useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const signOut = React.useCallback(async () => {
    setSigningOut(true);
    await supabaseBrowser().auth.signOut();
    router.replace("/login");
    router.refresh();
  }, [router]);

  // Restore the remembered rail + group state once, after hydration.
  React.useEffect(() => {
    if (readStorage(RAIL_KEY) === "collapsed") setCollapsed(true);
    setCollapsedGroups(readCollapsedGroups());
    const raf = requestAnimationFrame(() => setRailReady(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Arriving on a route opens its nav group (the active group is never hidden).
  React.useEffect(() => {
    const id = activeGroupId(pathname);
    if (!id) return;
    setCollapsedGroups((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      writeCollapsedGroups(next);
      return next;
    });
  }, [pathname]);

  const toggleGroup = React.useCallback((id: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeCollapsedGroups(next);
      return next;
    });
  }, []);

  const collapseRail = React.useCallback(() => {
    focusAfterRailToggle.current = "expand";
    setCollapsed(true);
    writeStorage(RAIL_KEY, "collapsed");
  }, []);

  const expandRail = React.useCallback(() => {
    focusAfterRailToggle.current = "rail";
    setCollapsed(false);
    writeStorage(RAIL_KEY, null);
  }, []);

  // Keep keyboard focus on a visible control when the rail collapses/expands.
  React.useEffect(() => {
    const target = focusAfterRailToggle.current;
    focusAfterRailToggle.current = null;
    if (target === "expand") expandButtonRef.current?.focus({ preventScroll: true });
    else if (target === "rail") railBrandRef.current?.focus({ preventScroll: true });
  }, [collapsed]);

  // Drawer focus: move in on open (its close button), back to the menu button on close.
  React.useEffect(() => {
    if (mobileOpen) {
      drawerWasOpen.current = true;
      drawerCloseRef.current?.focus({ preventScroll: true });
    } else if (drawerWasOpen.current) {
      drawerWasOpen.current = false;
      menuButtonRef.current?.focus({ preventScroll: true });
    }
  }, [mobileOpen]);

  const closeDrawer = React.useCallback(() => setMobileOpen(false), []);

  // Escape closes the drawer; Tab / Shift+Tab wrap inside it.
  function onDrawerKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeDrawer();
      return;
    }
    if (e.key !== "Tab" || !drawerRef.current) return;
    const els = tabbables(drawerRef.current);
    if (els.length === 0) return;
    const first = els[0];
    const last = els[els.length - 1];
    const current = document.activeElement;
    // The focusable drawer root itself counts as "not inside" (it takes focus when
    // non-focusable drawer content is clicked), so Tab / Shift+Tab re-enter the cycle.
    const inside = current instanceof Node && current !== drawerRef.current && drawerRef.current.contains(current);
    if (e.shiftKey && (current === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (current === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  }

  // Command palette (Ctrl+K / ⌘K, or the rail's "Search pages" row). Opening it
  // from the drawer closes the drawer and parks focus on the menu button, so
  // closing the palette returns there.
  const openPalette = React.useCallback(() => {
    if (mobileOpen) {
      menuButtonRef.current?.focus({ preventScroll: true });
      setMobileOpen(false);
    }
    setPaletteOpen(true);
  }, [mobileOpen]);

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        if (paletteOpen) setPaletteOpen(false);
        else if (!overlayOpen(drawerRef.current)) openPalette();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, openPalette]);

  const closePalette = React.useCallback(() => setPaletteOpen(false), []);

  const paletteItems = React.useMemo<CommandItem[]>(
    () => [
      ...NAV_GROUPS.flatMap((g) =>
        g.items.map<CommandItem>((it) => ({
          id: `nav:${it.href}`,
          group: "Navigate",
          label: it.label,
          hint: g.title,
          keywords: it.keywords,
          icon: it.icon,
          href: it.href,
        }))
      ),
      { id: "action:add-knowledge", group: "Actions", label: PRIMARY_ACTION.label, icon: Plus, href: PRIMARY_ACTION.href },
      ...THEMES.map<CommandItem>((t) => ({
        id: `action:theme-${t.value}`,
        group: "Actions",
        label: `Theme: ${t.label}`,
        hint: themePref === t.value ? "Current" : undefined,
        keywords: "appearance dark mode light mode",
        icon: t.icon,
        onSelect: () => setThemePref(t.value),
      })),
      { id: "action:sign-out", group: "Actions", label: "Sign out", keywords: "log out", icon: LogOut, onSelect: () => void signOut() },
    ],
    [themePref, setThemePref, signOut]
  );

  const currentLabel = ALL_ITEMS.find((i) => isActive(pathname, i.href))?.label ?? EXTRA_LABELS[pathname];
  const width = contentWidth(pathname);
  const onSettings = pathname === "/dashboard/settings" || pathname.startsWith("/dashboard/settings/");

  const railProps = {
    pathname,
    email,
    role,
    collapsedGroups,
    onToggleGroup: toggleGroup,
    onSearch: openPalette,
    onSignOut: () => void signOut(),
    signingOut,
    themePref,
    onTheme: setThemePref,
  };

  return (
    <>
      {/* relative: the frame is the containing block for absolutely positioned
          descendants (sr-only labels, popovers). Without it they resolve against
          the page, and one deep in a long scrolled page makes the whole document
          taller than the window — the page then scrolls, leaving a blank strip.
          overflow-clip, not overflow-hidden: a hidden box is still a scroll
          container that focus() / scrollIntoView can scroll sideways (shifting
          the rail and the workspace off screen); a clipped box cannot scroll. */}
      <div className="relative flex h-app overflow-clip bg-sidebar">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-full focus:bg-surface focus:px-3 focus:py-1.5 focus:text-[13px] focus:shadow-soft-lg"
        >
          Skip to content
        </a>

        {/* Desktop rail — dark in both themes; collapses to 0 (and goes inert). */}
        <aside
          aria-label="Sidebar"
          inert={collapsed}
          className={cn(
            "hidden shrink-0 bg-sidebar text-sidebar-foreground lg:flex lg:flex-col",
            railReady && "transition-[width,opacity] duration-200 ease-out",
            collapsed ? "lg:w-0 lg:overflow-clip lg:opacity-0" : "lg:w-64"
          )}
        >
          <div className="flex h-full w-64 shrink-0 flex-col">
            <RailContent {...railProps} variant="desktop" onCollapse={collapseRail} brandRef={railBrandRef} />
          </div>
        </aside>

        {/* Mobile drawer — a modal dialog below lg. */}
        {mobileOpen && (
          <div
            ref={drawerRef}
            // Focusable, so a click on non-focusable drawer content keeps focus in the
            // dialog (not <body>) and Escape / Tab still reach onDrawerKeyDown.
            tabIndex={-1}
            className="fixed inset-0 z-40 outline-none lg:hidden"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            onKeyDown={onDrawerKeyDown}
          >
            <button
              type="button"
              tabIndex={-1}
              aria-label="Close menu"
              onClick={closeDrawer}
              className="absolute inset-0 scrim motion-safe:animate-fadeIn"
            />
            <div className="absolute inset-y-0 left-0 flex w-64 flex-col bg-sidebar text-sidebar-foreground shadow-soft-lg motion-safe:animate-fadeUp">
              <RailContent
                {...railProps}
                variant="drawer"
                onClose={closeDrawer}
                onNavigate={closeDrawer}
                closeRef={drawerCloseRef}
              />
            </div>
          </div>
        )}

        {/* Workspace column: the white top bar + the scrolling page. */}
        <div className="flex min-w-0 flex-1 flex-col bg-background">
          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 bg-background px-4 sm:px-6">
            <IconButton
              ref={menuButtonRef}
              aria-label="Open menu"
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen(true)}
              className="lg:hidden"
            >
              <Menu size={18} aria-hidden />
            </IconButton>
            {collapsed && (
              <IconButton
                ref={expandButtonRef}
                aria-label="Show sidebar"
                title="Show sidebar"
                onClick={expandRail}
                className="hidden lg:inline-flex"
              >
                <PanelLeftOpen size={16} aria-hidden />
              </IconButton>
            )}

            {/* Product mark (the chatbot TopBar), then the section name on lg+. */}
            <div className="flex min-w-0 items-center gap-2">
              <Link
                href="/dashboard"
                aria-label="Practiscale Intelligent Operations — overview"
                className="flex min-w-0 items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <BrainCircuit size={20} strokeWidth={2} className="shrink-0 text-accent" aria-hidden />
                <span className="shrink-0 text-[17px] font-bold leading-none tracking-[-0.02em] text-accent-deep">
                  Practiscale
                </span>
                <span className="hidden min-w-0 truncate text-[17px] font-semibold leading-none tracking-[-0.02em] text-foreground md:inline">
                  Intelligent Operations
                </span>
              </Link>
              {currentLabel && (
                <span className="hidden min-w-0 items-center gap-2 lg:flex">
                  <span className="text-sm font-light text-subtle-foreground" aria-hidden>
                    /
                  </span>
                  <span className="truncate text-[13px] font-medium text-muted-foreground">{currentLabel}</span>
                </span>
              )}
            </div>

            <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
              <NotificationsBell />
              <Link
                href="/dashboard/settings"
                aria-label="Settings"
                title="Settings"
                aria-current={onSettings ? "page" : undefined}
                className="inline-flex h-8 w-8 items-center justify-center gap-1.5 rounded-full bg-ink text-[13px] font-medium text-ink-foreground transition-colors hover:bg-ink-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:w-auto sm:px-3"
              >
                <Settings size={14} aria-hidden />
                <span className="hidden sm:inline">Settings</span>
              </Link>
            </div>
          </header>

          {/* <main> scrolls vertically only. Its overflow-y:auto turns overflow-x
              into auto as well, so the page wrapper below clips sideways overflow
              (overflow-x-clip keeps overflow-y visible and position:sticky intact)
              and is `relative`, so sr-only / absolute descendants — e.g. a wide
              table's header labels — are contained and clipped by it instead of
              widening <main>. Wide tables scroll inside their own Table scroller. */}
          <main id="main" tabIndex={-1} className="relative min-h-0 min-w-0 flex-1 overflow-y-auto focus:outline-none">
            {width === "full" ? (
              <div className="relative flex h-full min-h-0 min-w-0 flex-col overflow-x-clip">{children}</div>
            ) : (
              <div
                className={cn(
                  "relative mx-auto w-full min-w-0 overflow-x-clip px-4 py-5 sm:px-6 sm:py-6",
                  width === "wide" ? "max-w-7xl" : "max-w-6xl"
                )}
              >
                {children}
              </div>
            )}
          </main>
        </div>
      </div>

      <CommandPalette open={paletteOpen} onClose={closePalette} items={paletteItems} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Rail content — shared by the desktop aside and the mobile drawer.
// ---------------------------------------------------------------------------

interface RailContentProps {
  variant: "desktop" | "drawer";
  pathname: string;
  email: string;
  role?: AdminRole;
  collapsedGroups: ReadonlySet<string>;
  onToggleGroup: (id: string) => void;
  onSearch: () => void;
  onSignOut: () => void;
  signingOut: boolean;
  themePref: ThemePref;
  onTheme: (pref: ThemePref) => void;
  /** Desktop only: collapse the rail. */
  onCollapse?: () => void;
  /** Drawer only: close button + close-on-navigate. */
  onClose?: () => void;
  onNavigate?: () => void;
  closeRef?: React.Ref<HTMLButtonElement>;
  brandRef?: React.Ref<HTMLAnchorElement>;
}

function RailContent({
  variant,
  pathname,
  email,
  role,
  collapsedGroups,
  onToggleGroup,
  onSearch,
  onSignOut,
  signingOut,
  themePref,
  onTheme,
  onCollapse,
  onClose,
  onNavigate,
  closeRef,
  brandRef,
}: RailContentProps) {
  const uid = React.useId();
  const roleLabel = role === "super_admin" ? "Super admin" : role === "admin" ? "Admin" : null;
  const initial = (email.trim()[0] ?? "?").toUpperCase();
  const addActive = isActive(pathname, PRIMARY_ACTION.href);

  const moreItems: MenuEntry[] = [
    ...THEMES.map<MenuEntry>((t) => ({
      label: t.label,
      icon: t.icon,
      checked: themePref === t.value,
      onSelect: () => onTheme(t.value),
    })),
    ...(onCollapse
      ? ([
          { type: "separator", key: "sep-collapse", desktopOnly: true },
          { label: "Collapse sidebar", icon: PanelLeftClose, onSelect: onCollapse, desktopOnly: true },
        ] satisfies MenuEntry[])
      : []),
    { type: "separator", key: "sep-sign-out" },
    { label: "Sign out", icon: LogOut, onSelect: onSignOut, danger: true },
  ];

  function renderItem({ href, label, icon: Icon }: NavItem) {
    const active = isActive(pathname, href);
    return (
      <li key={href}>
        <Link
          href={href}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          className={cn(ROW, active ? ROW_ACTIVE : ROW_IDLE)}
        >
          <span className={cn(ICON_BOX, active && "text-accent")}>
            <Icon size={16} strokeWidth={1.75} aria-hidden />
          </span>
          <span className="truncate">{label}</span>
        </Link>
      </li>
    );
  }

  return (
    <>
      {/* Brand row — the logo sits flush with the rows' left edge (x=14); the
          menu buttons sit in the rows' trailing column (ending at x=240). */}
      <div className="flex h-14 shrink-0 items-center gap-2 pl-3.5 pr-4">
        <Link
          ref={brandRef}
          href="/dashboard"
          onClick={onNavigate}
          className="flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Logo variant="dark" className="h-[18px]" />
          <span className="inline-flex h-[18px] items-center rounded-full bg-accent/20 px-1.5 text-[11px] font-semibold leading-none text-accent">
            Brain
          </span>
        </Link>
        <div className="ml-auto flex items-center">
          <RailMenu label="More options" icon={<MoreHorizontal size={16} aria-hidden />} items={moreItems} />
          {variant === "drawer" && (
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Close menu"
              className={cn(TRAILING_BTN, "lg:hidden")}
            >
              <X size={16} aria-hidden />
            </button>
          )}
        </div>
      </div>

      {/* The rounded panel */}
      <div className="mx-2 flex min-h-0 flex-1 flex-col rounded-2xl bg-sidebar-panel">
        <div className="scrollbar-none fade-bottom flex min-h-0 flex-1 flex-col overflow-y-auto p-1.5 pb-5">
          <div className="space-y-0.5">
            <Link
              href={PRIMARY_ACTION.href}
              onClick={onNavigate}
              aria-current={addActive ? "page" : undefined}
              className={cn(ROW, addActive ? ROW_ACTIVE : ROW_IDLE, "font-medium")}
            >
              <span className={cn(ICON_BOX, "text-accent")}>
                <Plus size={16} strokeWidth={1.75} aria-hidden />
              </span>
              <span className="truncate">{PRIMARY_ACTION.label}</span>
            </Link>
            <button
              type="button"
              onClick={onSearch}
              aria-keyshortcuts="Control+K Meta+K"
              className={cn(ROW, ROW_IDLE)}
            >
              <span className={ICON_BOX}>
                <Search size={16} strokeWidth={1.75} aria-hidden />
              </span>
              <span className="truncate">Search pages</span>
              <span className="ml-auto shrink-0 text-[11px] text-sidebar-muted" aria-hidden>
                Ctrl K
              </span>
            </button>
          </div>

          <nav aria-label="Primary" className="mt-2 space-y-0.5">
            {NAV_GROUPS.map((group) => {
              if (!group.title) {
                return (
                  <ul key={group.id} className="space-y-0.5">
                    {group.items.map(renderItem)}
                  </ul>
                );
              }
              const open = !collapsedGroups.has(group.id);
              const labelId = `${uid}-${group.id}`;
              const listId = `${uid}-${group.id}-list`;
              return (
                <div key={group.id} role="group" aria-labelledby={labelId} className="pt-2">
                  <div className="flex h-7 items-center">
                    <button
                      type="button"
                      onClick={() => onToggleGroup(group.id)}
                      aria-expanded={open}
                      aria-controls={open ? listId : undefined}
                      className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-md pl-3 text-left text-xs font-medium text-sidebar-muted transition-colors hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="flex w-4 shrink-0 items-center justify-center">
                        <ChevronDown size={14} className={cn("transition-transform", !open && "-rotate-90")} aria-hidden />
                      </span>
                      <span id={labelId} className="truncate">
                        {group.title}
                      </span>
                    </button>
                  </div>
                  {open && (
                    <ul id={listId} className="space-y-0.5">
                      {group.items.map(renderItem)}
                    </ul>
                  )}
                </div>
              );
            })}
          </nav>
        </div>
      </div>

      {/* Profile card — the avatar flush with the rows' left edge (x=14) so the
          email starts on the label column (x=52); sign-out ends at x=240. */}
      <div className="m-2 flex shrink-0 items-center gap-2.5 rounded-xl bg-sidebar-panel py-2 pl-1.5 pr-2">
        <span
          aria-hidden
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-gradient text-[11px] font-semibold text-white"
        >
          {initial}
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[13px] font-medium text-sidebar-foreground" title={email}>
            {email}
          </span>
          {roleLabel && <span className="block truncate text-[11px] text-sidebar-muted">{roleLabel}</span>}
        </span>
        <button
          type="button"
          onClick={onSignOut}
          disabled={signingOut}
          aria-label="Sign out"
          title="Sign out"
          className={cn(TRAILING_BTN, "disabled:pointer-events-none disabled:opacity-60")}
        >
          {signingOut ? (
            <Loader2 size={16} className="animate-spin" aria-hidden />
          ) : (
            <LogOut size={16} aria-hidden />
          )}
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// RailMenu — ported from the chatbot Sidebar: a 188px portaled menu, right-
// aligned to its trigger with a 4px gap, flipping above when there is no room.
// Arrow keys wrap; Escape (or Tab) closes and refocuses the trigger; an outside
// mousedown, resize or scroll closes it. Adds radio items (with a check) and
// separators for the theme choice.
// ---------------------------------------------------------------------------

type MenuEntry =
  | {
      type?: "item";
      label: string;
      icon: LucideIcon;
      onSelect: () => void;
      danger?: boolean;
      /** Only shown at lg+ (e.g. collapsing the rail). */
      desktopOnly?: boolean;
      /** Set (true/false) to render a menuitemradio with a check. */
      checked?: boolean;
    }
  | { type: "separator"; key: string; desktopOnly?: boolean };

const MENU_WIDTH = 188;
const MENU_ROW_H = 32;
const MENU_SEPARATOR_H = 9;

/** The menu items that are actually rendered (desktop-only rows are hidden below lg). */
function shownItems(list: (HTMLButtonElement | null)[]): HTMLButtonElement[] {
  return list.filter((el): el is HTMLButtonElement => !!el && el.getClientRects().length > 0);
}

function RailMenu({
  label,
  icon,
  items,
  className,
  activeClassName,
}: {
  label: string;
  icon: React.ReactNode;
  items: MenuEntry[];
  className?: string;
  /** Classes applied while the menu is open (e.g. keep a hover-only trigger visible). */
  activeClassName?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ top: number; left: number } | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const itemRefs = React.useRef<(HTMLButtonElement | null)[]>([]);

  const separators = items.filter((it) => it.type === "separator").length;
  const rows = items.length - separators;

  const place = React.useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const height = rows * MENU_ROW_H + separators * MENU_SEPARATOR_H + 10;
    const left = Math.min(window.innerWidth - MENU_WIDTH - 8, Math.max(8, r.right - MENU_WIDTH));
    const below = r.bottom + 4;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, r.top - height - 4) : below;
    setPos({ top, left });
  }, [rows, separators]);

  React.useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  React.useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => shownItems(itemRefs.current)[0]?.focus({ preventScroll: true }), 0);
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  function closeToTrigger() {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }

  function onMenuKeyDown(e: React.KeyboardEvent) {
    // Handled here, so the drawer's own Escape / Tab trap never sees these keys.
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      closeToTrigger();
      return;
    }
    const list = shownItems(itemRefs.current);
    if (list.length === 0) return;
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (e.key === "ArrowDown") next = (i + 1) % list.length;
    else if (e.key === "ArrowUp") next = (i - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else return;
    e.preventDefault();
    list[next]?.focus();
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className={cn(TRAILING_BTN, className, open && cn("bg-white/10 text-sidebar-foreground", activeClassName))}
      >
        {icon}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={label}
            onKeyDown={onMenuKeyDown}
            style={{ top: pos.top, left: pos.left, width: MENU_WIDTH }}
            className="fixed z-[60] rounded-xl border border-white/10 bg-[#232323] p-1 text-sidebar-foreground shadow-[0_16px_40px_-10px_rgb(0_0_0/0.6)] motion-safe:animate-fadeUp"
          >
            {items.map((it, i) => {
              if (it.type === "separator") {
                return (
                  <div
                    key={it.key}
                    role="separator"
                    className={cn("mx-1 my-1 h-px bg-white/10", it.desktopOnly && "hidden lg:block")}
                  />
                );
              }
              const radio = it.checked !== undefined;
              return (
                <button
                  key={it.label}
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  type="button"
                  role={radio ? "menuitemradio" : "menuitem"}
                  aria-checked={radio ? it.checked : undefined}
                  tabIndex={-1}
                  onClick={() => {
                    closeToTrigger();
                    it.onSelect();
                  }}
                  className={cn(
                    "flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors hover:bg-white/[0.08] focus-visible:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    it.danger ? "text-[#ff8f86]" : "text-sidebar-foreground",
                    it.desktopOnly && "hidden lg:flex"
                  )}
                >
                  <it.icon size={14} className="shrink-0 opacity-85" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                  {it.checked && <Check size={14} className="shrink-0 text-accent" aria-hidden />}
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </>
  );
}
