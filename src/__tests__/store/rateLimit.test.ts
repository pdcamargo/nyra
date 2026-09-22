import { describe, it, expect, beforeEach } from 'vitest'
import { dropExpired, useRateLimitStore } from '../../renderer/src/store/rateLimit'

function resetStore(): void {
  useRateLimitStore.setState({ windows: {}, updatedAt: null })
}

describe('RateLimit Store', () => {
  beforeEach(resetStore)

  describe('setWindow', () => {
    it('stores a five_hour window', () => {
      useRateLimitStore.getState().setWindow({
        status: 'allowed',
        resetsAt: 1774818000,
        rateLimitType: 'five_hour'
      })
      const state = useRateLimitStore.getState()
      expect(state.windows['five_hour']).toEqual({
        status: 'allowed',
        resetsAt: 1774818000,
        rateLimitType: 'five_hour'
      })
      expect(state.updatedAt).toBeTypeOf('number')
    })

    it('stores multiple window types independently', () => {
      const { setWindow } = useRateLimitStore.getState()
      setWindow({ status: 'allowed', resetsAt: 1774818000, rateLimitType: 'five_hour' })
      setWindow({ status: 'allowed', resetsAt: 1775000000, rateLimitType: 'seven_day' })

      const state = useRateLimitStore.getState()
      expect(Object.keys(state.windows)).toHaveLength(2)
      expect(state.windows['five_hour'].resetsAt).toBe(1774818000)
      expect(state.windows['seven_day'].resetsAt).toBe(1775000000)
    })

    it('updates an existing window', () => {
      const { setWindow } = useRateLimitStore.getState()
      setWindow({ status: 'allowed', resetsAt: 1774818000, rateLimitType: 'five_hour' })
      setWindow({ status: 'throttled', resetsAt: 1774819000, rateLimitType: 'five_hour' })

      const state = useRateLimitStore.getState()
      expect(state.windows['five_hour'].status).toBe('throttled')
      expect(state.windows['five_hour'].resetsAt).toBe(1774819000)
    })
  })

  // The CLI reports the numbers under `rate_limit_info.unifiedWindows`, which
  // the app used to drop on the floor — hence a status bar that could say when
  // the limit lifts and never how much of it had been spent.
  describe('setUnified', () => {
    it('records the utilisation of every window', () => {
      useRateLimitStore.getState().setUnified({
        five_hour: { resetsAt: 1790055600, utilization: 0.1 },
        seven_day: { resetsAt: 1790424000, utilization: 0.42 }
      })
      const { windows } = useRateLimitStore.getState()
      expect(windows['five_hour'].utilization).toBe(0.1)
      expect(windows['seven_day'].utilization).toBe(0.42)
      expect(windows['seven_day'].resetsAt).toBe(1790424000)
    })

    it('keeps a throttled status a later utilisation tick does not mention', () => {
      const { setWindow, setUnified } = useRateLimitStore.getState()
      setWindow({ status: 'throttled', resetsAt: 1790055600, rateLimitType: 'five_hour' })
      setUnified({ five_hour: { resetsAt: 1790055600, utilization: 0.99 } })
      expect(useRateLimitStore.getState().windows['five_hour'].status).toBe('throttled')
    })

    it('leaves utilisation undefined until a window reports one', () => {
      useRateLimitStore
        .getState()
        .setWindow({ status: 'allowed', resetsAt: 1790055600, rateLimitType: 'five_hour' })
      // Not 0: nothing has been spent *that we know of*, which is a different
      // claim from a fresh quota.
      expect(useRateLimitStore.getState().windows['five_hour'].utilization).toBeUndefined()
    })
  })

  // A reading is true until its own resetsAt and not a second longer. The store
  // is persisted, so without this a launch the next morning would present last
  // night's weekly figure as today's.
  describe('dropExpired', () => {
    const NOW = 1790055600_000

    it('keeps a window that has not reset yet', () => {
      const live = dropExpired(
        { five_hour: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: NOW / 1000 + 60, utilization: 0.3 } },
        NOW
      )
      expect(live['five_hour'].utilization).toBe(0.3)
    })

    it('forgets a window that has rolled over', () => {
      const live = dropExpired(
        { seven_day: { status: 'allowed', rateLimitType: 'seven_day', resetsAt: NOW / 1000 - 1, utilization: 0.42 } },
        NOW
      )
      expect(live).toEqual({})
    })

    it('judges each window on its own reset', () => {
      const live = dropExpired(
        {
          five_hour: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: NOW / 1000 - 10, utilization: 0.9 },
          seven_day: { status: 'allowed', rateLimitType: 'seven_day', resetsAt: NOW / 1000 + 10, utilization: 0.42 }
        },
        NOW
      )
      expect(Object.keys(live)).toEqual(['seven_day'])
    })
  })

  describe('clear', () => {
    it('resets all state', () => {
      useRateLimitStore.getState().setWindow({
        status: 'allowed',
        resetsAt: 1774818000,
        rateLimitType: 'five_hour'
      })
      useRateLimitStore.getState().clear()

      const state = useRateLimitStore.getState()
      expect(state.windows).toEqual({})
      expect(state.updatedAt).toBeNull()
    })
  })
})
