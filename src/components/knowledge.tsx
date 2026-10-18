"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, BookOpen, CheckCircle2, FileText, Globe, Link2, Loader2, Pencil, Plus, RefreshCw, Search, Trash2, UploadCloud, X } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { useStore } from "@/lib/store";
import type { KbArticle } from "@/lib/types";
import { PageHeader } from "./app-shell";
import { LocationsPanel } from "./locations";
import { useWorkspace } from "./workspace";
import { Badge, Button, cx, Pager, relTime, useNow } from "./ui";

interface KbSource {
  id: string;
  mvno_id: string;
  kind: "file" | "url";
  name: string;
  url: string | null;
  status: "processing" | "ready" | "failed";
  error: string | null;
  article_count: number;
  created_at: string;
  updated_at: string;
}

type Article = KbArticle & { source_id: string | null };
const input = "w-full rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm outline-none focus:border-ink/30";

export function KnowledgeView() {
  const { onEvent } = useWorkspace();
  const now = useNow(30_000);
  const mvnos = useStore((s) => [...s.mvnos.values()]);
  const [mvnoId, setMvnoId] = useState(mvnos[0]?.id ?? "");
  const [sources, setSources] = useState<KbSource[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [filter, setFilter] = useState<string>("all"); // all | manual | <sourceId>
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Partial<Article> | null>(null);
  const [testQ, setTestQ] = useState("");
  const [testHits, setTestHits] = useState<KbArticle[] | null>(null);

  useEffect(() => {
    const supabase = supabaseBrowser();
    const loadSources = () =>
      supabase.from("kb_sources").select("*").eq("mvno_id", mvnoId).order("created_at", { ascending: false }).then(({ data }) => setSources(data ?? []));
    const loadArticles = () =>
      supabase.from("kb_articles").select("id,mvno_id,source_id,title,body,tags,updated_at").eq("mvno_id", mvnoId).order("title").limit(2000).then(({ data }) => setArticles((data ?? []) as Article[]));
    void loadSources();
    void loadArticles();
    // Live: a source flips to ready/failed while you watch; reload its articles.
    return onEvent((table, record) => {
      if (table !== "kb_sources" || record.mvno_id !== mvnoId) return;
      setSources((list) => {
        const s = record as unknown as KbSource;
        const rest = list.filter((x) => x.id !== s.id);
        return [s, ...rest].sort((a, b) => b.created_at.localeCompare(a.created_at));
      });
      if (record.status !== "processing") void loadArticles();
    });
  }, [mvnoId, onEvent]);

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return articles.filter(
      (a) =>
        (filter === "all" || (filter === "manual" ? !a.source_id : a.source_id === filter)) &&
        (!term || `${a.title} ${a.body} ${a.tags.join(" ")}`.toLowerCase().includes(term)),
    );
  }, [articles, filter, q]);

  // 6 articles per page; the page resets when the filter, search or MVNO changes.
  const PER_PAGE = 6;
  const listKey = `${mvnoId}|${filter}|${q}`;
  const [pageState, setPageState] = useState({ key: listKey, page: 0 });
  const pageCount = Math.max(1, Math.ceil(shown.length / PER_PAGE));
  const page = pageState.key === listKey ? Math.min(pageState.page, pageCount - 1) : 0;
  const pageItems = shown.slice(page * PER_PAGE, (page + 1) * PER_PAGE);

  const sourceName = (id: string | null) => sources.find((s) => s.id === id)?.name;

  async function saveArticle(e: { preventDefault(): void }) {
    e.preventDefault();
    if (!editing) return;
    const row = { mvno_id: mvnoId, title: editing.title ?? "", body: editing.body ?? "", tags: editing.tags ?? [], updated_at: new Date().toISOString() };
    const supabase = supabaseBrowser();
    const res = editing.id
      ? await supabase.from("kb_articles").update(row).eq("id", editing.id).select().single()
      : await supabase.from("kb_articles").insert(row).select().single();
    if (res.data) {
      setArticles((list) => [...list.filter((a) => a.id !== res.data.id), res.data as Article].sort((a, b) => a.title.localeCompare(b.title)));
      setEditing(null);
    } else alert(res.error?.message ?? "Only supervisors and admins can edit the knowledge base");
  }

  async function runTest(e: { preventDefault(): void }) {
    e.preventDefault();
    if (!testQ.trim()) return;
    const { data } = await supabaseBrowser().rpc("search_kb", { p_mvno: mvnoId, p_query: testQ, p_limit: 5 });
    setTestHits((data ?? []) as KbArticle[]);
  }

  return (
    <div className="h-full overflow-y-auto px-6 pb-6">
      <PageHeader
        title="Knowledge"
        subtitle={
          <>
            <BookOpen className="size-3.5" /> Train the bot from documents, web pages and your own answers
          </>
        }
        actions={
          mvnos.length > 1 && (
            <select value={mvnoId} onChange={(e) => setMvnoId(e.target.value)} className="h-9 rounded-full bg-surface px-3 text-sm shadow-sm ring-1 ring-black/5 outline-none">
              {mvnos.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          )
        }
      />

      <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
        {/* Left: sources */}
        <div className="space-y-4">
          <Trainer mvnoId={mvnoId} onAdded={(s) => setSources((list) => [s, ...list.filter((x) => x.id !== s.id)])} />

          <section className="card p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Sources</h2>
              <span className="text-xs text-muted">{sources.length}</span>
            </div>
            {sources.length === 0 && <p className="py-4 text-center text-sm text-muted">No documents or links yet.</p>}
            <ul className="space-y-1.5">
              {sources.map((s) => (
                <li key={s.id} className={cx("group rounded-2xl p-2.5 transition", filter === s.id ? "bg-accent-soft" : "bg-surface-2")}>
                  <div className="flex items-start gap-2.5">
                    <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl bg-surface text-muted">
                      {s.kind === "url" ? <Globe className="size-4" /> : <FileText className="size-4" />}
                    </span>
                    <button onClick={() => setFilter(filter === s.id ? "all" : s.id)} className="min-w-0 flex-1 text-left">
                      <div className="truncate text-[13px] font-medium" title={s.name}>
                        {s.name}
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px] text-muted">
                        {s.status === "processing" && (
                          <>
                            <Loader2 className="size-3 animate-spin text-accent" /> Reading & learning…
                          </>
                        )}
                        {s.status === "ready" && (
                          <>
                            <CheckCircle2 className="size-3 text-accent" /> {s.article_count} articles · {relTime(s.updated_at, now)}
                          </>
                        )}
                        {s.status === "failed" && (
                          <span className="flex items-center gap-1 text-danger" title={s.error ?? ""}>
                            <AlertCircle className="size-3" /> {s.error ?? "Failed"}
                          </span>
                        )}
                      </div>
                    </button>
                    <div className="flex opacity-0 transition group-hover:opacity-100">
                      {s.kind === "url" && s.status !== "processing" && (
                        <button
                          title="Re-sync link"
                          onClick={() => fetch(`/api/kb/sources/${s.id}`, { method: "POST" })}
                          className="grid size-7 place-items-center rounded-lg text-muted hover:bg-surface hover:text-ink"
                        >
                          <RefreshCw className="size-3.5" />
                        </button>
                      )}
                      <button
                        title="Remove source and its articles"
                        onClick={async () => {
                          const { error } = await supabaseBrowser().from("kb_sources").delete().eq("id", s.id);
                          if (!error) {
                            setSources((list) => list.filter((x) => x.id !== s.id));
                            setArticles((list) => list.filter((a) => a.source_id !== s.id));
                            if (filter === s.id) setFilter("all");
                          }
                        }}
                        className="grid size-7 place-items-center rounded-lg text-muted hover:bg-surface hover:text-danger"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="card p-4">
            <h2 className="mb-1 text-sm font-semibold">Test what the bot knows</h2>
            <p className="mb-2 text-xs text-muted">Type a customer question to see which articles the bot would use to answer.</p>
            <form onSubmit={runTest} className="flex gap-2">
              <input value={testQ} onChange={(e) => setTestQ(e.target.value)} placeholder="e.g. how do I swap my SIM?" className={input} />
              <Button variant="primary" className="h-9">
                <Search className="size-4" />
              </Button>
            </form>
            {testHits && (
              <ul className="mt-3 space-y-1.5">
                {testHits.length === 0 && <li className="text-xs text-warn">No match: the bot would hand this question to an agent.</li>}
                {testHits.map((h, i) => (
                  <li key={h.id} className="rounded-xl bg-surface-2 px-3 py-2 text-[13px]">
                    <span className="mr-1.5 text-muted">{i + 1}.</span>
                    {h.title}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* Right: articles */}
        <section className="card flex min-h-[500px] flex-col p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">Articles</h2>
            <span className="text-xs text-muted">{shown.length}</span>
            <select value={filter} onChange={(e) => setFilter(e.target.value)} className="h-8 rounded-full border border-line bg-surface-2 px-2.5 text-xs">
              <option value="all">All sources</option>
              <option value="manual">Written by hand</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name.slice(0, 40)}
                </option>
              ))}
            </select>
            <label className="ml-auto flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-3 py-1.5">
              <Search className="size-3.5 text-muted" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter articles" className="w-40 bg-transparent text-xs outline-none" />
            </label>
            <Button variant="primary" size="sm" className="rounded-full" onClick={() => setEditing({})}>
              <Plus className="size-3.5" /> Write article
            </Button>
          </div>

          {editing && (
            <form onSubmit={saveArticle} className="mb-3 space-y-2 rounded-2xl border border-line bg-surface-2 p-3">
              <div className="text-xs font-semibold">{editing.id ? "Edit article" : "New article"}</div>
              {editing.source_id && (
                <p className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11.5px] text-amber-800 ring-1 ring-amber-200">
                  From {sourceName(editing.source_id) ?? "a document"}. Your edits apply straight away, but re-training that document later replaces its articles.
                </p>
              )}
              <input className={input} placeholder="Question or topic, e.g. How do I check my balance?" value={editing.title ?? ""} onChange={(e) => setEditing({ ...editing, title: e.target.value })} required />
              <textarea rows={5} className={input} placeholder="The answer the bot should give: facts, steps, prices, codes" value={editing.body ?? ""} onChange={(e) => setEditing({ ...editing, body: e.target.value })} required />
              <input
                className={input}
                placeholder="tags, comma separated"
                value={(editing.tags ?? []).join(", ")}
                onChange={(e) => setEditing({ ...editing, tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) })}
              />
              <div className="flex gap-2">
                <Button variant="primary">Save</Button>
                <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}

          <ul className="flex-1 space-y-2 overflow-y-auto">
            {shown.length === 0 && <li className="py-16 text-center text-sm text-muted">No articles match.</li>}
            {pageItems.map((a) => (
              <li key={a.id} className="group rounded-2xl bg-surface-2 p-3">
                <div className="flex items-start gap-2">
                  <button className="min-w-0 flex-1 text-left" onClick={() => setEditing(a)}>
                    <div className="text-[13.5px] font-medium">{a.title}</div>
                    <div className="mt-0.5 line-clamp-2 text-[13px] text-muted">{a.body}</div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      {a.source_id ? (
                        <Badge tone="blue">
                          <Link2 className="size-3" /> {sourceName(a.source_id)?.slice(0, 32) ?? "source"}
                        </Badge>
                      ) : (
                        <Badge tone="violet">hand-written</Badge>
                      )}
                      {a.tags.map((t) => (
                        <Badge key={t}>{t}</Badge>
                      ))}
                    </div>
                  </button>
                  <button
                    title="Edit article"
                    onClick={() => setEditing(a)}
                    className="grid size-7 place-items-center rounded-lg text-muted transition hover:bg-surface hover:text-ink"
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    title="Delete article"
                    onClick={async () => {
                      const { error } = await supabaseBrowser().from("kb_articles").delete().eq("id", a.id);
                      if (!error) setArticles((list) => list.filter((x) => x.id !== a.id));
                    }}
                    className="grid size-7 place-items-center rounded-lg text-muted opacity-0 transition group-hover:opacity-100 hover:bg-surface hover:text-danger"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <Pager page={page} pageSize={PER_PAGE} total={shown.length} onPage={(n) => setPageState({ key: listKey, page: n })} label="articles" />
        </section>
      </div>

      <LocationsPanel key={mvnoId} mvnoId={mvnoId} />
    </div>
  );
}

function Trainer({ mvnoId, onAdded }: { mvnoId: string; onAdded: (s: KbSource) => void }) {
  const [url, setUrl] = useState("");
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function upload(form: FormData) {
    setBusy(true);
    setError(null);
    form.set("mvnoId", mvnoId);
    try {
      const res = await fetch("/api/kb/sources", { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Upload failed");
      onAdded(json.source);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addFiles(files: FileList | null) {
    for (const f of Array.from(files ?? [])) {
      const form = new FormData();
      form.set("file", f);
      await upload(form);
    }
  }

  return (
    <section className="card p-4">
      <h2 className="text-sm font-semibold">Train the bot</h2>
      <p className="mb-3 text-xs text-muted">The AI reads each source and turns it into short answer articles. Usually takes under a minute.</p>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void addFiles(e.dataTransfer.files);
        }}
        onClick={() => fileInput.current?.click()}
        className={cx(
          "grid cursor-pointer place-items-center rounded-2xl border-2 border-dashed px-4 py-7 text-center transition",
          drag ? "border-ink/30 bg-surface-2" : "border-line bg-surface-2 hover:border-ink/20",
        )}
      >
        {busy ? <Loader2 className="size-6 animate-spin text-accent" /> : <UploadCloud className="size-6 text-muted" />}
        <div className="mt-2 text-sm font-medium">Drop documents or click to upload</div>
        <div className="text-xs text-muted">PDF, TXT, Markdown, CSV, HTML · up to 20 MB</div>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".pdf,.txt,.md,.markdown,.csv,.html,.htm,.json"
          className="hidden"
          onChange={(e) => {
            void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!url.trim()) return;
          const form = new FormData();
          form.set("url", url.trim());
          void upload(form).then(() => setUrl(""));
        }}
      >
        <label className="flex flex-1 items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 focus-within:border-ink/30">
          <Link2 className="size-4 text-muted" />
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://yourmvno.com/faq" className="w-full bg-transparent py-2 text-sm outline-none" />
        </label>
        <Button variant="primary" className="h-auto rounded-xl" disabled={busy || !url.trim()}>
          Add link
        </Button>
      </form>
      {error && (
        <p className="mt-2 flex items-center gap-1 text-xs text-danger">
          <X className="size-3" /> {error}
        </p>
      )}
    </section>
  );
}
