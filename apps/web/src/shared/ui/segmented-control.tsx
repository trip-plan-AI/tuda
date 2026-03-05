import * as React from "react"
import { cn } from "@/shared/lib/utils"

interface SegmentedControlProps {
  options: { label: string; value: string }[]
  value: string
  onChange: (value: string) => void
  className?: string
}

export function SegmentedControl({
  options,
  value,
  onChange,
  className,
}: SegmentedControlProps) {
  return (
    <div
      className={cn(
        "flex p-1 bg-slate-50 rounded-xl w-full max-w-md md:mx-0",
        className
      )}
    >
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "flex-1 py-2.5 rounded-lg text-xs font-black uppercase tracking-widest transition-all",
            value === option.value
              ? "bg-white text-brand-indigo shadow-md"
              : "text-slate-400 hover:text-slate-600"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
