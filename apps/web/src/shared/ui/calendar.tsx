"use client"

import * as React from "react"
import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react"
import { DayPicker } from "react-day-picker"
import type { DropdownProps } from "react-day-picker"

import { cn } from "@/shared/lib/utils"
import { buttonVariants } from "@/shared/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover"

export type CalendarProps = React.ComponentProps<typeof DayPicker>

function CalendarDropdown({
  options,
  value,
  onChange,
  disabled,
  className,
  "aria-label": ariaLabel,
}: DropdownProps) {
  const [open, setOpen] = React.useState(false)

  const selectedOption = options?.find((option) => option.value === Number(value))

  const emitChange = (nextValue: number) => {
    const syntheticEvent = {
      target: { value: String(nextValue) },
      currentTarget: { value: String(nextValue) },
    } as React.ChangeEvent<HTMLSelectElement>

    onChange?.(syntheticEvent)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={ariaLabel}
          className={cn(
            "h-8 min-w-[7.5rem] rounded-xl border border-slate-200 bg-slate-50 px-3 py-1 text-sm font-bold text-slate-700 shadow-sm transition-colors hover:bg-white hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-blue/20 disabled:cursor-not-allowed disabled:opacity-50",
            "flex items-center justify-between gap-2",
            className
          )}
        >
          <span className="truncate">{selectedOption?.label ?? ""}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-44 rounded-xl border border-slate-100 bg-white p-1 shadow-2xl"
      >
        <div className="max-h-60 overflow-y-auto no-scrollbar">
          {options?.map((option) => {
            const isSelected = option.value === Number(value)

            return (
              <button
                key={option.value}
                type="button"
                disabled={option.disabled}
                onClick={() => emitChange(option.value)}
                className={cn(
                  "flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm font-bold transition-colors",
                  "text-slate-700 hover:bg-slate-50",
                  isSelected && "bg-brand-indigo text-white hover:bg-brand-indigo",
                  option.disabled && "cursor-not-allowed opacity-40 line-through"
                )}
              >
                <span>{option.label}</span>
                {isSelected && <Check className="h-4 w-4 shrink-0" />}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("p-3 px-8", className)}
      classNames={{
        months: "flex flex-col sm:flex-row gap-0",
        month: "flex flex-col gap-4 min-h-[320px]",
        month_caption: "flex justify-center relative items-center h-9",
        caption_label: "text-sm font-medium",
        dropdowns: "flex justify-center gap-2",
        nav: "flex items-center",
        button_previous: cn(
          buttonVariants({ variant: "ghost" }),
          "absolute left-1 inset-y-0 my-auto h-7 w-7 p-0 opacity-50 hover:opacity-100 rounded-full"
        ),
        button_next: cn(
          buttonVariants({ variant: "ghost" }),
          "absolute right-1 inset-y-0 my-auto h-7 w-7 p-0 opacity-50 hover:opacity-100 rounded-full"
        ),
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "text-muted-foreground rounded-md w-9 font-normal text-[0.8rem]",
        weeks: "space-y-1 mt-2",
        week: "flex w-full",
        day: "h-9 w-9 text-center text-sm p-0 relative [&:has([aria-selected].day-range-end)]:rounded-r-md [&:has([aria-selected].day-outside)]:bg-accent/50 [&:has([aria-selected])]:bg-accent first:[&:has([aria-selected])]:rounded-l-md last:[&:has([aria-selected])]:rounded-r-md focus-within:relative focus-within:z-20",
        day_button: cn(
          buttonVariants({ variant: "ghost" }),
          "h-9 w-9 p-0 font-normal aria-selected:opacity-100 rounded-full disabled:opacity-60 disabled:cursor-not-allowed"
        ),
        range_end: "day-range-end",
        selected:
          "rounded-full bg-primary text-primary-foreground hover:!bg-primary hover:!text-primary-foreground focus:!bg-primary focus:!text-primary-foreground",
        today: "rounded-full ring-1 ring-slate-300",
        outside:
          "day-outside text-muted-foreground aria-selected:bg-accent/50 aria-selected:text-muted-foreground",
        disabled: "text-slate-400 opacity-100 bg-slate-100/60",
        range_middle:
          "aria-selected:bg-accent aria-selected:text-accent-foreground",
        hidden: "invisible",
        dropdown:
          "h-8 min-w-[7.5rem] rounded-xl border border-slate-200 bg-slate-50 px-3 py-1 text-sm font-bold text-slate-700 shadow-sm transition-colors hover:bg-white hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-blue/20 cursor-pointer",
        ...classNames,
      }}
      components={{
        Dropdown: CalendarDropdown,
        Chevron: ({ orientation }) =>
          orientation === "left" ? (
            <ChevronLeft className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          ),
      }}
      {...props}
    />
  )
}
Calendar.displayName = "Calendar"

export { Calendar }
