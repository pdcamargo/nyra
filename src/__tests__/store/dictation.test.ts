import { beforeEach, describe, expect, it } from 'vitest'
import {
  useDictationStore,
  downloadFraction,
  formatBytes
} from '@renderer/store/dictation'

beforeEach(() => useDictationStore.getState().reset())

describe('dictation store', () => {
  it('starting to record clears whatever the last run left behind', () => {
    const store = useDictationStore.getState()
    store.setInterim('stale text')
    store.setError('stale error')

    useDictationStore.getState().startRecording()

    const s = useDictationStore.getState()
    expect(s.phase).toBe('recording')
    expect(s.interim).toBe('')
    expect(s.error).toBeNull()
  })

  it('transcribing drops the level so the meter does not freeze mid-bar', () => {
    const store = useDictationStore.getState()
    store.startRecording()
    store.setLevel(0.8)
    store.setTranscribing()

    expect(useDictationStore.getState().level).toBe(0)
  })

  /** A download that is not the current one must not move the bar. */
  it('progress is ignored for a different model', () => {
    const store = useDictationStore.getState()
    store.startDownload('turbo')
    store.setProgress('base', 10, 100)

    expect(useDictationStore.getState().received).toBe(0)
  })

  it('progress is ignored once the download has ended', () => {
    const store = useDictationStore.getState()
    store.startDownload('turbo')
    store.endDownload()
    store.setProgress('turbo', 10, 100)

    expect(useDictationStore.getState().phase).toBe('idle')
    expect(useDictationStore.getState().received).toBe(0)
  })

  it('endDownload leaves a recording session alone', () => {
    const store = useDictationStore.getState()
    store.startRecording()
    store.endDownload()

    expect(useDictationStore.getState().phase).toBe('recording')
  })

  it('an error returns to idle rather than stranding the button', () => {
    const store = useDictationStore.getState()
    store.startRecording()
    store.setError('no microphone available')

    const s = useDictationStore.getState()
    expect(s.phase).toBe('idle')
    expect(s.error).toBe('no microphone available')
  })
})

describe('downloadFraction', () => {
  it('is zero before a total is known, rather than NaN', () => {
    expect(downloadFraction(0, 0)).toBe(0)
    expect(downloadFraction(10, 0)).toBe(0)
  })

  it('clamps to the 0–1 range', () => {
    expect(downloadFraction(150, 100)).toBe(1)
    expect(downloadFraction(-5, 100)).toBe(0)
    expect(downloadFraction(25, 100)).toBe(0.25)
  })
})

describe('formatBytes', () => {
  it('reads in MB up to a gigabyte and GB above it', () => {
    expect(formatBytes(147_951_465)).toBe('141 MB')
    expect(formatBytes(574_041_195)).toBe('547 MB')
    expect(formatBytes(1_549_000_000)).toBe('1.4 GB')
  })
})
