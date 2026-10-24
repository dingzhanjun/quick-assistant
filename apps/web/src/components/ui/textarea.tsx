"use client"

import * as React from "react"
import RsInput from "rsuite/Input"
import { cn } from "cn"

type TextareaProps = Omit<React.ComponentProps<"textarea">, "onChange"> & {
  onChange?: React.ChangeEventHandler<HTMLTextAreaElement>
}

function Textarea({ className, onChange, ...props }: TextareaProps) {
  return (
    <RsInput
      as="textarea"
      size="sm"
      rows={3}
      className={cn("w-full", className)}
      onChange={(_value, event) => onChange?.(event as unknown as React.ChangeEvent<HTMLTextAreaElement>)}
      {...(props as Record<string, unknown>)}
    />
  )
}

export { Textarea }
