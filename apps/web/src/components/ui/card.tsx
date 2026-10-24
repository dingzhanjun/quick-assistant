"use client"

import * as React from "react"
import Panel from "rsuite/Panel"
import { cn } from "cn"

// Adapter: Card / CardHeader / CardTitle / CardContent on a React Suite Panel.
function Card({ className, children }: { className?: string; children?: React.ReactNode }) {
  return (
    <Panel bordered bodyFill className={className}>
      <div className="space-y-3 p-4">{children}</div>
    </Panel>
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex items-start justify-between gap-2", className)} {...props} />
}

function CardTitle({ className, ...props }: React.ComponentProps<"h3">) {
  return <h3 className={cn("text-base font-semibold", className)} {...props} />
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn(className)} {...props} />
}

export { Card, CardContent, CardHeader, CardTitle }
