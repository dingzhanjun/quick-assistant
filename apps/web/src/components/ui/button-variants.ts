import { cn } from "cn"

// Class names for a link that should look like a (React Suite) button. Plain module on purpose (no "use client"): server
// components call it, and a function exported from a client file cannot be called on the server.
export function buttonVariants({ variant = "outline", size = "sm", className }: { variant?: "default" | "outline" | "ghost"; size?: "xs" | "sm" | "default"; className?: string } = {}) {
  const appearance = variant === "default" ? "rs-btn-primary" : variant === "ghost" ? "rs-btn-subtle" : "rs-btn-default"
  return cn("rs-btn", size === "default" ? "rs-btn-md" : `rs-btn-${size}`, appearance, className)
}
