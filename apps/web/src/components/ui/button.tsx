"use client"

import * as React from "react"
import RsButton from "rsuite/Button"
import { cn } from "cn"

// Adapter: keeps the API this app was written against (variant / size) and renders a React Suite Button.
type Variant = "default" | "outline" | "ghost" | "destructive"
type Size = "default" | "xs" | "sm" | "icon-xs"

const APPEARANCE: Record<Variant, "primary" | "default" | "subtle"> = {
  default: "primary", outline: "default", ghost: "subtle", destructive: "primary",
}
const SIZE: Record<Size, "xs" | "sm"> = {
  default: "sm", xs: "xs", sm: "xs", "icon-xs": "xs",
}

type ButtonProps = Omit<React.ComponentProps<"button">, "color"> & { variant?: Variant; size?: Size }

function Button({ className, variant = "default", size = "default", children, ...props }: ButtonProps) {
  return (
    <RsButton
      appearance={APPEARANCE[variant]}
      color={variant === "destructive" ? "red" : undefined}
      size={SIZE[size]}
      className={cn(size.startsWith("icon") && "!px-2", className)}
      {...(props as React.ComponentProps<typeof RsButton>)}
    >
      {children}
    </RsButton>
  )
}

export { Button }
export type { Variant as ButtonVariant, Size as ButtonSize }
