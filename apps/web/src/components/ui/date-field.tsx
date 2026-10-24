"use client"

import * as React from "react"
import DatePicker from "rsuite/DatePicker"

// Adapter: a React Suite DatePicker whose value is a "YYYY-MM-DD" string (what URLs and forms use). With `name` it also
// renders a hidden input, so it works inside a plain GET form.
const parse = (s: string | undefined) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "")
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}
const pad = (n: number) => String(n).padStart(2, "0")
const format = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

function DateField({
  value, onChange, name, ariaLabel, placeholder,
}: {
  value: string
  onChange: (value: string) => void
  name?: string
  ariaLabel: string
  placeholder?: string
}) {
  return (
    <>
      <DatePicker
        oneTap
        size="sm"
        block
        format="yyyy-MM-dd"
        value={parse(value)}
        onChange={(d) => onChange(d ? format(d) : "")}
        placeholder={placeholder ?? "yyyy-mm-dd"}
        aria-label={ariaLabel}
        cleanable
      />
      {name && <input type="hidden" name={name} value={value} />}
    </>
  )
}

export { DateField }
