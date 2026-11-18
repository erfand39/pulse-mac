// WebTorrent v3 ships without type declarations. The engine talks to it through
// a small dynamic `any` surface, so a module shim is enough here.
declare module 'webtorrent'

declare module 'fs-chunk-store' {
  export default class Storage {
    constructor(length: number, options: object)
  }
}
