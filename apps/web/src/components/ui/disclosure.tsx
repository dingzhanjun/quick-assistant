"use client"

import * as React from "react"
import Panel from "rsuite/Panel"

// Adapter: a collapsible section (React Suite Panel) in place of the native <details>.
function Disclosure({
  summary, children, defaultOpen = false, bordered = true, className,
}: {
  summary: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
  bordered?: boolean
  className?: string
}) {
  return (
    <Panel header={summary} collapsible bordered={bordered} defaultExpanded={defaultOpen} className={className}>
      {children}
    </Panel>
  )
}

export { Disclosure }
