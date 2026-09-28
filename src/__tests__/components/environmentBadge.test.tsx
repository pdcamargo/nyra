import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import EnvironmentBadge from '@renderer/components/EnvironmentBadge'
import { setPlatformForTest } from '@renderer/lib/platform'

afterEach(() => setPlatformForTest(null))

describe('EnvironmentBadge', () => {
  it('names the distro a WSL project runs in', () => {
    setPlatformForTest('windows')
    render(<EnvironmentBadge cwd={'\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'} />)
    expect(screen.getByText('WSL · Ubuntu')).toBeInTheDocument()
  })

  it('says nothing for a project on this machine', () => {
    setPlatformForTest('windows')
    const { container } = render(<EnvironmentBadge cwd={'C:\\Users\\me\\repo'} />)
    expect(container).toBeEmptyDOMElement()
  })
})
