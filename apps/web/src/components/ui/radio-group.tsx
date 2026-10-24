"use client"

import * as React from "react"
import Radio from "rsuite/Radio"
import RsRadioGroup from "rsuite/RadioGroup"

// Adapter: a React Suite RadioGroup from a list of { label, value } options.
function RadioGroup<T extends string>({
  value, onChange, options, name, ariaLabel,
}: {
  value: T
  onChange: (value: T) => void
  options: { label: React.ReactNode; value: T }[]
  name: string
  ariaLabel?: string
}) {
  return (
    <RsRadioGroup name={name} aria-label={ariaLabel} value={value} onChange={(v) => onChange(v as T)}>
      {options.map((o) => (
        <Radio key={o.value} value={o.value}>
          {o.label}
        </Radio>
      ))}
    </RsRadioGroup>
  )
}

export { RadioGroup }
