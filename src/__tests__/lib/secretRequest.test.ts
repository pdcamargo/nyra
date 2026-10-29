import { beforeEach, describe, expect, it } from 'vitest'
import { handleAppRequest } from '@renderer/lib/appControl'
import { parseSecretResult, secretsOf, whereSaved } from '@renderer/lib/secretRequest'
import { useSecretsStore } from '@renderer/store/secrets'

const pending = (chatId: string) => useSecretsStore.getState().bySession[chatId] ?? []

beforeEach(() => useSecretsStore.setState({ bySession: {} }))

describe('a secret request', () => {
  it('waits in the chat that asked, and answers with what was skipped, never a value', async () => {
    const answered = handleAppRequest('secret.request', {
      chatId: 'chat-a',
      requestId: 'r1',
      secrets: [{ name: 'OPENAI_API_KEY', label: 'OpenAI API key' }, { name: 'SENTRY_DSN' }],
      save: 'env',
      target: '/p/.env'
    })
    expect(pending('chat-a')).toHaveLength(1)
    expect(pending('chat-b')).toHaveLength(0)
    expect(pending('chat-a')[0].secrets[1].label).toBe('SENTRY_DSN')

    useSecretsStore.getState().settle('chat-a', 'r1', { outcome: 'done', skipped: [1] })
    await expect(answered).resolves.toEqual({ outcome: 'done', skipped: [1] })
    expect(pending('chat-a')).toHaveLength(0)
  })

  it('refuses a request with nothing to ask', async () => {
    await expect(handleAppRequest('secret.request', { chatId: 'c', requestId: 'r', secrets: [] })).rejects.toThrow()
  })
})

describe('the transcript record', () => {
  it('reads one line per secret and keeps the rest as notes', () => {
    const { lines, notes } = parseSecretResult(
      'OPENAI_API_KEY: saved to /p/.env\nSENTRY_DSN: skipped\nX: no answer\n\n/p/.env is not in .gitignore. Add it before anything is committed.'
    )
    expect(lines).toEqual([
      { name: 'OPENAI_API_KEY', status: 'saved', path: '/p/.env' },
      { name: 'SENTRY_DSN', status: 'skipped' },
      { name: 'X', status: 'no answer' }
    ])
    expect(notes).toHaveLength(1)
  })

  it('names the file, or says private for a secrets file', () => {
    expect(whereSaved('/p/app/.env.local', 'env')).toBe('.env.local')
    expect(whereSaved('/Users/me/.nyra/secrets/c/TOKEN', 'file')).toBe('a private file')
    expect(secretsOf({ secrets: [{ label: 'no name' }] })).toEqual([])
  })
})
