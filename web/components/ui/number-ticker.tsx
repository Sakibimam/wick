"use client"

import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from "react"
import { useInView, useMotionValue, useReducedMotion, useSpring } from "motion/react"

import { cn } from "@/lib/utils"

interface NumberTickerProps extends ComponentPropsWithoutRef<"span"> {
  value: number
  startValue?: number
  delay?: number
  decimalPlaces?: number
}

const format = (n: number, dp: number) => Intl.NumberFormat("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }).format(Number(n.toFixed(dp)))

/** Magic UI number ticker, adapted: under reduced motion it prints the real value at once and never animates. */
export function NumberTicker({ value, startValue = 0, delay = 0, className, decimalPlaces = 0, ...props }: NumberTickerProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const reduce = useReducedMotion()
  const motionValue = useMotionValue(startValue)
  const springValue = useSpring(motionValue, { damping: 60, stiffness: 100 })
  const isInView = useInView(ref, { once: true, margin: "0px" })
  // A hidden tab runs no animation frames: count up only when someone is looking, otherwise print the value.
  const [animate] = useState(() => typeof document !== "undefined" && document.visibilityState === "visible")

  useEffect(() => {
    if (reduce || !animate) { if (ref.current) ref.current.textContent = format(value, decimalPlaces); return }
    if (!isInView) return
    const timer = setTimeout(() => motionValue.set(value), delay * 1000)
    return () => clearTimeout(timer)
  }, [motionValue, isInView, delay, value, reduce, animate, decimalPlaces])

  useEffect(() => springValue.on("change", (latest) => { if (ref.current && !reduce && animate) ref.current.textContent = format(latest, decimalPlaces) }), [springValue, decimalPlaces, reduce, animate])

  return (
    <span ref={ref} className={cn("inline-block tabular-nums", className)} {...props}>
      {format(reduce || !animate ? value : startValue, decimalPlaces)}
    </span>
  )
}
