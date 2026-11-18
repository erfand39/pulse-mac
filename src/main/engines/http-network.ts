import { ProxyAgent, Socks5ProxyAgent, type Dispatcher } from 'undici'
import { httpUrl } from '../validate'

const REDIRECTS = new Set([301, 302, 303, 307, 308])
const SAFE_REDIRECT_HEADERS = new Set(['accept', 'accept-language', 'accept-encoding', 'user-agent', 'range', 'if-range'])

export class HttpNetwork {
  private agents = new Map<string, Dispatcher>()

  constructor(private resolveProxy?: (url: string) => Promise<string | undefined>) {}

  async request(url: string, headers: Headers, signal: AbortSignal): Promise<Response> {
    let next = httpUrl.parse(url)
    for (let count = 0; count <= 5; count++) {
      signal.throwIfAborted()
      const proxy = await this.resolveProxy?.(next)
      const dispatcher = proxy ? await this.proxyAgent(proxy) : undefined
      const response = await fetch(next, {
        headers, signal, redirect: 'manual', dispatcher
      } as RequestInit)
      if (!REDIRECTS.has(response.status)) return response
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location || count === 5) throw new Error('Too many redirects or invalid redirect.')
      const target = new URL(location, next)
      httpUrl.parse(target.href)
      const previous = new URL(next)
      if (previous.protocol === 'https:' && target.protocol !== 'https:') {
        throw new Error('Insecure redirect blocked.')
      }
      if (previous.origin !== target.origin) {
        headers = new Headers([...headers].filter(([key]) => SAFE_REDIRECT_HEADERS.has(key.toLowerCase())))
      }
      next = target.href
    }
    throw new Error('Too many redirects.')
  }

  private async proxyAgent(url: string): Promise<Dispatcher> {
    const existing = this.agents.get(url)
    if (existing) return existing
    if (this.agents.size >= 16) throw new Error('Too many proxy endpoints. Restart Pulse Mac.')
    const agent = url.startsWith('socks5:') ? new Socks5ProxyAgent(url) : new ProxyAgent(url)
    this.agents.set(url, agent)
    return agent
  }

  async close(): Promise<void> {
    await Promise.all([...this.agents.values()].map((agent) => agent.destroy()))
    this.agents.clear()
  }
}
