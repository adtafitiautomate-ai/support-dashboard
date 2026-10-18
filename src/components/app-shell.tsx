"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChangePassword } from "./change-password";
import { Users, BarChart3, Bell, BookOpen, ChevronDown, FileSpreadsheet, KeyRound, ShieldCheck, Ticket, Inbox, LogOut, Megaphone, MessageCircle, Radio, Settings, Smartphone } from "lucide-react";
import { WorkspaceProvider, useWorkspace } from "./workspace";
import { patch, useStore } from "@/lib/store";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Avatar, cx, relTime, useNow } from "./ui";
import { formatPhone } from "@/lib/format";
import type { AgentStatus } from "@/lib/types";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <WorkspaceProvider>
      <div className="relative flex h-dvh flex-col overflow-hidden">
        <TopBar />
        {/* No z-index here: modals/drawers inside pages must be able to cover the top bar. */}
        <main className="relative min-h-0 flex-1">
          <Gate>{children}</Gate>
        </main>
      </div>
    </WorkspaceProvider>
  );
}

/** Admins and supervisors (on any MVNO) and super admins manage; plain agents don't. */
function useAccess() {
  const isSuper = useStore((s) => !!s.me?.is_platform_admin);
  const isManager = useStore(
    (s) => !!s.me?.is_platform_admin || s.memberships.some((m) => m.user_id === s.me?.id && (m.role === "admin" || m.role === "supervisor")),
  );
  const isAdmin = useStore((s) => !!s.me?.is_platform_admin || s.memberships.some((m) => m.user_id === s.me?.id && m.role === "admin"));
  return { isSuper, isManager, isAdmin };
}

/** Agents < supervisors (managers) < admins < super admins. */
const canSee = (item: { managersOnly?: boolean; adminsOnly?: boolean; superOnly?: boolean }, a: { isSuper: boolean; isManager: boolean; isAdmin: boolean }) =>
  (!item.managersOnly || a.isManager) && (!item.adminsOnly || a.isAdmin) && (!item.superOnly || a.isSuper);

function Gate({ children }: { children: ReactNode }) {
  const { ready } = useWorkspace();
  const pathname = usePathname();
  const access = useAccess();
  if (!ready) {
    return (
      <div className="grid h-full place-items-center text-sm text-muted">
        <div className="flex items-center gap-2">
          <span className="size-2 animate-pulse rounded-full bg-accent" /> Connecting to your inbox…
        </div>
      </div>
    );
  }
  // Pages hidden from this role are also blocked when opened by URL (the APIs enforce it too).
  const page = NAV.find((n) => pathname.startsWith(n.href));
  if (page && !canSee(page, access)) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div className="card max-w-sm p-8">
          <ShieldCheck className="mx-auto size-8 text-muted" />
          <h1 className="mt-3 text-lg font-semibold">No access</h1>
          <p className="mt-1 text-sm text-muted">{page.label} is available to {page.superOnly ? "super admins" : page.adminsOnly ? "admins" : "supervisors and admins"}. Ask your admin if you need it.</p>
          <Link href="/inbox" className="mt-5 inline-flex rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white">
            Go to inbox
          </Link>
        </div>
      </div>
    );
  }
  return children;
}

/** Large page title row used by every page, matching the shell's style. */
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-3 pb-4">
      <div>
        <h1 className="text-[28px] leading-tight font-semibold tracking-tight">{title}</h1>
        {subtitle && <div className="mt-1 flex items-center gap-1.5 text-[13px] text-muted">{subtitle}</div>}
      </div>
      {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const NAV = [
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/tickets", label: "Tickets", icon: Ticket },
  { href: "/dashboard", label: "Insights", icon: BarChart3, managersOnly: true },
  { href: "/reports", label: "Reports", icon: FileSpreadsheet, managersOnly: true },
  { href: "/knowledge", label: "Knowledge", icon: BookOpen },
  { href: "/audience", label: "Audience", icon: Megaphone, managersOnly: true },
  { href: "/simulator", label: "Simulator", icon: Smartphone, adminsOnly: true },
  { href: "/settings", label: "Settings", icon: Settings, adminsOnly: true },
  { href: "/team", label: "Team", icon: Users, adminsOnly: true },
  { href: "/admin", label: "Admin", icon: ShieldCheck, superOnly: true },
] as { href: string; label: string; icon: typeof Inbox; managersOnly?: boolean; adminsOnly?: boolean; superOnly?: boolean }[];

function TopBar() {
  return (
    <header className="relative z-30 flex items-center gap-3 px-6 pt-4 pb-3">
      <Link href="/inbox" className="flex items-center gap-2">
        <span className="grid size-9 place-items-center rounded-xl bg-surface text-ink ring-1 ring-black/10 shadow-sm">
          <MessageCircle className="size-5" />
        </span>
        <span className="hidden text-lg font-semibold tracking-tight sm:block">Tuongee</span>
      </Link>
      <div className="flex flex-1 justify-center">
        <PillNav />
      </div>
      <div className="flex items-center gap-2">
        <LiveChip />
        <Notifications />
        <ProfileMenu />
      </div>
    </header>
  );
}

function PillNav() {
  const pathname = usePathname();
  const refs = useRef<Record<string, HTMLAnchorElement | null>>({});
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);
  const queue = useStore((s) => {
    let n = 0;
    for (const c of s.conversations.values()) if (c.status === "open" && !c.assignee_id) n++;
    return n;
  });

  const access = useAccess();
  const { isManager } = access;
  const items = NAV.filter((n) => canSee(n, access));

  const active = items.find((n) => pathname.startsWith(n.href))?.href;
  useLayoutEffect(() => {
    const el = active ? refs.current[active] : null;
    setPill(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
  }, [active, isManager]);

  return (
    <nav className="relative flex items-center gap-0.5 rounded-full glass p-1">
      {pill && (
        <span
          className="absolute top-1 bottom-1 rounded-full bg-surface shadow-sm ring-1 ring-black/5 transition-all duration-300 ease-out"
          style={{ left: pill.left, width: pill.width }}
        />
      )}
      {items.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          ref={(el) => {
            refs.current[href] = el;
          }}
          className={cx(
            "relative z-10 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors",
            active === href ? "text-ink" : "text-muted hover:text-ink",
          )}
        >
          <Icon className="size-4" />
          <span className="hidden md:inline">{label}</span>
          {href === "/inbox" && queue > 0 && (
            <span className="grid min-w-4.5 place-items-center rounded-full bg-danger px-1 text-[10px] leading-4 font-semibold text-white">{queue}</span>
          )}
        </Link>
      ))}
    </nav>
  );
}

function LiveChip() {
  const connected = useStore((s) => s.connected);
  return (
    <span
      title={connected ? "Realtime connected" : "Reconnecting…"}
      className="hidden items-center gap-1.5 rounded-full glass px-2.5 py-1.5 text-xs font-medium text-muted sm:flex"
    >
      <Radio className={cx("size-3.5", connected ? "text-accent" : "animate-pulse text-warn")} />
      {connected ? "Live" : "Reconnecting"}
    </span>
  );
}

function useClickAway(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);
  return ref;
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const ref = useClickAway(open, () => setOpen(false));
  const router = useRouter();
  const now = useNow(15_000);
  const s = useStore((s) => s);
  const waiting = [...s.conversations.values()]
    .filter((c) => c.status === "open" && (!c.assignee_id || (c.assignee_id === s.me?.id && c.unread_count > 0)))
    .sort((a, b) => b.last_message_at.localeCompare(a.last_message_at))
    .slice(0, 8);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative grid size-9 place-items-center rounded-full glass text-muted transition hover:text-ink"
        title="Waiting for you"
      >
        <Bell className="size-4" />
        {waiting.length > 0 && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-danger ring-2 ring-surface" />}
      </button>
      {open && (
        <div className="card absolute right-0 mt-2 w-80 overflow-hidden p-1.5">
          <div className="px-2.5 py-2 text-xs font-semibold tracking-wide text-muted uppercase">Waiting for you</div>
          {waiting.length === 0 && <div className="px-2.5 pb-3 text-sm text-muted">All caught up ✨</div>}
          {waiting.map((c) => {
            const contact = s.contacts.get(c.contact_id);
            return (
              <button
                key={c.id}
                onClick={() => {
                  setOpen(false);
                  router.push(`/inbox?c=${c.id}`);
                }}
                className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left hover:bg-surface-2"
              >
                <Avatar name={contact?.name ?? contact?.wa_id ?? "?"} size={30} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{contact?.name ?? (contact && formatPhone(contact.wa_id))}</div>
                  <div className="truncate text-xs text-muted">{c.subject ?? c.last_message_preview}</div>
                </div>
                <span className="text-[11px] text-muted">{relTime(c.last_message_at, now)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const STATUS: { value: AgentStatus; label: string; dot: string }[] = [
  { value: "online", label: "Online · receive chats", dot: "bg-emerald-500" },
  { value: "away", label: "Away · no new chats", dot: "bg-amber-500" },
  { value: "offline", label: "Offline", dot: "bg-zinc-400" },
];

function ProfileMenu() {
  const me = useStore((s) => s.me);
  const roles = useStore((s) => s.memberships.filter((m) => m.user_id === s.me?.id).length);
  const [open, setOpen] = useState(false);
  const [changingPw, setChangingPw] = useState(false);
  const ref = useClickAway(open, () => setOpen(false));
  if (!me) return <div className="h-9 w-40" />;

  async function setStatus(status: AgentStatus) {
    patch((s) => s.me && (s.me.status = status));
    setOpen(false);
    await supabaseBrowser().from("profiles").update({ status }).eq("id", me!.id);
  }
  const current = STATUS.find((x) => x.value === me.status)!;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-full glass py-1 pr-2.5 pl-1 transition"
      >
        <Avatar name={me.full_name} size={30} online={me.status === "online"} />
        <span className="hidden text-left leading-tight lg:block">
          <span className="block text-[13px] font-semibold">{me.full_name}</span>
          <span className="flex items-center gap-1 text-[11px] text-muted">
            <span className={cx("size-1.5 rounded-full", current.dot)} /> {me.status}
            {me.is_platform_admin ? " · admin" : roles ? ` · ${roles} MVNO${roles > 1 ? "s" : ""}` : ""}
          </span>
        </span>
        <ChevronDown className="size-3.5 text-muted" />
      </button>
      {open && (
        <div className="card absolute right-0 mt-2 w-60 p-1.5">
          {STATUS.map((s) => (
            <button
              key={s.value}
              onClick={() => setStatus(s.value)}
              className={cx("flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-sm hover:bg-surface-2", me.status === s.value && "font-medium")}
            >
              <span className={cx("size-2 rounded-full", s.dot)} /> {s.label}
            </button>
          ))}
          <div className="my-1 border-t border-line" />
          <button
            onClick={() => {
              setOpen(false);
              setChangingPw(true);
            }}
            className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-sm text-muted hover:bg-surface-2 hover:text-ink"
          >
            <KeyRound className="size-4" /> Change password
          </button>
          <button
            onClick={async () => {
              await supabaseBrowser().from("profiles").update({ status: "offline" }).eq("id", me.id);
              await supabaseBrowser().auth.signOut();
              window.location.assign(new URL("/login", window.location.origin)); // full reload clears the store
            }}
            className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-sm text-muted hover:bg-surface-2 hover:text-ink"
          >
            <LogOut className="size-4" /> Sign out
          </button>
        </div>
      )}
      {changingPw && <ChangePassword onClose={() => setChangingPw(false)} />}
    </div>
  );
}
