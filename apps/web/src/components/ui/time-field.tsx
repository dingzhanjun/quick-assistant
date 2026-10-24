"use client"

import * as React from "react"
import TimePicker from "rsuite/TimePicker"

// Adapter: a React Suite TimePicker whose value is a 24-hour "HH:MM" string (how opening hours are stored).
const parse = (s: string) => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s)
  const d = new Date()
  d.setHours(m ? Number(m[1]) : 0, m ? Number(m[2]) : 0, 0, 0)
  return d
}
const pad = (n: number) => String(n).padStart(2, "0")

function TimeField({ value, onChange, ariaLabel }: { value: string; onChange: (value: string) => void; ariaLabel: string }) {
  return (
    <TimePicker
      size="sm"
      format="HH:mm"
      showMeridiem={false}
      cleanable={false}
      value={parse(value)}
      onChange={(d) => d && onChange(`${pad(d.getHours())}:${pad(d.getMinutes())}`)}
      aria-label={ariaLabel}
      style={{ width: 110 }}
    />
  )
}

export { TimeField }
