"use client";

import { useState } from "react";
import Modal from "rsuite/Modal";
import { Button } from "@/components/ui/button";

// A button that asks first (React Suite Modal with role="alertdialog") instead of the browser's native confirm().
// `onConfirm` runs when the user presses the confirm button; closing the dialog any other way does nothing.
export function ConfirmButton({
  children, title, description, confirmLabel = "Confirm", cancelLabel = "Cancel", destructive = true, onConfirm, disabled, variant = "ghost", size = "sm", ariaLabel, className,
}: {
  children: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  disabled?: boolean;
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
  ariaLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {/* type=button: inside a form this must not submit it */}
      <Button type="button" variant={variant} size={size} disabled={disabled} aria-label={ariaLabel} className={className} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <Modal role="alertdialog" size="xs" open={open} onClose={() => setOpen(false)} aria-labelledby="confirm-title">
        <Modal.Header>
          <Modal.Title id="confirm-title">{title}</Modal.Title>
        </Modal.Header>
        {description && <Modal.Body>{description}</Modal.Body>}
        <Modal.Footer>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
