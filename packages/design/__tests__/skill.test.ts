import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROPS } from '../src/registry/props'
import { NODE_KINDS } from '../src/registry/define'
import type { PropName } from '../src/registry/types'

// The bundled path, which `managed_skills.rs` include_str!s.
const SKILL = resolve(__dirname, '../../../.claude/skills/nyra-design/SKILL.md')
const text = readFileSync(SKILL, 'utf8')

describe('the skill is generated from the registry', () => {
  /**
   * The spec's reason this file exists: "the skill is generated from the
   * registry at build time, so shipping a property without teaching it is not
   * possible." This is the assertion that makes that true — add a record
   * without regenerating and the build goes red.
   */
  it('is current with the registry', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'nyra-skill-')), 'SKILL.md')
    execFileSync('npx', ['vite-node', 'scripts/generate-skill.mts', out], {
      cwd: resolve(__dirname, '..'),
      stdio: 'pipe'
    })
    expect(readFileSync(out, 'utf8')).toBe(text)
  })

  it.each(Object.keys(PROPS) as PropName[])('teaches %s', (name) => {
    expect(text).toContain(`\`${name}\``)
    // …with its own documentation, not just its name in a list.
    expect(text).toContain(PROPS[name].doc)
  })

  it.each(NODE_KINDS)('teaches the %s node', (kind) => {
    expect(text).toContain(`\`${kind}\``)
  })

  it('names every required property as required', () => {
    for (const [name, def] of Object.entries(PROPS)) {
      if (!def.required) continue
      expect(text).toMatch(new RegExp(`requires[^\\n]*\`${name}\``))
    }
  })
})

describe('the app installs it, rather than the user copying it', () => {
  it('lives at the path managed_skills.rs bundles', () => {
    expect(SKILL).toMatch(/\.claude\/skills\/nyra-design\/SKILL\.md$/)
    const rust = readFileSync(resolve(__dirname, '../../../src-tauri/src/managed_skills.rs'), 'utf8')
    expect(rust).toContain('.claude/skills/nyra-design/SKILL.md')
    expect(rust).toContain('name: "nyra-design"')
  })

  it('points at the tool, not at a script in someone\'s clone', () => {
    // The dev-mode shell wrapper was a stopgap. A skill that hardcodes a path
    // into one machine's checkout cannot ship.
    expect(text).toContain('nyra_design action:"create"')
    expect(text).toContain('nyra_design action:"render"')
    expect(text).not.toContain('design-raster.sh')
    expect(text).not.toMatch(/\/Users\/[a-z]+\//)
  })
})

describe('discoverability costs almost nothing', () => {
  const frontmatter = text.split('---')[1]

  it('carries a name and a description and nothing else', () => {
    expect(frontmatter).toMatch(/^\s*name: nyra-design/)
    expect(frontmatter).toMatch(/description: .+/)
    expect(frontmatter.split('\n').filter((l) => l.trim()).length).toBe(2)
  })

  /**
   * The frontmatter is in context for every turn of every session, so its size
   * is a tax on all work, not just design work. The body loads only when the
   * skill fires and can afford to be complete.
   */
  it('keeps the always-loaded half under ~100 tokens', () => {
    expect(frontmatter.length / 4).toBeLessThan(100)
  })

  it('describes when to fire in the user\'s words, not the package\'s', () => {
    for (const word of ['design', 'mock up', 'lay out', 'screen', 'component']) {
      expect(frontmatter.toLowerCase()).toContain(word)
    }
    // It must also say what it is NOT, or it competes with writing React.
    expect(frontmatter).toMatch(/not HTML or React/)
  })
})

describe('it teaches the things a fresh session gets wrong', () => {
  /**
   * Found by running a cold session against the skill: it wrote
   * `"props": { "label": "string" }` instead of
   * `"props": { "label": { "type": "string" } }`, then went and read this
   * repo's schema.ts to work out the shape. The skill documented how to
   * *reference* a prop and never how to *declare* one.
   */
  it('shows a component prop declaration in full', () => {
    for (const t of ['string', 'number', 'boolean', 'enum']) {
      expect(text).toContain(`{ "type": "${t}"`)
    }
    expect(text).toContain('"of": ["primary", "ghost"]')
    expect(text).toContain('Each prop is an object with a')
  })

  it('shows a whole component, not just its outline', () => {
    // An outline with `…` in it is what sent the cold session looking.
    const components = text.slice(text.indexOf('## Components'), text.indexOf('## Values'))
    expect(components).toContain('"root"')
    expect(components).toContain('"use": "Button"')
    expect(components).not.toContain('…')
  })

  it('says how to render and how to show the result', () => {
    expect(text).toContain('nyra_design action:"render"')
    expect(text).toMatch(/!\[[^\]]*\]\(/)
    // Looking before describing is the habit worth enforcing in prose, since
    // nothing else can.
    expect(text).toMatch(/Look at the PNG/)
  })
})

describe('how a design is handed over', () => {
  /**
   * A PNG in chat was the default and should not have been: the chip is one
   * line, opens a canvas you can zoom and pan, and stays current when the
   * document is revised. A screenshot is a dead copy of one moment.
   */
  it('makes the chip the default and the image the exception', () => {
    expect(text).toMatch(/Hand it over as a chip, not a picture/)
    expect(text).toMatch(/Do \*\*not\*\* post/)
    expect(text).toMatch(/only\*\* when the user asks to see it/)
  })

  it('still insists Claude looks at the render itself', () => {
    // The looking is the quality mechanism and is not what changed.
    expect(text).toMatch(/Look at the PNG yourself/)
    expect(text).toMatch(/Never describe a design you have not seen/)
  })

  it('says the canvas follows the file, so a revision needs no click', () => {
    expect(text).toMatch(/canvas follows the file/)
  })
})

describe('pointing at one artboard', () => {
  it('teaches the fragment form', () => {
    expect(text).toContain('#settings-protocol')
    expect(text).toMatch(/framed on it/)
    expect(text).toMatch(/whenever you changed one panel/)
  })
})
