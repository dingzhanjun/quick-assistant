"use client";

import Message from "rsuite/Message";
import toaster from "rsuite/toaster";

// `toast.success("Saved")` / `toast.error(...)`, rendered with React Suite's toaster + Message.
const push = (type: "success" | "error" | "info" | "warning", text: React.ReactNode) =>
  toaster.push(
    <Message showIcon closable type={type}>
      {text}
    </Message>,
    { placement: "topEnd", duration: type === "error" ? 7000 : 4000 },
  );

export const toast = {
  success: (text: React.ReactNode) => push("success", text),
  error: (text: React.ReactNode) => push("error", text),
  info: (text: React.ReactNode) => push("info", text),
  warning: (text: React.ReactNode) => push("warning", text),
};
