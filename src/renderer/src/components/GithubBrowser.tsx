import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  Download,
  ExternalLink,
  GitBranch,
  GitFork,
  Loader2,
  Package,
  RefreshCw,
  Search,
  Star,
  Tag
} from 'lucide-react'
import type {
  GithubAsset,
  GithubRelease,
  GithubRepo,
  GithubRepoDetails,
  GithubSearchResult
} from '@shared/types'
import { useApp } from '../state'
import { cleanIpcError, cn, formatBytes } from '../lib/format'

const POPULAR_QUERY = 'stars:>10000'

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function shortDate(iso: string): string {
  if (!iso) return '-'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function GithubBrowser(): React.JSX.Element {
  const { t, settings, pushToast } = useApp()
  const [term, setTerm] = useState('')
  const [result, setResult] = useState<GithubSearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [moreLoading, setMoreLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rateLimited, setRateLimited] = useState(false)
  const [popular, setPopular] = useState(true)
  const [selected, setSelected] = useState<GithubRepoDetails | null>(null)
  const [repoLoading, setRepoLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [page, setPage] = useState(1)

  const requestId = useRef(0)
  const lastQuery = useRef(POPULAR_QUERY)

  const runSearch = useCallback(
    async (raw: string, isPopular = false): Promise<void> => {
      const q = raw.trim()
      if (!q) return
      const id = ++requestId.current
      lastQuery.current = q
      setLoading(true)
      setError(null)
      setRateLimited(false)
      setSelected(null)
      setPopular(isPopular)
      setPage(1)
      try {
        const res = await window.pulse.githubSearch(q, 1)
        if (id !== requestId.current) return
        setResult(res)
      } catch (err) {
        if (id !== requestId.current) return
        const message = cleanIpcError(err, t.github.error)
        setError(message)
        setRateLimited(/rate limit|403/i.test(message))
        setResult(null)
      } finally {
        if (id === requestId.current) setLoading(false)
      }
    },
    [t.github.error]
  )

  useEffect(() => {
    void runSearch(POPULAR_QUERY, true)
  }, [])

  const loadMore = async (): Promise<void> => {
    if (!result || moreLoading) return
    setMoreLoading(true)
    try {
      const next = await window.pulse.githubSearch(lastQuery.current, page + 1)
      setResult((prev) =>
        prev ? { ...next, items: [...prev.items, ...next.items] } : next
      )
      setPage((p) => p + 1)
    } catch (err) {
      pushToast('error', cleanIpcError(err, t.github.error))
    } finally {
      setMoreLoading(false)
    }
  }

  const openRepo = async (repo: GithubRepo): Promise<void> => {
    setRepoLoading(true)
    try {
      const details = await window.pulse.githubRepo(repo.fullName)
      setSelected(details)
    } catch (err) {
      pushToast('error', cleanIpcError(err, t.github.error))
    } finally {
      setRepoLoading(false)
    }
  }

  const addDownload = async (key: string, url: string, fileName: string): Promise<void> => {
    setBusy(key)
    try {
      await window.pulse.addDownload({ url, fileName, dir: settings.downloadDir })
      pushToast('success', t.github.added)
    } catch (err) {
      pushToast('error', cleanIpcError(err, t.github.error))
    } finally {
      setBusy(null)
    }
  }

  const addAsset = (release: GithubRelease, asset: GithubAsset): void => {
    void addDownload(`asset-${asset.id}`, asset.url, asset.name)
  }

  const quickSearches: Array<{ label: string; query: string }> = [
    { label: t.github.quickDownloader, query: 'download manager' },
    { label: t.github.quickTorrent, query: 'torrent client' },
    { label: t.github.quickElectron, query: 'electron' },
    { label: t.github.quickCli, query: 'awesome cli' }
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line/60 px-5 py-3">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void runSearch(term)
          }}
        >
          <div className="relative min-w-0 flex-1">
            <Search
              size={15}
              className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-faint"
            />
            <input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder={t.github.searchPlaceholder}
              aria-label={t.github.searchPlaceholder}
              className="field h-10 w-full ps-9 pe-3 text-[12px]"
              dir="auto"
            />
          </div>
          <button type="submit" className="btn btn-primary h-10 px-4 text-[12px]" disabled={loading}>
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
            {t.github.search}
          </button>
        </form>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-semibold text-faint">
            {t.github.quick}
          </span>
          {quickSearches.map((item) => (
            <button
              key={item.query}
              type="button"
              onClick={() => {
                setTerm(item.query)
                void runSearch(item.query)
              }}
              className="chip h-6 rounded-md! px-2.5! text-[9.5px] transition hover:border-brand/40 hover:text-ink"
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="scroll-y min-h-0 flex-1 px-5 py-4">
        {selected ? (
          <RepoDetails
            repo={selected}
            busy={busy}
            onBack={() => setSelected(null)}
            onDownload={addDownload}
            onAsset={addAsset}
          />
        ) : loading && !result ? (
          <div className="mt-16 flex flex-col items-center gap-3 text-muted">
            <Loader2 size={26} className="animate-spin text-brand" />
            <span className="text-[11.5px]">{t.github.loading}</span>
          </div>
        ) : error ? (
          <div className="mx-auto mt-12 max-w-lg rounded-xl border border-bad/30 bg-bad/8 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle size={18} className="mt-0.5 shrink-0 text-bad" />
              <div className="min-w-0">
                <div className="text-[12px] font-semibold text-bad">
                  {rateLimited ? t.github.rateLimit : t.github.error}
                </div>
                <p className="mt-1 break-words text-[10.5px] leading-relaxed text-muted">{error}</p>
                {rateLimited ? (
                  <p className="mt-2 text-[10px] leading-relaxed text-faint">{t.github.rateLimitHint}</p>
                ) : null}
                <button
                  type="button"
                  onClick={() => void runSearch(lastQuery.current, popular)}
                  className="btn btn-soft mt-3 h-8 px-3 text-[10px]"
                >
                  <RefreshCw size={12} />
                  {t.github.retry}
                </button>
              </div>
            </div>
          </div>
        ) : result ? (
          <>
            <div className="mb-3 flex items-baseline gap-2">
              <h2 className="text-[13px] font-bold">
                {popular ? t.github.popular : t.github.results}
              </h2>
              <span className="text-[10px] text-faint tabular">
                {compact(result.total)} {t.github.results}
              </span>
              {repoLoading ? <Loader2 size={13} className="animate-spin text-brand" /> : null}
            </div>

            {result.items.length === 0 ? (
              <div className="mt-16 text-center">
                <GitBranch size={30} className="mx-auto text-faint/60" />
                <div className="mt-3 text-[12px] font-semibold">{t.github.empty}</div>
                <p className="mx-auto mt-1 max-w-sm text-[10px] leading-relaxed text-faint">
                  {t.github.emptyHint}
                </p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-2.5 2xl:grid-cols-2">
                  {result.items.map((repo) => (
                    <RepoCard
                      key={repo.id}
                      repo={repo}
                      busy={busy}
                      onOpen={() => void openRepo(repo)}
                      onDownload={() =>
                        void addDownload(
                          `zip-${repo.id}`,
                          repo.zipUrl,
                          `${repo.name}-${repo.defaultBranch}.zip`
                        )
                      }
                    />
                  ))}
                </div>
                {result.items.length < result.total ? (
                  <div className="mt-4 flex justify-center">
                    <button
                      type="button"
                      onClick={() => void loadMore()}
                      disabled={moreLoading}
                      className="btn btn-ghost h-9 px-4 text-[11px]"
                    >
                      {moreLoading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                      {t.github.loadMore}
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </>
        ) : null}
      </div>
    </div>
  )
}

function RepoCard({
  repo,
  busy,
  onOpen,
  onDownload
}: {
  repo: GithubRepo
  busy: string | null
  onOpen: () => void
  onDownload: () => void
}): React.JSX.Element {
  const { t } = useApp()
  const zipBusy = busy === `zip-${repo.id}`
  return (
    <article className="group rounded-xl border border-line/70 bg-panel/45 p-3 transition hover:border-brand/35 hover:bg-panel/70">
      <div className="flex items-start gap-2.5">
        {repo.ownerAvatar ? (
          <img
            src={repo.ownerAvatar}
            alt=""
            className="h-9 w-9 shrink-0 rounded-lg border border-line/70 bg-elev2 object-cover"
            loading="lazy"
          />
        ) : (
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line/70 bg-elev2 text-faint">
            <GitBranch size={15} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onOpen}
              className="truncate text-start text-[12px] font-semibold transition hover:text-brand"
              title={repo.fullName}
            >
              {repo.fullName}
            </button>
            {repo.archived ? (
              <span className="shrink-0 rounded border border-warn/30 bg-warn/10 px-1 py-px text-[8px] font-semibold text-warn">
                {t.github.archived}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 line-clamp-2 min-h-[2.1em] text-[10px] leading-relaxed text-muted">
            {repo.description || '-'}
          </p>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] text-faint">
        <span className="flex items-center gap-1 tabular">
          <Star size={10} className="text-muted" /> {compact(repo.stars)}
        </span>
        <span className="flex items-center gap-1 tabular">
          <GitFork size={10} /> {compact(repo.forks)}
        </span>
        {repo.language ? (
          <span className="flex items-center gap-1">
            {repo.language}
          </span>
        ) : null}
        {repo.license ? <span className="truncate">{repo.license}</span> : null}
        <span className="ms-auto shrink-0">{shortDate(repo.updatedAt)}</span>
      </div>

      <div className="mt-2.5 flex items-center gap-1.5">
        <button
          type="button"
          onClick={onDownload}
          disabled={!!busy}
          className="btn btn-soft h-7.5 px-2.5 text-[9.5px]"
        >
          {zipBusy ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
          {t.github.downloadZip}
        </button>
        <button
          type="button"
          onClick={onOpen}
          className="btn btn-ghost h-7.5 px-2.5 text-[9.5px]"
        >
          <Tag size={11} />
          {t.github.releases}
        </button>
        <button
          type="button"
          onClick={() => void window.pulse.openExternal(repo.htmlUrl)}
          className="icon-btn ms-auto h-7 w-7"
          title={t.github.open}
          aria-label={t.github.open}
        >
          <ExternalLink size={12} />
        </button>
      </div>
    </article>
  )
}

function RepoDetails({
  repo,
  busy,
  onBack,
  onDownload,
  onAsset
}: {
  repo: GithubRepoDetails
  busy: string | null
  onBack: () => void
  onDownload: (key: string, url: string, fileName: string) => Promise<void>
  onAsset: (release: GithubRelease, asset: GithubAsset) => void
}): React.JSX.Element {
  const { t } = useApp()
  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onBack}
          className="icon-btn mt-0.5 h-8 w-8 shrink-0"
          aria-label={t.common.back}
        >
          <ArrowLeft size={15} />
        </button>
        {repo.ownerAvatar ? (
          <img
            src={repo.ownerAvatar}
            alt=""
            className="h-11 w-11 shrink-0 rounded-xl border border-line/70 bg-elev2 object-cover"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-bold tracking-tight">{repo.fullName}</h2>
          <p className="mt-0.5 text-[10.5px] leading-relaxed text-muted">{repo.description || '-'}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[9.5px] text-faint">
            <span className="chip h-5.5 rounded-md! px-2!">
              <Star size={10} className="text-muted" /> {compact(repo.stars)}
            </span>
            <span className="chip h-5.5 rounded-md! px-2!">
              <GitFork size={10} /> {compact(repo.forks)}
            </span>
            {repo.language ? <span className="chip h-5.5 rounded-md! px-2!">{repo.language}</span> : null}
            {repo.license ? <span className="chip h-5.5 rounded-md! px-2!">{repo.license}</span> : null}
            <span>{t.github.updated}: {shortDate(repo.updatedAt)}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void window.pulse.openExternal(repo.htmlUrl)}
          className="btn btn-ghost h-8 shrink-0 px-2.5 text-[10px]"
        >
          <ExternalLink size={12} />
          {t.github.open}
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-line/70 bg-panel/45 p-3">
        <div className="flex items-center gap-2 text-[10.5px] font-semibold">
          <Package size={14} className="text-brand" />
          {t.github.sourceZip}
        </div>
        <span className="text-[9px] text-faint">{repo.defaultBranch}</span>
        <button
          type="button"
          onClick={() =>
            void onDownload(
              'source',
              repo.zipUrl,
              `${repo.name}-${repo.defaultBranch}.zip`
            )
          }
          disabled={!!busy}
          className="btn btn-primary ms-auto h-8 px-3 text-[10px]"
        >
          {busy === 'source' ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
          {t.github.downloadZip}
        </button>
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-[12px] font-bold">{t.github.releases}</h3>
          <span className="text-[10px] text-faint tabular">{repo.releases.length}</span>
        </div>

        {repo.releases.length === 0 ? (
          <div className="rounded-xl border border-line/70 bg-panel/40 p-4 text-[10.5px] text-faint">
            {t.github.noReleases}
          </div>
        ) : (
          <div className="space-y-2.5">
            {repo.releases.map((release) => (
              <ReleaseCard
                key={release.id}
                release={release}
                busy={busy}
                onAsset={onAsset}
                onSource={() =>
                  void onDownload(
                    `rel-${release.id}`,
                    release.zipUrl,
                    `${repo.name}-${release.tagName}.zip`
                  )
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ReleaseCard({
  release,
  busy,
  onAsset,
  onSource
}: {
  release: GithubRelease
  busy: string | null
  onAsset: (release: GithubRelease, asset: GithubAsset) => void
  onSource: () => void
}): React.JSX.Element {
  const { t } = useApp()
  return (
    <div className="rounded-xl border border-line/70 bg-panel/45 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tag size={12} className="text-brand" />
        <span className="text-[11.5px] font-semibold">{release.name}</span>
        {release.tagName !== release.name ? (
          <span className="chip h-5 rounded-md! px-1.5! text-[8.5px]">{release.tagName}</span>
        ) : null}
        {release.prerelease ? (
          <span className="rounded border border-warn/30 bg-warn/10 px-1 py-px text-[8px] font-semibold text-warn">
            pre
          </span>
        ) : null}
        <span className="ms-auto text-[9px] text-faint">{shortDate(release.publishedAt)}</span>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={onSource}
          disabled={!!busy}
          className="btn btn-ghost h-7 px-2 text-[9px]"
        >
          {busy === `rel-${release.id}` ? (
            <Loader2 size={10} className="animate-spin" />
          ) : (
            <Download size={10} />
          )}
          {t.github.sourceZip}
        </button>
        {release.assets.length === 0 ? (
          <span className="self-center text-[9px] text-faint">{t.github.noAssets}</span>
        ) : (
          release.assets.map((asset) => (
            <button
              key={asset.id}
              type="button"
              onClick={() => onAsset(release, asset)}
              disabled={!!busy}
              title={`${asset.name} · ${formatBytes(asset.size)} · ${asset.downloadCount} ${t.github.downloads}`}
              className={cn(
                'btn btn-soft h-7 max-w-full px-2 text-[9px]',
                busy === `asset-${asset.id}` && 'opacity-70'
              )}
            >
              {busy === `asset-${asset.id}` ? (
                <Loader2 size={10} className="animate-spin" />
              ) : (
                <Download size={10} />
              )}
              <span className="max-w-[220px] truncate" dir="ltr">
                {asset.name}
              </span>
              {asset.size > 0 ? (
                <span className="text-faint tabular" dir="ltr">({formatBytes(asset.size)})</span>
              ) : null}
            </button>
          ))
        )}
      </div>
    </div>
  )
}
