import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const alertVariants = cva("rounded-control border px-4 py-3 text-[14px] leading-[1.5]", {
  variants: {
    tone: {
      danger: "border-danger/50 bg-danger-tint text-danger-ink",
      warn: "border-warn/50 bg-warn-tint text-warn-ink",
      ok: "border-ok/50 bg-ok-tint text-ok-ink",
      info: "border-rule-2 bg-sunken text-ink-2",
    },
  },
  defaultVariants: { tone: "info" },
});

export function Alert({ className, tone, ...props }: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>) {
  return <div role={tone === "danger" || tone === "warn" ? "alert" : "status"} className={cn(alertVariants({ tone }), className)} {...props} />;
}
export function AlertTitle({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("font-semibold", className)} {...props} />;
}
export function AlertBody({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("mt-0.5", className)} {...props} />;
}
