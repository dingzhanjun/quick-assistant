"use client"

import * as React from "react"
import Modal from "rsuite/Modal"
import { cn } from "cn"

// Adapter: the Dialog API this app uses (open / onOpenChange, header / title / footer) on a React Suite Modal.
const DialogContext = React.createContext<{ open: boolean; onOpenChange?: (open: boolean) => void }>({ open: false })

function Dialog({ open = false, onOpenChange, children }: { open?: boolean; onOpenChange?: (open: boolean) => void; children?: React.ReactNode }) {
  return <DialogContext.Provider value={{ open, onOpenChange }}>{children}</DialogContext.Provider>
}

// `size` sets the dialog width (rsuite Modal sizes: xs 400 px, sm 600 px, md 800 px); the content always fills it.
function DialogContent({ className, children, size = "xs" }: { className?: string; children?: React.ReactNode; size?: "xs" | "sm" | "md" }) {
  const { open, onOpenChange } = React.useContext(DialogContext)
  return (
    <Modal
      open={open}
      onClose={(e) => {
        // Esc inside an open picker only closes the picker, not the whole dialog (and the edits in it).
        if ((e as Event | undefined)?.type === "keydown" && document.querySelector(".rs-picker-popup")) return
        onOpenChange?.(false)
      }}
      size={size}
      overflow
    >
      <Modal.Body className={cn("!mt-0", className)}>{children}</Modal.Body>
    </Modal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("mb-4", className)} {...props} />
}

function DialogTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return <h2 className={cn("rs-modal-title", className)} {...props} />
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex justify-end gap-2 pt-2", className)} {...props} />
}

export { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle }
