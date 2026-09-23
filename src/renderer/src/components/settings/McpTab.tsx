import React from 'react'
import McpExplorer from '../McpExplorer'
import { SectionLabel, SectionNote } from './primitives'

export default function McpTab(): React.JSX.Element {
  return (
    <>
      <SectionLabel>MCP servers</SectionLabel>
      <SectionNote>
        Servers configured for this project and globally, plus whatever this chat started. A
        server is set up once and then forgotten, which is what settings are for.
      </SectionNote>
      {/* No card around it: the pane is already a surface, and an outlined box
          inside it would read as a second, competing one. The composer dock is
          where a container earns its keep. */}
      <McpExplorer variant="settings" />
    </>
  )
}
