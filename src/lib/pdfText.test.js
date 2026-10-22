import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureReadableStreamAsyncIterator } from './pdfText.js'

test('adds async iteration to a ReadableStream that lacks it (Safari)', async () => {
  // Safari-like ReadableStream: same reader API, no Symbol.asyncIterator.
  class SafariStream extends ReadableStream {}
  Object.defineProperty(SafariStream.prototype, Symbol.asyncIterator, { value: undefined, writable: true, configurable: true })
  ensureReadableStreamAsyncIterator(SafariStream)
  const stream = new SafariStream({
    start(controller) {
      controller.enqueue('a')
      controller.enqueue('b')
      controller.close()
    },
  })
  const seen = []
  for await (const chunk of stream) seen.push(chunk)
  assert.deepEqual(seen, ['a', 'b'])
  assert.equal(stream.locked, false)
})

test('leaves a native async iterator alone', () => {
  const native = ReadableStream.prototype[Symbol.asyncIterator]
  ensureReadableStreamAsyncIterator()
  assert.equal(ReadableStream.prototype[Symbol.asyncIterator], native)
})
