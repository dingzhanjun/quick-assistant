"use client"

import * as React from "react"
import RsInput from "rsuite/Input"
import { cn } from "cn"

// Adapter: a React Suite Input that keeps the DOM-style onChange(event) this app uses.
type InputProps = Omit<React.ComponentProps<"input">, "size" | "onChange"> & {
  onChange?: React.ChangeEventHandler<HTMLInputElement>
}

function Input({ className, onChange, ...props }: InputProps) {
  return (
    <RsInput
      size="sm"
      className={cn("w-full", className)}
      onChange={(_value, event) => onChange?.(event as React.ChangeEvent<HTMLInputElement>)}
      {...(props as Record<string, unknown>)}
    />
  )
}

export { Input }
