import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/shared/lib/utils"

const chipVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-full px-6 py-3 text-xs font-black uppercase tracking-widest transition-all shrink-0 active:scale-95 select-none outline-none border-2",
  {
    variants: {
      variant: {
        active: "bg-brand-blue text-white border-brand-blue shadow-lg shadow-brand-blue/15",
        default: "bg-white text-slate-500 border-slate-100 hover:border-brand-blue/30 hover:text-brand-indigo hover:bg-slate-50",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface ChipProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof chipVariants> {}

const Chip = React.forwardRef<HTMLButtonElement, ChipProps>(
  ({ className, variant, ...props }, ref) => {
    return (
      <button
        className={cn(chipVariants({ variant, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Chip.displayName = "Chip"

export { Chip, chipVariants }
