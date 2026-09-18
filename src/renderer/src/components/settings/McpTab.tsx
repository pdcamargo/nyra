import React from 'react'
import McpSettings from '../McpSettings'
import { SectionLabel, SectionNote } from './primitives'

export default function McpTab(): React.JSX.Element {
  return (
    <>
      <SectionLabel>MCP servers</SectionLabel>
      <SectionNote>
        Servers configured for this project and globally. A server is set up once and then
        forgotten, which is what settings are for.
      </SectionNote>
      <McpSettings />
    </>
  )
}
