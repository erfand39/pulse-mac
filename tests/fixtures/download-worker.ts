import { HttpEngine } from '../../src/main/engines/http'
import { GlobalThrottle } from '../../src/main/util'
import type { DownloadTask, Settings } from '../../src/shared/types'

const task: DownloadTask = JSON.parse(process.argv[2])
const throttle = new GlobalThrottle()
throttle.setLimit(450_000)
const patch = (value: Partial<DownloadTask>): void => { Object.assign(task, value) }
const toast = (): void => {}
const engine = new HttpEngine({
  settings: () => ({ connections: 4, userAgent: 'PulseTest' }) as Settings,
  patch: (_task, value) => patch(value),
  toast,
  throttle
})
void engine.start({ task, signal: new AbortController().signal, patch, toast }, true)
