import assert from 'node:assert/strict'
import test from 'node:test'
import {shouldRetryWithoutInfo} from './ytdlp.js'

test('only retries a cached extraction when the media url likely expired', () => {
  assert.equal(shouldRetryWithoutInfo(new Error('Unable to download video: HTTP Error 403')), true)
  assert.equal(shouldRetryWithoutInfo(new Error('signature extraction failed')), true)
  assert.equal(shouldRetryWithoutInfo(new Error('Private video')), false)
  assert.equal(shouldRetryWithoutInfo(new Error('Video unavailable')), false)
})
