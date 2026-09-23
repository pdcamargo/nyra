import React from 'react'
import McpExplorer from './McpExplorer'

/**
 * The MCP servers, as Settings shows them.
 *
 * This used to render the list itself. It is now the shared explorer: the
 * composer shows the same thing, and two renderings of one config is exactly
 * how a server ends up looking connected in one place and failed in the other.
 * The name stays because it is what the settings pane imports.
 */
export default function McpSettings(): React.JSX.Element {
  return <McpExplorer variant="settings" />
}
