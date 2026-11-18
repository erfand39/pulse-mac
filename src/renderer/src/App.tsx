import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowDownToLine, Magnet } from 'lucide-react'
import { useApp } from './state'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { StatsStrip } from './components/StatsStrip'
import { DownloadList } from './components/DownloadList'
import { DetailPanel } from './components/DetailPanel'
import { StatusBar } from './components/StatusBar'
import { AddDownloadModal } from './components/AddDownloadModal'
import { SettingsModal } from './components/SettingsModal'
import { NewLinkModal } from './components/NewLinkModal'
import { GithubBrowser } from './components/GithubBrowser'
import { Toasts } from './components/Toasts'
import { Logo } from './components/primitives'
import { cleanIpcError } from './lib/format'

function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function App(): React.JSX.Element {
  const { ready, loadError, openAdd, pushToast, t, addOpen, settings, view } = useApp()
  const [dropping, setDropping] = useState(false)
  const [dropKind, setDropKind] = useState<'url' | 'torrent'>('url')

  useEffect(() => {
    let depth = 0
    const onEnter = (e: DragEvent): void => {
      if (addOpen) return
      e.preventDefault()
      depth++
      if (e.dataTransfer) {
        const hasFiles = Array.from(e.dataTransfer.types).includes('Files')
        setDropKind(hasFiles ? 'torrent' : 'url')
      }
      setDropping(true)
    }
    const onOver = (e: DragEvent): void => {
      if (addOpen) return
      e.preventDefault()
    }
    const onLeave = (): void => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDropping(false)
    }
    const onDrop = async (e: DragEvent): Promise<void> => {
      if (addOpen) return
      e.preventDefault()
      depth = 0
      setDropping(false)
      const file = e.dataTransfer?.files?.[0]
      if (file && /\.torrent$/i.test(file.name)) {
        if (file.size > 1024 * 1024) {
          pushToast('error', t.add.errorTorrent)
          return
        }
        try {
          const buffer = await file.arrayBuffer()
          await window.pulse.addTorrent({
            data: base64(buffer),
            name: file.name.replace(/\.torrent$/i, ''),
            dir: settings.downloadDir
          })
          pushToast('success', t.toast.added)
        } catch (err) {
          pushToast('error', cleanIpcError(err, t.add.errorTorrent))
        }
        return
      }
      const text = e.dataTransfer?.getData('text/plain') || e.dataTransfer?.getData('text/uri-list')
      if (text) {
        if (/^magnet:/i.test(text)) {
          openAdd({ url: text, tab: 'torrent' })
        } else if (/^https?:/i.test(text)) {
          openAdd({ url: text })
        }
      }
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [addOpen, openAdd, pushToast, settings.downloadDir, t])

  if (!ready) {
    return (
      <div className="app-bg flex h-full flex-col items-center justify-center gap-5">
        <Logo size={62} glow={false} />
        <div className="h-1 w-32 overflow-hidden rounded-full bg-elev2">
          <div className="indeterminate h-full rounded-full" />
        </div>
        <div className="text-[12px] font-medium text-muted">Pulse</div>
      </div>
    )
  }

  return (
    <div className="app-bg flex h-full flex-col overflow-hidden text-ink">
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          {view === 'github' ? (
            <GithubBrowser />
          ) : (
            <>
              <StatsStrip />
              <div className="relative flex min-h-0 flex-1">
                <div className="flex min-w-0 flex-1 flex-col">
                  {loadError ? (
                    <div className="scroll-y flex-1 p-5">
                      <div className="mx-auto mt-16 flex max-w-md items-start gap-3 rounded-xl2 border border-bad/30 bg-bad/8 p-4">
                        <AlertTriangle size={18} className="mt-0.5 text-bad" />
                        <div>
                          <div className="text-[12px] font-semibold text-bad">Could not load the app state</div>
                          <p className="mt-1 text-[10.5px] leading-relaxed text-muted">{loadError}</p>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <DownloadList />
                  )}
                </div>
                <DetailPanel />
              </div>
            </>
          )}
        </main>
      </div>
      <StatusBar />

      <AddDownloadModal />
      <SettingsModal />
      <NewLinkModal />
      <Toasts />

      {dropping ? (
        <div className="pointer-events-none fixed inset-0 z-[100] grid place-items-center bg-app/80">
          <div className="anim-fade flex flex-col items-center gap-3 rounded-xl2 border border-line2 bg-panel px-10 py-8 shadow-[var(--shadow-overlay)]">
            <div className="grid h-14 w-14 place-items-center rounded-lg bg-brand/12 text-brand">
              {dropKind === 'torrent' ? <Magnet size={24} /> : <ArrowDownToLine size={24} />}
            </div>
            <div className="text-[12.5px] font-semibold">
              {dropKind === 'torrent' ? t.add.dropTorrent : t.empty.desc}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
