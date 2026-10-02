import { describe, expect, it } from 'vitest'
import { CAT_BREEDS, catOf, catTintStyle, pickCat, type AgentCat } from '../../renderer/src/lib/agentCats'
import { useSessionsStore } from '../../renderer/src/store/sessions'

describe('pickCat', () => {
  it('hands out every breed once before any repeats', () => {
    const taken: AgentCat[] = []
    for (let i = 0; i < CAT_BREEDS.length; i++) taken.push(pickCat(taken))
    expect(new Set(taken.map((c) => c.breed)).size).toBe(CAT_BREEDS.length)
    expect(taken.every((c) => c.hue === undefined)).toBe(true)
  })

  it('only picks from the breeds still free', () => {
    const taken = CAT_BREEDS.filter((b) => b !== 'calico').map((breed) => ({ breed }))
    expect(pickCat(taken, () => 0.99)).toEqual({ breed: 'calico' })
  })

  it('tints a repeat once the breeds have run out', () => {
    const taken = CAT_BREEDS.map((breed) => ({ breed }))
    const cat = pickCat(taken, () => 0.5)
    expect(cat.hue).toBe(180)
    expect(CAT_BREEDS).toContain(cat.breed)
    // A tinted cat does not free its breed back up for the next pick.
    expect(pickCat([...taken, cat]).hue).toBeDefined()
  })

  it('ignores agents saved before cats existed', () => {
    expect(pickCat([undefined, undefined], () => 0)).toEqual({ breed: CAT_BREEDS[0] })
  })
})

describe('catOf', () => {
  it('falls back to the agent’s place in the session', () => {
    expect(catOf({}, 2)).toEqual({ breed: CAT_BREEDS[2] })
    expect(catOf(undefined, -1)).toEqual({ breed: CAT_BREEDS[0] })
    expect(catOf({ cat: { breed: 'black', hue: 10 } }, 2)).toEqual({ breed: 'black', hue: 10 })
  })
})

describe('catTintStyle', () => {
  it('sets nothing for an untinted cat, and the coat for a tinted one', () => {
    expect(catTintStyle({ breed: 'black' })).toBeUndefined()
    expect(catTintStyle({ breed: 'black', hue: 200 })).toMatchObject({ '--cat-fur': 'hsl(200 55% 62%)' })
  })
})

describe('addAgent', () => {
  it('gives each spawned agent its own cat', () => {
    const store = useSessionsStore.getState()
    const id = store.createSession('/tmp/cats')
    for (let i = 0; i < 3; i++) {
      store.addAgent(id, { toolId: `t${i}`, name: `a${i}`, subagentType: 'general', status: 'running', startedAt: 0 })
    }
    const agents = useSessionsStore.getState().sessions.find((s) => s.id === id)!.agents!
    expect(new Set(agents.map((a) => a.cat?.breed)).size).toBe(3)
  })
})
