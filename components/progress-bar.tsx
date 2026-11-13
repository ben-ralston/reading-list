import { memo } from "react"

interface ProgressBarProps {
  progress: number // 0-100
  className?: string
}

export const ProgressBar = memo(function ProgressBar({ progress, className = "" }: ProgressBarProps) {
  return (
    <div className={className}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[13px] text-muted-foreground">
          {progress}% complete
        </span>
      </div>
      <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
        <div
          className="h-full bg-primary transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  )
})
