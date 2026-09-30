import { describe, it, expect, beforeEach } from 'vitest'
import {
  dropExpired,
  limitsFor,
  migrateRateLimits,
  useRateLimitStore
} from '../../renderer/src/store/rateLimit'

const W = 'default'
const windowsOf = (workspaceId: string = W) => limitsFor(useRateLimitStore.getState(), workspaceId).windows

function resetStore(): void {
  useRateLimitStore.setState({ byWorkspace: {} })
}

describe('RateLimit Store', () => {
  beforeEach(resetStore)

  describe('setWindow', () => {
    it('stores a five_hour window', () => {
      useRateLimitStore.getState().setWindow(W, {
        status: 'allowed',
        resetsAt: 1774818000,
        rateLimitType: 'five_hour'
      })
      expect(windowsOf()['five_hour']).toEqual({
        status: 'allowed',
        resetsAt: 1774818000,
        rateLimitType: 'five_hour'
      })
      expect(limitsFor(useRateLimitStore.getState(), W).updatedAt).toBeTypeOf('number')
    })

    it('stores multiple window types independently', () => {
      const { setWindow } = useRateLimitStore.getState()
      setWindow(W, { status: 'allowed', resetsAt: 1774818000, rateLimitType: 'five_hour' })
      setWindow(W, { status: 'allowed', resetsAt: 1775000000, rateLimitType: 'seven_day' })

      expect(Object.keys(windowsOf())).toHaveLength(2)
      expect(windowsOf()['five_hour'].resetsAt).toBe(1774818000)
      expect(windowsOf()['seven_day'].resetsAt).toBe(1775000000)
    })

    it('updates an existing window', () => {
      const { setWindow } = useRateLimitStore.getState()
      setWindow(W, { status: 'allowed', resetsAt: 1774818000, rateLimitType: 'five_hour' })
      setWindow(W, { status: 'throttled', resetsAt: 1774819000, rateLimitType: 'five_hour' })

      expect(windowsOf()['five_hour'].status).toBe('throttled')
      expect(windowsOf()['five_hour'].resetsAt).toBe(1774819000)
    })
  })

  // The CLI reports the numbers under `rate_limit_info.unifiedWindows`, which
  // the app used to drop on the floor — hence a status bar that could say when
  // the limit lifts and never how much of it had been spent.
  describe('setUnified', () => {
    it('records the utilisation of every window', () => {
      useRateLimitStore.getState().setUnified(W, {
        five_hour: { resetsAt: 1790055600, utilization: 0.1 },
        seven_day: { resetsAt: 1790424000, utilization: 0.42 }
      })
      expect(windowsOf()['five_hour'].utilization).toBe(0.1)
      expect(windowsOf()['seven_day'].utilization).toBe(0.42)
      expect(windowsOf()['seven_day'].resetsAt).toBe(1790424000)
    })

    it('keeps a throttled status a later utilisation tick does not mention', () => {
      const { setWindow, setUnified } = useRateLimitStore.getState()
      setWindow(W, { status: 'throttled', resetsAt: 1790055600, rateLimitType: 'five_hour' })
      setUnified(W, { five_hour: { resetsAt: 1790055600, utilization: 0.99 } })
      expect(windowsOf()['five_hour'].status).toBe('throttled')
    })

    it('leaves utilisation undefined until a window reports one', () => {
      useRateLimitStore
        .getState()
        .setWindow(W, { status: 'allowed', resetsAt: 1790055600, rateLimitType: 'five_hour' })
      // Not 0: nothing has been spent *that we know of*, which is a different
      // claim from a fresh quota.
      expect(windowsOf()['five_hour'].utilization).toBeUndefined()
    })
  })

  // Every workspace is its own account with its own quota: a turn in one must
  // never move another's meter.
  describe('per workspace', () => {
    it('keeps each workspace’s readings apart', () => {
      const { setUnified } = useRateLimitStore.getState()
      setUnified('work', { five_hour: { resetsAt: 1790055600, utilization: 0.8 } })
      setUnified('personal', { five_hour: { resetsAt: 1790055600, utilization: 0.1 } })
      expect(windowsOf('work')['five_hour'].utilization).toBe(0.8)
      expect(windowsOf('personal')['five_hour'].utilization).toBe(0.1)
    })

    it('knows nothing about a workspace that has reported nothing', () => {
      useRateLimitStore.getState().setUnified('work', { five_hour: { resetsAt: 1790055600, utilization: 0.8 } })
      expect(windowsOf('personal')).toEqual({})
      expect(limitsFor(useRateLimitStore.getState(), 'personal').updatedAt).toBeNull()
    })

    it('carries readings from before workspaces into Default', () => {
      const NOW = 1790055600_000
      const migrated = migrateRateLimits(
        {
          windows: {
            five_hour: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: NOW / 1000 + 60, utilization: 0.3 }
          },
          updatedAt: NOW - 1000
        },
        NOW
      )
      expect(Object.keys(migrated)).toEqual(['default'])
      expect(migrated.default.windows['five_hour'].utilization).toBe(0.3)
      expect(migrated.default.updatedAt).toBe(NOW - 1000)
    })

    it('drops what has rolled over on the way in, per workspace', () => {
      const NOW = 1790055600_000
      const migrated = migrateRateLimits(
        {
          byWorkspace: {
            work: {
              windows: { five_hour: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: NOW / 1000 - 1, utilization: 0.9 } },
              updatedAt: NOW - 5000
            },
            personal: {
              windows: { seven_day: { status: 'allowed', rateLimitType: 'seven_day', resetsAt: NOW / 1000 + 1, utilization: 0.2 } },
              updatedAt: NOW - 5000
            }
          }
        },
        NOW
      )
      expect(Object.keys(migrated)).toEqual(['personal'])
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
    it('forgets one workspace and leaves the rest', () => {
      const { setWindow, clear } = useRateLimitStore.getState()
      setWindow('gone', { status: 'allowed', resetsAt: 1774818000, rateLimitType: 'five_hour' })
      setWindow('kept', { status: 'allowed', resetsAt: 1774818000, rateLimitType: 'five_hour' })
      clear('gone')

      expect(windowsOf('gone')).toEqual({})
      expect(limitsFor(useRateLimitStore.getState(), 'gone').updatedAt).toBeNull()
      expect(windowsOf('kept')['five_hour']).toBeDefined()
    })
  })
})
