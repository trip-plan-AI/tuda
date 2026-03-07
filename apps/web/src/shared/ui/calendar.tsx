"use client"

import * as React from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { DayPicker } from "react-day-picker"

import { cn } from "@/shared/lib/utils"
import { buttonVariants } from "@/shared/ui/button"

export type CalendarProps = React.ComponentProps<typeof DayPicker>

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("tp-calendar p-3 px-8", className)}
      classNames={{
        months: "flex flex-col sm:flex-row gap-0",
        month: "flex flex-col gap-4 min-h-[320px]",
        month_caption: "flex justify-center relative items-center h-9",
        caption_label: "text-sm font-medium",
        dropdowns: "flex justify-center gap-2",
        dropdown_root: "relative",
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
