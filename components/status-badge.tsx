import { memo } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const statusBadgeVariants = cva(
  "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
  {
    variants: {
      status: {
        "in-progress": "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
        "awaiting-comments": "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
        completed: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
        skip: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
      },
    },
    defaultVariants: {
      status: "in-progress",
    },
  }
)

interface StatusBadgeProps extends VariantProps<typeof statusBadgeVariants> {
  className?: string
  children?: React.ReactNode
}

export const StatusBadge = memo(function StatusBadge({ status, className, children }: StatusBadgeProps) {
  const displayText = children || (status === "awaiting-comments" ? "Awaiting comments" : status === "in-progress" ? "In Progress" : status === "completed" ? "Completed" : "Skip")

  return (
    <span className={cn(statusBadgeVariants({ status }), className)}>
      {displayText}
    </span>
  )
})
