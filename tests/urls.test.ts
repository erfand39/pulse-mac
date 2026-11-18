import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isVideoPlatformUrl, scanClipboardUrls } from '../src/shared/urls'

test('clipboard recognizes HTTPS and rejects file URLs', () => {
  const scan = scanClipboardUrls('https://example.com/document.zip\nfile:///etc/hosts')
  assert.deepEqual(scan.urls, ['https://example.com/document.zip'])
  assert.equal(isVideoPlatformUrl('https://www.youtube.com/watch?v=123'), true)
})
