import assert from 'node:assert/strict'
import test from 'node:test'
import {parseTelegramLink, telegramSessionRequired} from './telegram-url.js'

test('classifies private channel messages and invite links', () => {
  assert.deepEqual(parseTelegramLink('https://t.me/c/1234567890/42'), {
    kind: 'private-message',
    chatId: '1234567890',
    messageId: 42,
  })
  assert.deepEqual(parseTelegramLink('https://t.me/+AbCd_ef-1'), {kind: 'invite', hash: 'AbCd_ef-1'})
  assert.deepEqual(parseTelegramLink('https://t.me/joinchat/AbCd_ef-1'), {kind: 'invite', hash: 'AbCd_ef-1'})
  assert.equal(telegramSessionRequired(parseTelegramLink('https://t.me/c/1/2')!), true)
})

test('keeps public posts on the yt-dlp path', () => {
  const link = parseTelegramLink('https://t.me/europa_press/613')
  assert.deepEqual(link, {kind: 'public-message', username: 'europa_press', messageId: 613})
  assert.equal(telegramSessionRequired(link!), false)
  assert.equal(parseTelegramLink('https://youtube.com/watch?v=abc'), undefined)
  assert.equal(parseTelegramLink('https://t.me/somechannel'), undefined)
})
